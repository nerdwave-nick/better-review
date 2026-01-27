import type { ReviewSuggestion, SuggestionPriority, ExtensionSettings, PRDiff } from '../shared/types';
import { fetchPRContext, postLineComment, postMultiLineComment, formatSuggestionComment, submitReview, type PRContext } from './github-api';
import { sendToBackground } from '../shared/messages';

const PRIORITY_ICONS: Record<SuggestionPriority, string> = {
  high: '\u{1F534}',
  medium: '\u{1F7E1}',
  low: '\u{1F7E2}',
};

// Consolidated UI state
interface UIState {
  suggestions: ReviewSuggestion[];
  currentIndex: number;
  prContext: PRContext | null;
  pendingCount: number;
  diff: PRDiff | null;
  mode: 'idle' | 'streaming' | 'editing';
}

const state: UIState = {
  suggestions: [],
  currentIndex: 0,
  prContext: null,
  pendingCount: 0,
  diff: null,
  mode: 'idle',
};

// Helper functions
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

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getOriginalCode(filePath: string, startLine: number, endLine: number): string | null {
  if (!state.diff) return null;
  const file = state.diff.files.find(f => f.path === filePath);
  if (!file) return null;

  const lines: string[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.newLineNumber !== null && line.newLineNumber >= startLine && line.newLineNumber <= endLine) {
        lines.push(line.content);
      }
    }
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
}

async function postSuggestion(suggestion: ReviewSuggestion): Promise<boolean> {
  if (!state.prContext?.headCommitOid) {
    state.prContext = await fetchPRContext();
  }

  if (!state.prContext?.headCommitOid) {
    showToast('Could not get PR context - copied to clipboard', 'error');
    await copyToClipboard(formatSuggestionComment(suggestion.description, suggestion.suggestedCode));
    return false;
  }

  const comment = formatSuggestionComment(suggestion.description, suggestion.suggestedCode);
  const hasLineRange = suggestion.lineRange && suggestion.lineRange.start !== suggestion.lineRange.end;

  const success = hasLineRange && suggestion.lineRange
    ? await postMultiLineComment(state.prContext, suggestion.filePath, suggestion.lineRange.start, suggestion.lineRange.end, comment)
    : await postLineComment(state.prContext, suggestion.filePath, suggestion.lineNumber, comment);

  if (!success) {
    showToast('Failed to add comment - copied to clipboard', 'error');
    await copyToClipboard(comment);
  }
  return success;
}

