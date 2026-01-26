import type { ReviewSuggestion, SuggestionPriority, ExtensionSettings, PRDiff } from '../shared/types';
import {
  fetchPRContext,
  postLineComment,
  postMultiLineComment,
  formatSuggestionComment,
  submitReview,
  type PRContext
} from './github-api';
import { sendToBackground } from '../shared/messages';
import { EditorView, basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";

const PRIORITY_ICONS: Record<SuggestionPriority, string> = {
  high: '\u{1F534}',
  medium: '\u{1F7E1}',
  low: '\u{1F7E2}',
};

let currentSuggestions: ReviewSuggestion[] = [];
let currentIndex = 0;
let prContext: PRContext | null = null;
let pendingCommentsCount = 0; // Track draft comments added to review
let currentDiff: PRDiff | null = null;
let isEditingCode = false;
let isStreaming = false;

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
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getOriginalCode(filePath: string, startLine: number, endLine: number): string | null {
  if (!currentDiff) return null;

  const file = currentDiff.files.find(f => f.path === filePath);
  if (!file) return null;

  const lines: string[] = [];
  
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.newLineNumber !== null && line.newLineNumber >= startLine && line.newLineNumber <= endLine) {
         lines.push(line.content);
      }
    }
  }

  if (lines.length === 0) return null;
  return lines.join('\n');
}

function createDiffView(original: string, suggested: string, onEdit: () => void): HTMLElement {
  const container = document.createElement('div');
  container.className = 'pr-ai-diff-view';

  const originalBlock = document.createElement('div');
  originalBlock.className = 'pr-ai-diff-block pr-ai-diff-original';
  originalBlock.innerHTML = `<div class="pr-ai-diff-header">Original</div><pre>${escapeHtml(original)}</pre>`;

  const suggestedBlock = document.createElement('div');
  suggestedBlock.className = 'pr-ai-diff-block pr-ai-diff-suggested';
  
  const header = document.createElement('div');
  header.className = 'pr-ai-diff-header';
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';
  
  const title = document.createElement('span');
  title.textContent = 'Suggested';
  
  const editBtn = document.createElement('button');
  editBtn.className = 'pr-ai-btn pr-ai-btn--small pr-ai-diff-edit-btn';
  editBtn.innerHTML = '\u{270E} Edit';
  editBtn.style.padding = '2px 8px';
  editBtn.style.fontSize = '10px';
  editBtn.onclick = onEdit;

  header.appendChild(title);
  header.appendChild(editBtn);

  const pre = document.createElement('pre');
  pre.innerHTML = escapeHtml(suggested);

  suggestedBlock.appendChild(header);
  suggestedBlock.appendChild(pre);

  container.appendChild(originalBlock);
  container.appendChild(suggestedBlock);
  return container;
}

function mountEditor(
  container: HTMLElement, 
  initialCode: string, 
  onSave: (newCode: string) => void, 
  onCancel: () => void
): void {
  container.innerHTML = '';
  
  const wrapper = document.createElement('div');
  wrapper.className = 'pr-ai-editor-wrapper';
  wrapper.style.border = '1px solid var(--pr-ai-border)';
  wrapper.style.borderRadius = '6px';
  wrapper.style.overflow = 'hidden';
  wrapper.style.marginBottom = '12px';

  const editorMount = document.createElement('div');
  editorMount.className = 'pr-ai-editor-mount';
  // Ensure editor has a reasonable height
  editorMount.style.minHeight = '150px';

  const actions = document.createElement('div');
  actions.className = 'pr-ai-editor-actions';
  actions.style.padding = '8px 12px';
  actions.style.background = 'var(--pr-ai-bg-secondary)';
  actions.style.borderTop = '1px solid var(--pr-ai-border)';
  actions.style.display = 'flex';
  actions.style.gap = '8px';
  actions.style.justifyContent = 'flex-end';

  actions.innerHTML = `
    <button class="pr-ai-btn pr-ai-btn--secondary pr-ai-btn--small" id="editor-cancel">Cancel</button>
    <button class="pr-ai-btn pr-ai-btn--primary pr-ai-btn--small" id="editor-save">Save Changes</button>
  `;

  wrapper.appendChild(editorMount);
  wrapper.appendChild(actions);
  container.appendChild(wrapper);

  const view = new EditorView({
    doc: initialCode,
    extensions: [
      basicSetup,
      javascript(),
      EditorView.theme({
        "&": { height: "auto", minHeight: "150px", fontSize: "12px" },
        ".cm-scroller": { overflow: "auto" }
      })
    ],
    parent: editorMount
  });

  actions.querySelector('#editor-cancel')!.addEventListener('click', () => {
    view.destroy();
    onCancel();
  });

  actions.querySelector('#editor-save')!.addEventListener('click', () => {
    const newCode = view.state.doc.toString();
    view.destroy();
    onSave(newCode);
  });
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
    const comment = formatSuggestionComment(suggestion.description, suggestion.suggestedCode);
    await copyToClipboard(comment);
    return false;
  }

  const comment = formatSuggestionComment(suggestion.description, suggestion.suggestedCode);

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

