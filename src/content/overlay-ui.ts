import type { ReviewSuggestion, SuggestionPriority, ExtensionSettings } from '../shared/types';
import {
  fetchPRContext,
  postLineComment,
  postMultiLineComment,
  formatSuggestionComment,
  submitReview,
  type PRContext
} from './github-api';
import { sendToBackground } from '../shared/messages';

const PRIORITY_ICONS: Record<SuggestionPriority, string> = {
  high: '\u{1F534}',
  medium: '\u{1F7E1}',
  low: '\u{1F7E2}',
};

let currentSuggestions: ReviewSuggestion[] = [];
let currentIndex = 0;
let prContext: PRContext | null = null;
let pendingCommentsCount = 0; // Track draft comments added to review

export function showToast(message: string, type: 'success' | 'error' = 'success'): void {
  const existing = document.querySelector('.pr-ai-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `pr-ai-toast pr-ai-toast--${type}`;
  toast.textContent = message;

  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('pr-ai-toast--visible'));

  setTimeout(() => {
    toast.classList.remove('pr-ai-toast--visible');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}

/**
 * Post a suggestion as a GitHub comment
 */
async function postSuggestion(suggestion: ReviewSuggestion): Promise<boolean> {
  if (!prContext || !prContext.baseCommitOid || !prContext.headCommitOid) {
    console.log('[PR AI Review] Fetching PR context...');
    prContext = await fetchPRContext();
  }

  if (!prContext || !prContext.baseCommitOid || !prContext.headCommitOid) {
    showToast('Could not get PR context - copy to clipboard instead', 'error');
    const comment = formatSuggestionComment(suggestion.title, suggestion.description, suggestion.suggestedCode);
    await copyToClipboard(comment);
    return false;
  }

  const comment = formatSuggestionComment(suggestion.title, suggestion.description, suggestion.suggestedCode);

  // Determine if this is a multi-line suggestion
  const hasLineRange = suggestion.lineRange && suggestion.lineRange.start !== suggestion.lineRange.end;

  let success: boolean;
  if (hasLineRange && suggestion.lineRange) {
    success = await postMultiLineComment(
      prContext,
      suggestion.filePath,
      suggestion.lineRange.start,
      suggestion.lineRange.end,
      comment
    );
  } else {
    success = await postLineComment(
      prContext,
      suggestion.filePath,
      suggestion.lineNumber,
      comment
    );
  }

  if (success) {
    // Comment stored locally, will be submitted with review
    // Toast is shown by the caller
  } else {
    showToast('Failed to add comment - copied to clipboard', 'error');
    await copyToClipboard(comment);
  }

  return success;
}

export function renderReviewButton(onClick: () => void): HTMLElement {
  const existing = document.querySelector('.pr-ai-review-btn');
  if (existing) existing.remove();

  const button = document.createElement('button');
  button.className = 'pr-ai-review-btn btn btn-sm pr-ai-review-btn--floating';
  button.innerHTML = `
    <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
      <path fill="currentColor" d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215Z"/>
    </svg>
    AI Review
  `;
  button.addEventListener('click', onClick);
  document.body.appendChild(button);

  // Pre-fetch PR context asynchronously
  fetchPRContext().then(ctx => {
    prContext = ctx;
    console.log('[PR AI Review] Pre-fetched PR context:', prContext);
  }).catch(err => {
    console.error('[PR AI Review] Error pre-fetching PR context:', err);
  });

  return button;
}

export function updateReviewButtonState(state: 'idle' | 'loading' | 'error'): void {
  const button = document.querySelector('.pr-ai-review-btn') as HTMLButtonElement;
  if (!button) return;

  button.disabled = state === 'loading';
  button.classList.toggle('pr-ai-review-btn--loading', state === 'loading');
  button.classList.toggle('pr-ai-review-btn--error', state === 'error');

  button.innerHTML = state === 'loading' ? `
    <svg class="pr-ai-spinner" viewBox="0 0 16 16" width="16" height="16">
      <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="30" stroke-linecap="round"/>
    </svg>
    Reviewing...
  ` : `
    <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
      <path fill="currentColor" d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215Z"/>
    </svg>
    AI Review
  `;
}

/**
 * Render suggestions with post functionality and editable preview
 */
export function renderSuggestions(suggestions: ReviewSuggestion[]): void {
  clearSuggestionOverlays();
  if (suggestions.length === 0) {
    showToast('No suggestions - code looks good!');
    return;
  }

  currentSuggestions = suggestions;
  currentIndex = 0;

  // Reset pending comments counter for new review session
  pendingCommentsCount = 0;

  // Create container for nav and preview
  const container = document.createElement('div');
  container.className = 'pr-ai-suggestion-container';

  // Create navigation bar
  const nav = document.createElement('div');
  nav.className = 'pr-ai-suggestion-nav';

  nav.innerHTML = `
    <div class="pr-ai-suggestion-nav__header">
      <div class="pr-ai-suggestion-nav__info">
        <span class="pr-ai-suggestion-nav__count">
          <strong>${suggestions.length}</strong> suggestions
        </span>
        <span class="pr-ai-suggestion-nav__pending" style="display: none; margin-left: 8px; color: #f0883e;">
          (<strong>0</strong> pending)
        </span>
      </div>
      <div class="pr-ai-suggestion-nav__controls">
        <button class="pr-ai-nav-btn" data-action="prev" title="Previous">\u{2190}</button>
        <span class="pr-ai-suggestion-nav__position"></span>
        <button class="pr-ai-nav-btn" data-action="next" title="Next">\u{2192}</button>
        <button class="pr-ai-nav-btn" data-action="toggle-preview" title="Toggle preview">\u{1F441}</button>
        <button class="pr-ai-nav-btn pr-ai-nav-btn--close" data-action="close" title="Close">\u{2715}</button>
      </div>
    </div>
  `;

  // Create preview panel
  const preview = document.createElement('div');
  preview.className = 'pr-ai-suggestion-preview';
  preview.innerHTML = `
    <div class="pr-ai-preview__location">
      <span class="pr-ai-preview__file"></span>
      <span class="pr-ai-preview__line"></span>
      <span class="pr-ai-preview__priority"></span>
      <span class="pr-ai-preview__category"></span>
    </div>
    <div class="pr-ai-preview__field">
      <label class="pr-ai-preview__label">Title</label>
      <input type="text" class="pr-ai-preview__input pr-ai-preview__title" placeholder="Suggestion title...">
    </div>
    <div class="pr-ai-preview__field">
      <label class="pr-ai-preview__label">Description</label>
      <textarea class="pr-ai-preview__textarea pr-ai-preview__description" rows="3" placeholder="Description..."></textarea>
    </div>
    <div class="pr-ai-preview__field pr-ai-preview__code-field">
      <label class="pr-ai-preview__label">Suggested Code <span class="pr-ai-preview__optional">(optional)</span></label>
      <textarea class="pr-ai-preview__textarea pr-ai-preview__code" rows="4" placeholder="Code suggestion..."></textarea>
    </div>
    <div class="pr-ai-preview__actions">
      <button class="pr-ai-nav-btn pr-ai-nav-btn--primary" data-action="post" title="Add as draft comment">\u{1F4AC} Add Draft</button>
      <button class="pr-ai-nav-btn" data-action="skip" title="Skip this suggestion">Skip</button>
      <button class="pr-ai-nav-btn" data-action="post-all" title="Add all remaining as draft comments">\u{1F4E4} Add All</button>
      <button class="pr-ai-nav-btn pr-ai-nav-btn--submit" data-action="submit" title="Save review (as draft by default)" style="display: none; background: #238636;">\u{2714} Save Review</button>
    </div>
  `;

  container.appendChild(nav);
  container.appendChild(preview);

  // Cache DOM references
  const titleInput = preview.querySelector('.pr-ai-preview__title') as HTMLInputElement;
  const descriptionInput = preview.querySelector('.pr-ai-preview__description') as HTMLTextAreaElement;
  const codeInput = preview.querySelector('.pr-ai-preview__code') as HTMLTextAreaElement;
  const fileEl = preview.querySelector('.pr-ai-preview__file')!;
  const lineEl = preview.querySelector('.pr-ai-preview__line')!;
  const priorityEl = preview.querySelector('.pr-ai-preview__priority')!;
  const categoryEl = preview.querySelector('.pr-ai-preview__category')!;
  const codeField = preview.querySelector('.pr-ai-preview__code-field') as HTMLElement;
  const positionEl = nav.querySelector('.pr-ai-suggestion-nav__position')!;

  function saveCurrentEdits() {
    if (currentSuggestions.length === 0) return;
    const s = currentSuggestions[currentIndex];
    s.title = titleInput.value;
    s.description = descriptionInput.value;
    s.suggestedCode = codeInput.value || undefined;
  }

  function updateDisplay() {
    if (currentSuggestions.length === 0) {
      positionEl.textContent = '0/0';
      fileEl.textContent = '';
      lineEl.textContent = '';
      priorityEl.textContent = '';
      categoryEl.textContent = '';
      titleInput.value = '';
      descriptionInput.value = '';
      codeInput.value = '';
      codeField.style.display = 'none';
      preview.querySelector('.pr-ai-preview__actions')!.innerHTML = `
        <button class="pr-ai-nav-btn pr-ai-nav-btn--submit" data-action="submit" title="Save review" style="background: #238636;">\u{2714} Save Review</button>
      `;
      attachSubmitHandler();
      return;
    }

    const s = currentSuggestions[currentIndex];

    // Update position
    positionEl.textContent = `${currentIndex + 1}/${currentSuggestions.length}`;

    // Update location info
    fileEl.textContent = s.filePath;
    lineEl.textContent = s.lineRange
      ? `Lines ${s.lineRange.start}-${s.lineRange.end}`
      : `Line ${s.lineNumber}`;
    priorityEl.innerHTML = `${PRIORITY_ICONS[s.priority]} ${s.priority}`;
    priorityEl.className = `pr-ai-preview__priority pr-ai-preview__priority--${s.priority}`;
    categoryEl.textContent = s.category.replace('_', ' ');

    // Update editable fields
    titleInput.value = s.title;
    descriptionInput.value = s.description;
    codeInput.value = s.suggestedCode || '';

    // Show/hide code field
    codeField.style.display = s.suggestedCode ? 'block' : 'block'; // Always show, user can add code
  }

  function updatePendingDisplay() {
    const pendingEl = nav.querySelector('.pr-ai-suggestion-nav__pending') as HTMLElement;
    const submitBtn = preview.querySelector('[data-action="submit"]') as HTMLElement;

    if (pendingCommentsCount > 0) {
      pendingEl.style.display = 'inline';
      pendingEl.querySelector('strong')!.textContent = String(pendingCommentsCount);
      if (submitBtn) submitBtn.style.display = 'inline-block';
    } else {
      pendingEl.style.display = 'none';
      if (submitBtn && currentSuggestions.length > 0) submitBtn.style.display = 'none';
    }
  }

  function updateCountDisplay() {
    nav.querySelector('.pr-ai-suggestion-nav__count strong')!.textContent = String(currentSuggestions.length);
  }

  function attachSubmitHandler() {
    preview.querySelector('[data-action="submit"]')?.addEventListener('click', handleSubmit);
  }

  async function handleSubmit() {
    const btn = preview.querySelector('[data-action="submit"]') as HTMLButtonElement;
    if (!btn) return;

    btn.disabled = true;
    btn.textContent = 'Submitting...';

    if (!prContext) {
      prContext = await fetchPRContext();
    }

    if (!prContext) {
      showToast('Could not get PR context', 'error');
      btn.disabled = false;
      btn.innerHTML = '\u{2714} Save Review';
      return;
    }

    // Check settings to determine if we should finalize or keep as draft
    let autoFinalize = false;
    try {
      const response = await sendToBackground({ type: 'GET_SETTINGS' });
      if (response.type === 'SETTINGS_RESULT') {
        autoFinalize = (response.payload as ExtensionSettings).autoFinalizeReview || false;
      }
    } catch (e) {
      console.log('[PR AI Review] Could not get settings, defaulting to draft mode');
    }

    const result = await submitReview(
      prContext.owner,
      prContext.repo,
      prContext.prNumber,
      autoFinalize ? 'COMMENT' : undefined,
      undefined,
      prContext.headCommitOid
    );

    if (result.success) {
      if (result.isDraft) {
        showToast(`Draft review created with ${pendingCommentsCount} comments! Submit from GitHub to publish.`);
      } else {
        showToast(`Review submitted with ${pendingCommentsCount} comments!`);
      }
      pendingCommentsCount = 0;
      container.remove();
      window.location.reload();
    } else {
      showToast(`Failed to submit: ${result.error}`, 'error');
      btn.disabled = false;
      btn.innerHTML = '\u{2714} Save Review';
    }
  }

  // Navigation handlers
  nav.querySelector('[data-action="prev"]')?.addEventListener('click', () => {
    if (currentSuggestions.length === 0) return;
    saveCurrentEdits();
    currentIndex = (currentIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
    updateDisplay();
  });

  nav.querySelector('[data-action="next"]')?.addEventListener('click', () => {
    if (currentSuggestions.length === 0) return;
    saveCurrentEdits();
    currentIndex = (currentIndex + 1) % currentSuggestions.length;
    updateDisplay();
  });

  nav.querySelector('[data-action="toggle-preview"]')?.addEventListener('click', () => {
    preview.classList.toggle('pr-ai-suggestion-preview--collapsed');
    const btn = nav.querySelector('[data-action="toggle-preview"]') as HTMLButtonElement;
    btn.innerHTML = preview.classList.contains('pr-ai-suggestion-preview--collapsed') ? '\u{1F441}\u{200D}\u{1F5E8}' : '\u{1F441}';
  });

  nav.querySelector('[data-action="close"]')?.addEventListener('click', () => {
    if (pendingCommentsCount > 0) {
      const confirm = window.confirm(
        `You have ${pendingCommentsCount} unsaved draft comments. ` +
        `Click "Save Review" first to save them to GitHub as a draft. Close and discard?`
      );
      if (!confirm) return;
    }
    container.remove();
  });

  // Preview action handlers
  preview.querySelector('[data-action="skip"]')?.addEventListener('click', () => {
    currentSuggestions.splice(currentIndex, 1);
    if (currentSuggestions.length === 0) {
      showToast('All suggestions processed');
      updateDisplay();
      updateCountDisplay();
      return;
    }
    if (currentIndex >= currentSuggestions.length) {
      currentIndex = 0;
    }
    updateDisplay();
    updateCountDisplay();
  });

  preview.querySelector('[data-action="post"]')?.addEventListener('click', async () => {
    const btn = preview.querySelector('[data-action="post"]') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Adding...';

    // Save edits before posting
    saveCurrentEdits();

    const success = await postSuggestion(currentSuggestions[currentIndex]);

    btn.disabled = false;
    btn.innerHTML = '\u{1F4AC} Add Draft';

    if (success) {
      pendingCommentsCount++;
      updatePendingDisplay();
      showToast(`Draft comment added (${pendingCommentsCount} pending)`);

      currentSuggestions.splice(currentIndex, 1);
      if (currentSuggestions.length === 0) {
        showToast(`All drafts added! Click "Save Review" to publish.`);
        updateDisplay();
        updateCountDisplay();
        return;
      }
      if (currentIndex >= currentSuggestions.length) {
        currentIndex = 0;
      }
      updateDisplay();
      updateCountDisplay();
    }
  });

  preview.querySelector('[data-action="post-all"]')?.addEventListener('click', async () => {
    const btn = preview.querySelector('[data-action="post-all"]') as HTMLButtonElement;
    btn.disabled = true;

    // Save current edits first
    saveCurrentEdits();

    let posted = 0;
    let failed = 0;
    const total = currentSuggestions.length;

    for (const suggestion of [...currentSuggestions]) {
      btn.textContent = `Adding ${posted + failed + 1}/${total}...`;
      const success = await postSuggestion(suggestion);
      if (success) {
        posted++;
        pendingCommentsCount++;
      } else {
        failed++;
      }
      await new Promise(r => setTimeout(r, 300));
    }

    currentSuggestions = [];
    updatePendingDisplay();

    btn.disabled = false;
    btn.innerHTML = '\u{1F4E4} Add All';

    showToast(`Added ${posted} draft comments${failed > 0 ? `, ${failed} failed` : ''}. Click "Save Review" to publish.`);

    updateDisplay();
    updateCountDisplay();
  });

  attachSubmitHandler();

  document.body.appendChild(container);
  updateDisplay();
  updatePendingDisplay();
}

export function clearSuggestionOverlays(): void {
  document.querySelectorAll('.pr-ai-suggestion-container').forEach(el => el.remove());
  document.querySelectorAll('.pr-ai-suggestion-nav').forEach(el => el.remove());
  document.querySelectorAll('.pr-ai-suggestions-panel').forEach(el => el.remove());
}

export function renderReviewSummary(summary: string, assessment: string, suggestionCount: number): void {
  if (suggestionCount === 0) {
    showToast('\u{2705} ' + summary);
  }
}