// UI Components
export function renderReviewButton(onClick: () => void): HTMLElement {
  document.querySelector('.pr-ai-review-btn')?.remove();

  const button = document.createElement('button');
  button.className = 'pr-ai-review-btn btn btn-sm pr-ai-review-btn--floating';
  button.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
    AI Review
  `;
  button.addEventListener('click', onClick);
  document.body.appendChild(button);

  // Pre-fetch PR context
  fetchPRContext().then(ctx => { state.prContext = ctx; }).catch(() => {});
  return button;
}

export function updateReviewButtonState(buttonState: 'idle' | 'loading' | 'error'): void {
  const button = document.querySelector('.pr-ai-review-btn') as HTMLButtonElement;
  if (!button) return;

  button.disabled = buttonState === 'loading';
  button.classList.toggle('pr-ai-review-btn--loading', buttonState === 'loading');
  button.classList.toggle('pr-ai-review-btn--error', buttonState === 'error');

  button.innerHTML = buttonState === 'loading'
    ? `<svg class="pr-ai-spinner" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="50" stroke-linecap="round"/></svg> Reviewing...`
    : `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> AI Review`;
}

export function clearSuggestionOverlays(): void {
  document.querySelectorAll('.pr-ai-suggestion-container, .pr-ai-suggestion-nav, .pr-ai-suggestions-panel').forEach(el => el.remove());
}

export function renderReviewSummary(summary: string, _assessment: string, suggestionCount: number): void {
  if (suggestionCount === 0) showToast('\u{2705} ' + summary);
}

export function showStreamingSummary(summary: string, keyChanges: string[], potentialConcerns?: string[]): void {
  const container = document.querySelector('.pr-ai-suggestion-container');
  if (!container) return;

  // Remove any existing streaming summary
  container.querySelector('.pr-ai-streaming-summary')?.remove();

  const summaryEl = document.createElement('div');
  summaryEl.className = 'pr-ai-streaming-summary';
  summaryEl.innerHTML = `
    <div class="pr-ai-streaming-summary__header">
      <span class="pr-ai-streaming-summary__icon">\u{1F4DD}</span>
      <span class="pr-ai-streaming-summary__title">PR Summary</span>
    </div>
    <div class="pr-ai-streaming-summary__content">
      <div class="pr-ai-streaming-summary__text">${escapeHtml(summary)}</div>
      ${keyChanges.length > 0 ? `
        <div class="pr-ai-streaming-summary__changes">
          <strong>Key changes:</strong>
          <ul>${keyChanges.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
        </div>
      ` : ''}
      ${potentialConcerns && potentialConcerns.length > 0 ? `
        <div class="pr-ai-streaming-summary__concerns">
          <strong>\u{26A0}\uFE0F Areas to watch:</strong>
          <ul>${potentialConcerns.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
        </div>
      ` : ''}
    </div>
  `;

  // Insert after the nav but before the preview
  const nav = container.querySelector('.pr-ai-suggestion-nav');
  if (nav) {
    nav.after(summaryEl);
  }
}

function collapseStreamingSummary(): void {
  const summaryEl = document.querySelector('.pr-ai-streaming-summary');
  if (!summaryEl) return;

  // Add collapsed class for animation
  summaryEl.classList.add('pr-ai-streaming-summary--collapsed');

  // Update the header to show it's complete
  const header = summaryEl.querySelector('.pr-ai-streaming-summary__header');
  if (header) {
    header.innerHTML = `
      <span class="pr-ai-streaming-summary__icon">\u{2705}</span>
      <span class="pr-ai-streaming-summary__title">Summary</span>
      <button class="pr-ai-streaming-summary__toggle" title="Expand summary">\u{25BC}</button>
    `;

    // Add toggle functionality
    const toggleBtn = header.querySelector('.pr-ai-streaming-summary__toggle') as HTMLButtonElement | null;
    toggleBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      summaryEl.classList.toggle('pr-ai-streaming-summary--collapsed');
      if (toggleBtn) {
        toggleBtn.textContent = summaryEl.classList.contains('pr-ai-streaming-summary--collapsed') ? '\u{25BC}' : '\u{25B2}';
        toggleBtn.title = summaryEl.classList.contains('pr-ai-streaming-summary--collapsed') ? 'Expand summary' : 'Collapse summary';
      }
    });
  }
}

export function initializeSuggestions(diff: PRDiff | null, streaming = false): void {
  clearSuggestionOverlays();
  Object.assign(state, { diff, mode: streaming ? 'streaming' : 'idle', suggestions: [], currentIndex: 0, pendingCount: 0 });
  createUI();
  updateDisplay();
}

export function appendSuggestion(suggestion: ReviewSuggestion): void {
  state.suggestions.push(suggestion);
  if (state.suggestions.length === 1) {
    // Collapse the streaming summary when first suggestion arrives
    collapseStreamingSummary();
    updateDisplay();
  }
  updateCountDisplay();
}

export function finalizeSuggestions(): void {
  state.mode = 'idle';
  updateDisplay();
  updateStreamingIndicator();
}

export function renderSuggestions(suggestions: ReviewSuggestion[], diff: PRDiff | null = null): void {
  initializeSuggestions(diff, false);
  state.suggestions = suggestions;
  if (suggestions.length === 0) showToast('No suggestions - code looks good!');
  updateDisplay();
}

function createUI(): void {
  const container = document.createElement('div');
  container.className = 'pr-ai-suggestion-container';
  container.innerHTML = `
    <div class="pr-ai-suggestion-nav">
      <div class="pr-ai-suggestion-nav__header">
        <div class="pr-ai-suggestion-nav__info">
          <span class="pr-ai-suggestion-nav__count"><strong>0</strong> suggestions</span>
          <span class="pr-ai-suggestion-nav__streaming" style="display:none;margin-left:8px;color:var(--pr-ai-primary)">
            <svg class="pr-ai-spinner" viewBox="0 0 16 16" width="12" height="12" style="vertical-align:middle;margin-right:4px"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="30" stroke-linecap="round"/></svg>
            <span>analyzing...</span>
          </span>
          <span class="pr-ai-suggestion-nav__pending" style="display:none;margin-left:8px;color:#f0883e">(<strong>0</strong> pending)</span>
        </div>
        <div class="pr-ai-suggestion-nav__controls">
          <button class="pr-ai-nav-btn" data-action="prev" title="Previous">\u2190</button>
          <span class="pr-ai-suggestion-nav__position"></span>
          <button class="pr-ai-nav-btn" data-action="next" title="Next">\u2192</button>
          <button class="pr-ai-nav-btn" data-action="toggle" title="Minimize">\u25B2</button>
          <button class="pr-ai-nav-btn pr-ai-nav-btn--close" data-action="close" title="Close">\u2715</button>
        </div>
      </div>
    </div>
    <div class="pr-ai-suggestion-preview">
      <div class="pr-ai-preview__location">
        <span class="pr-ai-preview__file"></span>
        <span class="pr-ai-preview__line"></span>
        <span class="pr-ai-preview__priority"></span>
        <span class="pr-ai-preview__category"></span>
      </div>
      <div class="pr-ai-preview__field">
        <textarea class="pr-ai-preview__textarea pr-ai-preview__description" rows="4" placeholder="Review comment..."></textarea>
      </div>
      <div class="pr-ai-preview__field pr-ai-preview__code-field">
        <label class="pr-ai-preview__label">Suggested Code <span class="pr-ai-preview__optional">(optional)</span></label>
        <div class="pr-ai-preview__diff-container"></div>
      </div>
      <div class="pr-ai-preview__actions">
        <button class="pr-ai-nav-btn pr-ai-nav-btn--primary" data-action="post">\u{1F4DD} Add Draft</button>
        <button class="pr-ai-nav-btn" data-action="skip">Skip</button>
        <button class="pr-ai-nav-btn" data-action="post-all">\u{1F4E4} Add All</button>
        <button class="pr-ai-nav-btn pr-ai-nav-btn--submit" data-action="submit" style="display:none;background:#238636">\u2713 Save Review</button>
      </div>
      <div class="pr-ai-preview__loading" style="display:none;text-align:center;padding:20px;color:var(--pr-ai-text-secondary)">
        <svg class="pr-ai-spinner" viewBox="0 0 16 16" width="24" height="24" style="margin-bottom:8px"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="30" stroke-linecap="round"/></svg>
        <div>Analyzing code...</div>
      </div>
    </div>
  `;

  setupEventListeners(container);
  document.body.appendChild(container);
}

function updateDisplay(): void {
  const container = document.querySelector('.pr-ai-suggestion-container');
  if (!container) return;

  const preview = container.querySelector('.pr-ai-suggestion-preview') as HTMLElement;
  const loadingEl = preview.querySelector('.pr-ai-preview__loading') as HTMLElement;
  const actionsEl = preview.querySelector('.pr-ai-preview__actions') as HTMLElement;
  const fields = preview.querySelectorAll('.pr-ai-preview__field, .pr-ai-preview__location') as NodeListOf<HTMLElement>;
  const positionEl = container.querySelector('.pr-ai-suggestion-nav__position')!;

  updateStreamingIndicator();

  if (state.suggestions.length === 0) {
    if (state.mode === 'streaming') {
      loadingEl.style.display = 'block';
      actionsEl.style.display = 'none';
      fields.forEach(el => el.style.display = 'none');
      positionEl.textContent = '-/-';
    } else {
      loadingEl.style.display = 'none';
      fields.forEach(el => el.style.display = 'none');
      positionEl.textContent = '0/0';

      if (state.pendingCount > 0) {
        actionsEl.style.display = 'flex';
        actionsEl.innerHTML = `<div style="width:100%;text-align:center;padding:12px 0">
          <div style="color:var(--pr-ai-text);margin-bottom:12px">All reviewed! ${state.pendingCount} draft comment${state.pendingCount !== 1 ? 's' : ''} ready.</div>
          <button class="pr-ai-nav-btn pr-ai-nav-btn--submit" data-action="submit" style="background:#238636">\u2713 Save Review</button>
        </div>`;
        container.querySelector('[data-action="submit"]')?.addEventListener('click', handleSubmit);
      } else {
        actionsEl.innerHTML = `<div style="width:100%;text-align:center;color:var(--pr-ai-text);padding:12px 0">\u2713 Code looks good!</div>`;
      }
    }
    return;
  }

  loadingEl.style.display = 'none';
  actionsEl.style.display = 'flex';
  fields.forEach(el => el.style.display = 'flex');

  const s = state.suggestions[state.currentIndex];
  positionEl.textContent = `${state.currentIndex + 1}/${state.suggestions.length}`;

  // Update location info
  (preview.querySelector('.pr-ai-preview__file') as HTMLElement).textContent = s.filePath;
  (preview.querySelector('.pr-ai-preview__line') as HTMLElement).textContent = s.lineRange ? `Lines ${s.lineRange.start}-${s.lineRange.end}` : `Line ${s.lineNumber}`;

  const priorityEl = preview.querySelector('.pr-ai-preview__priority') as HTMLElement;
  priorityEl.innerHTML = `${PRIORITY_ICONS[s.priority]} ${s.priority}`;
  priorityEl.className = `pr-ai-preview__priority pr-ai-preview__priority--${s.priority}`;

  (preview.querySelector('.pr-ai-preview__category') as HTMLElement).textContent = s.category.replace('_', ' ');
  (preview.querySelector('.pr-ai-preview__description') as HTMLTextAreaElement).value = s.description;

  // Update code diff/editor
  const diffContainer = preview.querySelector('.pr-ai-preview__diff-container') as HTMLElement;
  const codeField = preview.querySelector('.pr-ai-preview__code-field') as HTMLElement;
  diffContainer.innerHTML = '';

  if (state.mode === 'editing') {
    renderCodeEditor(diffContainer, s);
  } else if (s.suggestedCode) {
    codeField.style.display = 'block';
    const start = s.lineRange?.start ?? s.lineNumber;
    const end = s.lineRange?.end ?? s.lineNumber;
    const original = getOriginalCode(s.filePath, start, end);

    if (original) {
      renderDiffView(diffContainer, original, s.suggestedCode);
    } else {
      renderEditButton(diffContainer, 'Original not found. Edit directly.');
    }
  } else {
    codeField.style.display = 'block';
    renderEditButton(diffContainer, '+ Add Code Suggestion');
  }
}

function renderDiffView(container: HTMLElement, original: string, suggested: string): void {
  container.innerHTML = `
    <div class="pr-ai-diff-view">
      <div class="pr-ai-diff-block pr-ai-diff-original">
        <div class="pr-ai-diff-header">Original</div>
        <pre>${escapeHtml(original)}</pre>
      </div>
      <div class="pr-ai-diff-block pr-ai-diff-suggested">
        <div class="pr-ai-diff-header" style="display:flex;justify-content:space-between;align-items:center">
          <span>Suggested</span>
          <button class="pr-ai-btn pr-ai-btn--small pr-ai-diff-edit-btn" style="padding:2px 8px;font-size:10px">\u270E Edit</button>
        </div>
        <pre>${escapeHtml(suggested)}</pre>
      </div>
    </div>
  `;
  container.querySelector('.pr-ai-diff-edit-btn')?.addEventListener('click', () => {
    state.mode = 'editing';
    updateDisplay();
  });
}

function renderCodeEditor(container: HTMLElement, suggestion: ReviewSuggestion): void {
  container.innerHTML = `
    <div class="pr-ai-editor-wrapper" style="border:1px solid var(--pr-ai-border);border-radius:6px;overflow:hidden;margin-bottom:12px">
      <textarea class="pr-ai-code-textarea" style="width:100%;min-height:150px;padding:12px;font-family:monospace;font-size:12px;border:none;resize:vertical;background:var(--pr-ai-bg);color:var(--pr-ai-text)">${escapeHtml(suggestion.suggestedCode || '')}</textarea>
      <div style="padding:8px 12px;background:var(--pr-ai-bg-secondary);border-top:1px solid var(--pr-ai-border);display:flex;gap:8px;justify-content:flex-end">
        <button class="pr-ai-btn pr-ai-btn--secondary pr-ai-btn--small" data-editor="cancel">Cancel</button>
        <button class="pr-ai-btn pr-ai-btn--primary pr-ai-btn--small" data-editor="save">Save</button>
      </div>
    </div>
  `;

  const textarea = container.querySelector('.pr-ai-code-textarea') as HTMLTextAreaElement;
  container.querySelector('[data-editor="cancel"]')?.addEventListener('click', () => {
    state.mode = 'idle';
    updateDisplay();
  });
  container.querySelector('[data-editor="save"]')?.addEventListener('click', () => {
    suggestion.suggestedCode = textarea.value;
    state.mode = 'idle';
    updateDisplay();
  });
}

function renderEditButton(container: HTMLElement, text: string): void {
  const btn = document.createElement('button');
  btn.className = 'pr-ai-btn pr-ai-btn--secondary pr-ai-btn--small';
  btn.textContent = text;
  btn.onclick = () => { state.mode = 'editing'; updateDisplay(); };
  container.appendChild(btn);
}

function updateCountDisplay(): void {
  const nav = document.querySelector('.pr-ai-suggestion-nav');
  if (!nav) return;

  nav.querySelector('.pr-ai-suggestion-nav__count strong')!.textContent = String(state.suggestions.length);
  const positionEl = nav.querySelector('.pr-ai-suggestion-nav__position');
  if (positionEl && state.suggestions.length > 0) {
    positionEl.textContent = `${state.currentIndex + 1}/${state.suggestions.length}`;
  }
}

function updateStreamingIndicator(): void {
  const streamingEl = document.querySelector('.pr-ai-suggestion-nav__streaming') as HTMLElement;
  if (streamingEl) streamingEl.style.display = state.mode === 'streaming' ? 'inline-flex' : 'none';
}

function updatePendingDisplay(): void {
  const pendingEl = document.querySelector('.pr-ai-suggestion-nav__pending') as HTMLElement;
  const submitBtn = document.querySelector('[data-action="submit"]') as HTMLElement;

  if (state.pendingCount > 0) {
    if (pendingEl) {
      pendingEl.style.display = 'inline';
      pendingEl.querySelector('strong')!.textContent = String(state.pendingCount);
    }
    if (submitBtn) submitBtn.style.display = 'inline-block';
  } else {
    if (pendingEl) pendingEl.style.display = 'none';
    if (submitBtn && state.suggestions.length > 0) submitBtn.style.display = 'none';
  }
}

function saveCurrentEdits(): void {
  if (state.suggestions.length === 0) return;
  const textarea = document.querySelector('.pr-ai-preview__description') as HTMLTextAreaElement;
  if (textarea) state.suggestions[state.currentIndex].description = textarea.value;
}

async function handleSubmit(): Promise<void> {
  const btn = document.querySelector('[data-action="submit"]') as HTMLButtonElement;
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = 'Submitting...';

  if (!state.prContext) state.prContext = await fetchPRContext();
  if (!state.prContext) {
    showToast('Could not get PR context', 'error');
    btn.disabled = false;
    btn.innerHTML = '\u2714 Save Review';
    return;
  }

  let autoFinalize = false;
  try {
    const response = await sendToBackground({ type: 'GET_SETTINGS' });
    if (response.type === 'SETTINGS_RESULT') {
      autoFinalize = (response.payload as ExtensionSettings).autoFinalizeReview || false;
    }
  } catch { /* use default */ }

  const result = await submitReview(
    state.prContext.owner,
    state.prContext.repo,
    state.prContext.prNumber,
    autoFinalize ? 'COMMENT' : undefined,
    undefined,
    state.prContext.headCommitOid
  );

  if (result.success) {
    showToast(result.isDraft
      ? `Draft review created with ${state.pendingCount} comments!`
      : `Review submitted with ${state.pendingCount} comments!`);
    state.pendingCount = 0;
    document.querySelector('.pr-ai-suggestion-container')?.remove();
    window.location.reload();
  } else {
    showToast(`Failed: ${result.error}`, 'error');
    btn.disabled = false;
    btn.innerHTML = '\u2714 Save Review';
  }
}

/**
 * Render the PR description generation button next to the Create PR button
 */
export function renderPRDescriptionButton(onClick: () => void): HTMLElement | null {
  // Remove existing button if any
  document.querySelector('.pr-ai-description-btn')?.remove();

  // Find the target location - look for "Create pull request" button or edit form
  const targetSelectors = [
    // New PR creation form - primary button container
    '.js-pull-request-form .BtnGroup',
    '.js-pull-request-form .form-actions',
    // Newer GitHub UI
    '[data-testid="create-pr-footer"]',
    // Edit PR description - look for the comment form actions
    '.js-previewable-comment-form .form-actions',
    // Generic form actions
    '.comment-form-actions',
  ];

  let targetContainer: Element | null = null;
  for (const selector of targetSelectors) {
    targetContainer = document.querySelector(selector);
    if (targetContainer) break;
  }

  // Also check if we have a PR description textarea visible
  const textarea = document.querySelector(
    'textarea[name="pull_request[body]"], textarea#pull_request_body, textarea[name="issue[body]"], textarea#issue_body'
  );

  if (!textarea && !targetContainer) {
    return null;
  }

  const button = document.createElement('button');
  button.className = 'pr-ai-description-btn btn btn-sm';
  button.type = 'button';
  button.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
    AI Description
  `;
  button.title = 'Generate PR description using AI';
  button.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
  });

  // Try to insert the button in the best location
  if (targetContainer) {
    // Insert at the beginning of the button group
    const firstButton = targetContainer.querySelector('button, .btn');
    if (firstButton) {
      firstButton.parentNode?.insertBefore(button, firstButton);
    } else {
      targetContainer.insertBefore(button, targetContainer.firstChild);
    }
  } else if (textarea) {
    // Fallback: create a floating button near the textarea
    button.classList.add('pr-ai-description-btn--floating');
    document.body.appendChild(button);
  }

  return button;
}