/**
 * Initialize suggestions container for streaming or bulk render
 */
export function initializeSuggestions(diff: PRDiff | null, streaming: boolean = false): void {
  clearSuggestionOverlays();
  currentDiff = diff;
  isEditingCode = false;
  isStreaming = streaming;
  currentSuggestions = [];
  currentIndex = 0;
  pendingCommentsCount = 0;

  createSuggestionsUI();
  updateDisplay();
  updateStreamingIndicator();
}

/**
 * Append a new suggestion (streaming mode)
 */
export function appendSuggestion(suggestion: ReviewSuggestion): void {
  currentSuggestions.push(suggestion);

  // Always update display when we get the first suggestion to hide loading state
  // and show the actual content
  if (currentSuggestions.length === 1) {
    updateDisplay();
  }

  updateCountDisplay();
  updateStreamingIndicator();
}

/**
 * Finalize streaming (remove loading state)
 */
export function finalizeSuggestions(): void {
  isStreaming = false;
  updateDisplay();
  updateStreamingIndicator();
}

/**
 * Render suggestions with post functionality and editable preview
 * (Legacy wrapper for backward compatibility or bulk update)
 */
export function renderSuggestions(suggestions: ReviewSuggestion[], diff: PRDiff | null = null): void {
  initializeSuggestions(diff, false);
  currentSuggestions = suggestions;
  
  if (suggestions.length === 0) {
    showToast('No suggestions - code looks good!');
    // If we have UI created by initialize, remove it or show empty state
    updateDisplay();
    return;
  }

  updateDisplay();
}

function createSuggestionsUI(): void {
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
          <strong>0</strong> suggestions
        </span>
        <span class="pr-ai-suggestion-nav__streaming" style="display: none; margin-left: 8px; color: var(--pr-ai-primary);">
          <svg class="pr-ai-spinner" viewBox="0 0 16 16" width="12" height="12" style="vertical-align: middle; margin-right: 4px;">
            <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="30" stroke-linecap="round"/>
          </svg>
          <span>analyzing...</span>
        </span>
        <span class="pr-ai-suggestion-nav__pending" style="display: none; margin-left: 8px; color: #f0883e;">
          (<strong>0</strong> pending)
        </span>
      </div>
      <div class="pr-ai-suggestion-nav__controls">
        <button class="pr-ai-nav-btn" data-action="prev" title="Previous">←</button>
        <span class="pr-ai-suggestion-nav__position"></span>
        <button class="pr-ai-nav-btn" data-action="next" title="Next">→</button>
        <button class="pr-ai-nav-btn" data-action="toggle-preview" title="Minimize/Maximize">▲</button>
        <button class="pr-ai-nav-btn pr-ai-nav-btn--close" data-action="close" title="Close">✕</button>
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
      <textarea class="pr-ai-preview__textarea pr-ai-preview__description" rows="4" placeholder="Review comment..."></textarea>
    </div>
    <div class="pr-ai-preview__field pr-ai-preview__code-field">
      <label class="pr-ai-preview__label">Suggested Code <span class="pr-ai-preview__optional">(optional)</span></label>
      <div class="pr-ai-preview__diff-container"></div>
    </div>
    <div class="pr-ai-preview__actions">
      <button class="pr-ai-nav-btn pr-ai-nav-btn--primary" data-action="post" title="Add as draft comment">📝 Add Draft</button>
      <button class="pr-ai-nav-btn" data-action="skip" title="Skip this suggestion">Skip</button>
      <button class="pr-ai-nav-btn" data-action="post-all" title="Add all remaining as draft comments">📤 Add All</button>
      <button class="pr-ai-nav-btn pr-ai-nav-btn--submit" data-action="submit" title="Save review (as draft by default)" style="display: none; background: #238636;">✓ Save Review</button>
    </div>
    <div class="pr-ai-preview__loading" style="display: none; text-align: center; padding: 20px; color: var(--pr-ai-text-secondary);">
        <svg class="pr-ai-spinner" viewBox="0 0 16 16" width="24" height="24" style="margin-bottom: 8px;">
            <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="30" stroke-linecap="round"/>
        </svg>
        <div>Analyzing code and generating suggestions...</div>
    </div>
  `;

  container.appendChild(nav);
  container.appendChild(preview);

  // Setup event listeners
  setupEventListeners(container, nav, preview);

  document.body.appendChild(container);
}

function updateDisplay(): void {
  const container = document.querySelector('.pr-ai-suggestion-container');
  if (!container) return; // Should exist if initialized

  const nav = container.querySelector('.pr-ai-suggestion-nav') as HTMLElement;
  const preview = container.querySelector('.pr-ai-suggestion-preview') as HTMLElement;
  
  const loadingEl = preview.querySelector('.pr-ai-preview__loading') as HTMLElement;
  const actionsEl = preview.querySelector('.pr-ai-preview__actions') as HTMLElement;
  const fields = preview.querySelectorAll('.pr-ai-preview__field, .pr-ai-preview__location');

  // Cache DOM references for fields
  const descriptionInput = preview.querySelector('.pr-ai-preview__description') as HTMLTextAreaElement;
  const diffContainer = preview.querySelector('.pr-ai-preview__diff-container') as HTMLElement;
  const fileEl = preview.querySelector('.pr-ai-preview__file')!;
  const lineEl = preview.querySelector('.pr-ai-preview__line')!;
  const priorityEl = preview.querySelector('.pr-ai-preview__priority')!;
  const categoryEl = preview.querySelector('.pr-ai-preview__category')!;
  const codeField = preview.querySelector('.pr-ai-preview__code-field') as HTMLElement;
  const positionEl = nav.querySelector('.pr-ai-suggestion-nav__position')!;

  if (currentSuggestions.length === 0) {
    // Show loading state if streaming, otherwise show empty/finished state
    if (isStreaming) {
        loadingEl.style.display = 'block';
        actionsEl.style.display = 'none';
        fields.forEach(el => (el as HTMLElement).style.display = 'none');
        positionEl.textContent = '-/-';
    } else {
        // No suggestions - either finished reviewing or none found
        loadingEl.style.display = 'none';
        fields.forEach(el => (el as HTMLElement).style.display = 'none');
        positionEl.textContent = '0/0';

        // Show clean finish state
        if (pendingCommentsCount > 0) {
          actionsEl.style.display = 'flex';
          actionsEl.innerHTML = `
            <div style="width: 100%; text-align: center; padding: 12px 0;">
              <div style="color: var(--pr-ai-text); margin-bottom: 12px;">All suggestions reviewed! ${pendingCommentsCount} draft comment${pendingCommentsCount !== 1 ? 's' : ''} ready.</div>
              <button class="pr-ai-nav-btn pr-ai-nav-btn--submit" data-action="submit" style="background: #238636;">✓ Save Review</button>
            </div>
          `;
          attachSubmitHandler(preview);
        } else {
          actionsEl.style.display = 'flex';
          actionsEl.innerHTML = `
            <div style="width: 100%; text-align: center; color: var(--pr-ai-text); padding: 12px 0;">
              ✓ Code looks good! No suggestions found.
            </div>
          `;
        }
    }
    return;
  }

  // We have suggestions, show them
  loadingEl.style.display = 'none';
  actionsEl.style.display = 'flex';
  fields.forEach(el => (el as HTMLElement).style.display = 'flex'); // Restore visibility

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
  descriptionInput.value = s.description;

  // Show/hide code field and update diff
  codeField.style.display = 'block';
  diffContainer.innerHTML = '';
  
  if (isEditingCode) {
    mountEditor(
        diffContainer,
        s.suggestedCode || '',
        (newCode) => {
            s.suggestedCode = newCode;
            isEditingCode = false;
            updateDisplay();
        },
        () => {
            isEditingCode = false;
            updateDisplay();
        }
    );
  } else {
    if (s.suggestedCode) {
        codeField.style.display = 'block';
        const start = s.lineRange ? s.lineRange.start : s.lineNumber;
        const end = s.lineRange ? s.lineRange.end : s.lineNumber;
        const original = getOriginalCode(s.filePath, start, end);
        
        if (original) {
            const diffView = createDiffView(original, s.suggestedCode, () => {
                isEditingCode = true;
                updateDisplay();
            });
            diffContainer.appendChild(diffView);
        } else {
             // Fallback if no original code found
             const addBtn = document.createElement('button');
             addBtn.className = 'pr-ai-btn pr-ai-btn--secondary pr-ai-btn--small';
             addBtn.textContent = 'Original code not found. Edit suggestion directly.';
             addBtn.onclick = () => {
                 isEditingCode = true;
                 updateDisplay();
             };
             diffContainer.appendChild(addBtn);
        }
    } else {
        codeField.style.display = 'block';
        const addBtn = document.createElement('button');
        addBtn.className = 'pr-ai-btn pr-ai-btn--secondary pr-ai-btn--small';
        addBtn.textContent = '+ Add Code Suggestion';
        addBtn.onclick = () => {
            isEditingCode = true;
            updateDisplay();
        };
        diffContainer.appendChild(addBtn);
    }
  }
}

function updateCountDisplay() {
  const nav = document.querySelector('.pr-ai-suggestion-nav');
  if (nav) {
    nav.querySelector('.pr-ai-suggestion-nav__count strong')!.textContent = String(currentSuggestions.length);
    if (currentSuggestions.length > 0) {
      const positionEl = nav.querySelector('.pr-ai-suggestion-nav__position');
      if (positionEl && positionEl.textContent === '-/-') {
        // Update position if it was in placeholder state
        positionEl.textContent = `${currentIndex + 1}/${currentSuggestions.length}`;
      } else if (positionEl) {
        // Also update position when new suggestions arrive (for the total count)
        positionEl.textContent = `${currentIndex + 1}/${currentSuggestions.length}`;
      }
    }
  }
}

function updateStreamingIndicator() {
  const nav = document.querySelector('.pr-ai-suggestion-nav');
  if (!nav) return;

  const streamingEl = nav.querySelector('.pr-ai-suggestion-nav__streaming') as HTMLElement;
  if (streamingEl) {
    streamingEl.style.display = isStreaming ? 'inline-flex' : 'none';
  }
}

function saveCurrentEdits() {
    if (currentSuggestions.length === 0) return;
    const container = document.querySelector('.pr-ai-suggestion-container');
    if (!container) return;

    const descriptionInput = container.querySelector('.pr-ai-preview__description') as HTMLTextAreaElement;

    const s = currentSuggestions[currentIndex];
    s.description = descriptionInput.value;
    // Code is saved via editor callbacks
}

function updatePendingDisplay() {
    const nav = document.querySelector('.pr-ai-suggestion-nav');
    if (!nav) return;
    
    const pendingEl = nav.querySelector('.pr-ai-suggestion-nav__pending') as HTMLElement;
    const submitBtn = document.querySelector('[data-action="submit"]') as HTMLElement;

    if (pendingCommentsCount > 0) {
      pendingEl.style.display = 'inline';
      pendingEl.querySelector('strong')!.textContent = String(pendingCommentsCount);
      if (submitBtn) submitBtn.style.display = 'inline-block';
    } else {
      pendingEl.style.display = 'none';
      if (submitBtn && currentSuggestions.length > 0) submitBtn.style.display = 'none';
    }
}

function attachSubmitHandler(preview: HTMLElement) {
    preview.querySelector('[data-action="submit"]')?.addEventListener('click', handleSubmit);
}

async function handleSubmit() {
    const btn = document.querySelector('[data-action="submit"]') as HTMLButtonElement;
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
      document.querySelector('.pr-ai-suggestion-container')?.remove();
      window.location.reload();
    } else {
      showToast(`Failed to submit: ${result.error}`, 'error');
      btn.disabled = false;
      btn.innerHTML = '\u{2714} Save Review';
    }
}

function setupEventListeners(container: HTMLElement, nav: HTMLElement, preview: HTMLElement) {
  // Navigation handlers
  nav.querySelector('[data-action="prev"]')?.addEventListener('click', () => {
    if (currentSuggestions.length === 0) return;
    saveCurrentEdits();
    currentIndex = (currentIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
    isEditingCode = false; 
    updateDisplay();
  });

  nav.querySelector('[data-action="next"]')?.addEventListener('click', () => {
    if (currentSuggestions.length === 0) return;
    saveCurrentEdits();
    currentIndex = (currentIndex + 1) % currentSuggestions.length;
    isEditingCode = false; 
    updateDisplay();
  });

  nav.querySelector('[data-action="toggle-preview"]')?.addEventListener('click', () => {
    preview.classList.toggle('pr-ai-suggestion-preview--collapsed');
    const btn = nav.querySelector('[data-action="toggle-preview"]') as HTMLButtonElement;
    btn.innerHTML = preview.classList.contains('pr-ai-suggestion-preview--collapsed') ? '▼' : '▲';
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
    isEditingCode = false;
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
    btn.innerHTML = '📝 Add Draft';

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
      isEditingCode = false;
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
    btn.innerHTML = '📤 Add All';

    showToast(`Added ${posted} draft comments${failed > 0 ? `, ${failed} failed` : ''}. Click "Save Review" to publish.`);

    updateDisplay();
    updateCountDisplay();
  });

  attachSubmitHandler(preview);
}