/**
 * Update the state of the PR description button
 */
export function updatePRDescriptionButtonState(buttonState: 'idle' | 'loading' | 'error'): void {
  const button = document.querySelector('.pr-ai-description-btn') as HTMLButtonElement;
  if (!button) return;

  button.disabled = buttonState === 'loading';
  button.classList.toggle('pr-ai-description-btn--loading', buttonState === 'loading');
  button.classList.toggle('pr-ai-description-btn--error', buttonState === 'error');

  if (buttonState === 'loading') {
    button.innerHTML = `
      <svg class="pr-ai-spinner" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10" stroke-dasharray="50" stroke-linecap="round"/>
      </svg>
      Generating...
    `;
  } else {
    button.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
      </svg>
      AI Description
    `;
  }
}

function setupEventListeners(container: HTMLElement): void {
  // Navigation
  container.querySelector('[data-action="prev"]')?.addEventListener('click', () => {
    if (state.suggestions.length === 0) return;
    saveCurrentEdits();
    state.currentIndex = (state.currentIndex - 1 + state.suggestions.length) % state.suggestions.length;
    state.mode = 'idle';
    updateDisplay();
  });

  container.querySelector('[data-action="next"]')?.addEventListener('click', () => {
    if (state.suggestions.length === 0) return;
    saveCurrentEdits();
    state.currentIndex = (state.currentIndex + 1) % state.suggestions.length;
    state.mode = 'idle';
    updateDisplay();
  });

  container.querySelector('[data-action="toggle"]')?.addEventListener('click', () => {
    const preview = container.querySelector('.pr-ai-suggestion-preview');
    const btn = container.querySelector('[data-action="toggle"]') as HTMLButtonElement;
    preview?.classList.toggle('pr-ai-suggestion-preview--collapsed');
    btn.textContent = preview?.classList.contains('pr-ai-suggestion-preview--collapsed') ? '\u25BC' : '\u25B2';
  });

  container.querySelector('[data-action="close"]')?.addEventListener('click', () => {
    if (state.pendingCount > 0 && !confirm(`${state.pendingCount} unsaved drafts. Discard?`)) return;
    container.remove();
  });

  // Actions
  container.querySelector('[data-action="skip"]')?.addEventListener('click', () => {
    state.suggestions.splice(state.currentIndex, 1);
    if (state.suggestions.length === 0) {
      showToast('All suggestions processed');
    } else if (state.currentIndex >= state.suggestions.length) {
      state.currentIndex = 0;
    }
    state.mode = 'idle';
    updateDisplay();
    updateCountDisplay();
  });

  container.querySelector('[data-action="post"]')?.addEventListener('click', async () => {
    const btn = container.querySelector('[data-action="post"]') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Adding...';
    saveCurrentEdits();

    if (await postSuggestion(state.suggestions[state.currentIndex])) {
      state.pendingCount++;
      updatePendingDisplay();
      showToast(`Draft added (${state.pendingCount} pending)`);
      state.suggestions.splice(state.currentIndex, 1);

      if (state.suggestions.length === 0) {
        showToast('All drafts added! Click "Save Review" to publish.');
      } else if (state.currentIndex >= state.suggestions.length) {
        state.currentIndex = 0;
      }
      state.mode = 'idle';
      updateDisplay();
      updateCountDisplay();
    }

    btn.disabled = false;
    btn.innerHTML = '\u{1F4DD} Add Draft';
  });

  container.querySelector('[data-action="post-all"]')?.addEventListener('click', async () => {
    const btn = container.querySelector('[data-action="post-all"]') as HTMLButtonElement;
    btn.disabled = true;
    saveCurrentEdits();

    let posted = 0;
    const total = state.suggestions.length;

    for (const suggestion of [...state.suggestions]) {
      btn.textContent = `Adding ${posted + 1}/${total}...`;
      if (await postSuggestion(suggestion)) {
        posted++;
        state.pendingCount++;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    state.suggestions = [];
    updatePendingDisplay();
    btn.disabled = false;
    btn.innerHTML = '\u{1F4E4} Add All';
    showToast(`Added ${posted} drafts. Click "Save Review" to publish.`);
    updateDisplay();
    updateCountDisplay();
  });

  container.querySelector('[data-action="submit"]')?.addEventListener('click', handleSubmit);
}
