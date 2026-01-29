<template>
  <div class="pr-ai-root">
    <!-- Floating Review Button -->
    <button v-if="store.isReviewButtonVisible && !store.isVisible"
      class="pr-ai-review-btn btn btn-sm pr-ai-review-btn--floating" :class="{
        'pr-ai-review-btn--loading': store.reviewButtonState === 'loading',
        'pr-ai-review-btn--error': store.reviewButtonState === 'error'
      }" :disabled="store.reviewButtonState === 'loading'" @click="startReview">
      <span v-if="store.reviewButtonState === 'loading'" class="pr-ai-spinner">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" stroke-dasharray="50" stroke-linecap="round" />
        </svg>
      </span>
      <span v-else v-html="ICONS.SPARKLES"></span>
      {{ store.reviewButtonState === 'loading' ? 'Reviewing...' : 'AI Review' }}
    </button>

    <!-- Suggestion Panel -->
    <div v-if="store.isVisible" class="pr-ai-suggestion-container">
      <div class="pr-ai-card">
        <!-- Header -->
        <div class="pr-ai-header">
          <div class="pr-ai-header__left">
            <span class="pr-ai-header__icon" v-html="ICONS.SPARKLES"></span>
            <span class="pr-ai-header__count"><strong>{{ store.suggestions.length }}</strong> suggestions</span>
          </div>

          <div class="pr-ai-header__right">
            <button class="pr-ai-icon-btn" @click="prevSuggestion" :disabled="store.currentIndex === 0" title="Previous"
              v-html="ICONS.CHEVRON_LEFT"></button>
            <div class="pr-ai-pagination">{{ paginationText }}</div>
            <button class="pr-ai-icon-btn" @click="nextSuggestion"
              :disabled="store.currentIndex >= store.suggestions.length - 1" title="Next"
              v-html="ICONS.CHEVRON_RIGHT"></button>

            <div class="pr-ai-divider"></div>

            <button v-if="currentSuggestion" class="pr-ai-icon-btn" @click="togglePopout" title="Expand (Space)"
              v-html="'<svg viewBox=\'0 0 16 16\' width=\'16\' height=\'16\' fill=\'currentColor\'><path d=\'M5.828 10.172a.5.5 0 0 0-.707 0l-4.096 4.096V11.5a.5.5 0 0 0-1 0v3.975a.5.5 0 0 0 .5.5H4.5a.5.5 0 0 0 0-1H1.732l4.096-4.096a.5.5 0 0 0 0-.707zm4.344-4.344a.5.5 0 0 0 .707 0l4.096-4.096V4.5a.5.5 0 1 0 1 0V.525a.5.5 0 0 0-.5-.5H11.5a.5.5 0 0 0 0 1h2.768l-4.096 4.096a.5.5 0 0 0 0 .707z\'/></svg>'"></button>
            <button class="pr-ai-icon-btn" @click="closePanel" title="Close" v-html="ICONS.X"></button>
          </div>
        </div>

        <!-- Progress Bar -->
        <div class="pr-ai-progress-track">
          <div class="pr-ai-progress-bar" :style="{ width: progressPercent + '%' }"></div>
        </div>

        <!-- Content -->
        <div class="pr-ai-content">
          <!-- Loading State -->
          <div v-if="isLoading" class="pr-ai-loading" style="text-align:center; padding:20px 0;">
            <svg class="pr-ai-spinner" viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2"
              fill="none">
              <circle cx="12" cy="12" r="10" stroke-dasharray="50" stroke-linecap="round" />
            </svg>
            <div style="margin-top:8px; font-size:14px; color:var(--pr-ai-text-muted)">Analyzing changes...</div>
          </div>

          <!-- Suggestion View -->
          <div v-else-if="currentSuggestion" class="pr-ai-suggestion-view">
            <!-- File Info & Badges -->
            <div class="pr-ai-file-row">
              <div class="pr-ai-file-info">
                <span v-html="ICONS.FILE_CODE"></span>
                <span class="pr-ai-file-path">{{ currentSuggestion.filePath }}</span>
                <span class="pr-ai-badge pr-ai-badge--outline pr-ai-line-badge">{{ lineBadgeText }}</span>
              </div>

              <div class="pr-ai-badges-row">
                <span class="pr-ai-badge" :class="severityClass">
                  <span v-html="severityIcon"></span> {{ severityLabel }}
                </span>
                <span class="pr-ai-badge pr-ai-badge--outline pr-ai-category-badge">{{
                  formatCategory(currentSuggestion.category) }}</span>
                <div class="pr-ai-divider" style="height:16px" v-if="providersList.length"></div>
                <div class="pr-ai-sources" v-if="providersList.length">
                  <span v-for="p in providersList" :key="p" class="pr-ai-badge pr-ai-badge--secondary">{{ p }}</span>
                </div>
              </div>
            </div>

            <!-- Suggestion Text -->
            <div style="display:flex; flex-direction:column; gap:8px; margin-top: 10px;">
              <div class="pr-ai-suggestion-box">
                <p class="pr-ai-suggestion-text" v-html="formattedDescription"></p>
              </div>
            </div>

            <!-- Code Suggestion Toggle -->
            <div class="pr-ai-code-section" v-if="currentSuggestion.suggestedCode">
              <button class="pr-ai-code-toggle" @click="store.isCodeExpanded = !store.isCodeExpanded">
                <span style="display:flex; align-items:center; gap:8px;">
                  <span v-html="ICONS.CODE"></span>
                  <span class="pr-ai-code-toggle__label">Code Suggestion</span>
                </span>
                <span class="pr-ai-code-chevron"
                  v-html="store.isCodeExpanded ? ICONS.CHEVRON_UP : ICONS.CHEVRON_DOWN"></span>
              </button>

              <div v-if="store.isCodeExpanded" class="pr-ai-code-comparison">
                <div v-for="(line, i) in originalCodeLines" :key="'del-' + i"
                  class="pr-ai-diff-line pr-ai-diff-line--del">
                  <div class="pr-ai-diff-line-num">-</div>
                  <div class="pr-ai-diff-line-content">{{ line }}</div>
                </div>
                <div v-for="(line, i) in suggestedCodeLines" :key="'add-' + i"
                  class="pr-ai-diff-line pr-ai-diff-line--add">
                  <div class="pr-ai-diff-line-num">+</div>
                  <div class="pr-ai-diff-line-content">{{ line }}</div>
                </div>
              </div>
            </div>


          </div>

          <!-- Empty State (Done) -->
          <div v-else class="pr-ai-empty-state" style="padding: 20px; text-align: center;">
            <div v-if="store.pendingCount > 0">
              <strong>All suggestions reviewed!</strong><br>
              <span style="font-size: 12px; color: var(--gh-text-secondary);">{{ store.pendingCount }} comments pending
                submission.</span>
            </div>
            <div v-else>
              <strong>No suggestions found.</strong><br>
              <span style="font-size: 12px; color: var(--gh-text-secondary);">Your code looks great!</span>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="pr-ai-footer" v-if="!isLoading">
          <div class="pr-ai-actions" v-if="currentSuggestion">
            <button class="pr-ai-btn pr-ai-btn--primary" @click="postCurrent" :disabled="isPosting">
              {{ isPosting ? 'Adding...' : 'Add' }}
            </button>
            <button class="pr-ai-btn pr-ai-btn--secondary" @click="skipCurrent">Skip</button>
            <button class="pr-ai-btn pr-ai-btn--outline" @click="postAll" :disabled="isPostingAll">
              {{ isPostingAll ? 'Adding All...' : 'Add All' }}
            </button>
          </div>

          <!-- Submit Button (when done) -->
          <div class="pr-ai-actions" v-else-if="store.pendingCount > 0" style="width: 100%;">
            <button class="pr-ai-btn pr-ai-btn--primary" style="width: 100%;" @click="handleSubmit"
              :disabled="isSubmitting">
              {{ isSubmitting ? 'Submitting...' : 'Submit Review' }}
            </button>
          </div>

          <div class="pr-ai-shortcuts" v-if="currentSuggestion">
            <span class="pr-ai-kbd">Enter</span>
            <span class="pr-ai-shortcut-text">add</span>
            <span class="pr-ai-shortcut-sep">|</span>
            <span class="pr-ai-kbd">Shift+Enter</span>
            <span class="pr-ai-shortcut-text">add all</span>
            <span class="pr-ai-shortcut-sep">|</span>
            <span class="pr-ai-kbd">Tab</span>
            <span class="pr-ai-shortcut-text">skip</span>
            <span class="pr-ai-shortcut-sep">|</span>
            <span class="pr-ai-kbd">Space</span>
            <span class="pr-ai-shortcut-text">popout</span>
          </div>

          <div class="pr-ai-shortcuts" v-else-if="store.pendingCount > 0" style="margin-top: 8px;">
            <span class="pr-ai-kbd">Cmd+Enter</span>
            <span class="pr-ai-shortcut-text">to submit review</span>
          </div>
        </div>
      </div>

      <!-- Toast (Removed) -->
    </div>

    <!-- Suggestion Popout Modal -->
    <div v-if="store.isCodePopoutVisible && currentSuggestion" class="pr-ai-popout-backdrop" @click="closePopout">
      <div class="pr-ai-popout-modal" @click.stop>
        <div class="pr-ai-popout-header">
          <div class="pr-ai-popout-title">
            <span v-html="ICONS.FILE_CODE"></span>
            <span>{{ currentSuggestion.filePath }}</span>
            <span class="pr-ai-badge pr-ai-badge--outline">{{ lineBadgeText }}</span>
          </div>
          <button class="pr-ai-icon-btn" @click="closePopout" title="Close (Esc)" v-html="ICONS.X"></button>
        </div>

        <div class="pr-ai-popout-content">
          <!-- Badges -->
          <div class="pr-ai-badges-row" style="margin-bottom: 12px;">
            <span class="pr-ai-badge" :class="severityClass">
              <span v-html="severityIcon"></span> {{ severityLabel }}
            </span>
            <span class="pr-ai-badge pr-ai-badge--outline pr-ai-category-badge">{{
              formatCategory(currentSuggestion.category) }}</span>
            <div class="pr-ai-divider" style="height:16px" v-if="providersList.length"></div>
            <div class="pr-ai-sources" v-if="providersList.length">
              <span v-for="p in providersList" :key="p" class="pr-ai-badge pr-ai-badge--secondary">{{ p }}</span>
            </div>
          </div>

          <!-- Diff Context (PR Changes) -->
          <div v-if="diffContextLines.length" class="pr-ai-code-section" style="border-radius: 6px; overflow: hidden; margin-bottom: 16px;">
            <div class="pr-ai-code-toggle" style="cursor: default; border-bottom: 1px solid var(--gh-border-default);">
              <span style="display:flex; align-items:center; gap:8px;">
                <span v-html="ICONS.DIFF"></span>
                <span class="pr-ai-code-toggle__label">PR Changes</span>
              </span>
            </div>
            <div class="pr-ai-code-comparison">
              <div v-for="(line, i) in diffContextLines" :key="'ctx-' + i"
                class="pr-ai-diff-line"
                :class="{
                  'pr-ai-diff-line--add': line.type === 'added',
                  'pr-ai-diff-line--del': line.type === 'removed',
                  'pr-ai-diff-line--highlight': line.type === 'highlight'
                }">
                <div class="pr-ai-diff-line-num">{{ line.type === 'added' ? '+' : line.type === 'removed' ? '-' : line.lineNum }}</div>
                <div class="pr-ai-diff-line-content">{{ line.content }}</div>
              </div>
            </div>
          </div>

          <!-- Suggestion Text -->
          <div style="margin-bottom: 16px;">
            <div class="pr-ai-section-label">Suggestion</div>
            <div class="pr-ai-suggestion-box">
              <p class="pr-ai-suggestion-text" v-html="formattedDescription"></p>
            </div>
          </div>

          <!-- Code Suggestion (Proposed Fix) -->
          <div v-if="currentSuggestion.suggestedCode" class="pr-ai-code-section"
            style="border-radius: 6px; overflow: hidden;">
            <div class="pr-ai-code-toggle" style="cursor: default; border-bottom: 1px solid var(--gh-border-default);">
              <span style="display:flex; align-items:center; gap:8px;">
                <span v-html="ICONS.CODE"></span>
                <span class="pr-ai-code-toggle__label">Proposed Fix</span>
              </span>
            </div>
            <div class="pr-ai-code-comparison">
              <div v-for="(line, i) in originalCodeLines" :key="'del-' + i"
                class="pr-ai-diff-line pr-ai-diff-line--del">
                <div class="pr-ai-diff-line-num">-</div>
                <div class="pr-ai-diff-line-content">{{ line }}</div>
              </div>
              <div v-for="(line, i) in suggestedCodeLines" :key="'add-' + i"
                class="pr-ai-diff-line pr-ai-diff-line--add">
                <div class="pr-ai-diff-line-num">+</div>
                <div class="pr-ai-diff-line-content">{{ line }}</div>
              </div>
            </div>
          </div>
        </div>

        <div class="pr-ai-popout-footer">
          <div class="pr-ai-shortcuts">
            <span class="pr-ai-kbd">Esc</span>
            <span class="pr-ai-shortcut-text">close</span>
            <span class="pr-ai-shortcut-sep">|</span>
            <span class="pr-ai-kbd">Enter</span>
            <span class="pr-ai-shortcut-text">add</span>
            <span class="pr-ai-shortcut-sep">|</span>
            <span class="pr-ai-kbd">Tab</span>
            <span class="pr-ai-shortcut-text">skip</span>
          </div>
          <div style="display: flex; gap: 8px;">
            <button class="pr-ai-btn pr-ai-btn--secondary" @click="skipCurrentAndClosePopout">Skip</button>
            <button class="pr-ai-btn pr-ai-btn--primary" @click="postCurrentAndClosePopout">Add</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { store, actions } from './store';
import { ICONS } from '../../icons';
import { fetchPRContext, postLineComment, postMultiLineComment, formatSuggestionComment, submitReview } from '../../../content/github-api';
import { sendToBackground } from '../../../shared/messages';
import type { ReviewSuggestion, ConsensusSuggestion } from '../../../shared/types';

// State
const isPosting = ref(false);
const isPostingAll = ref(false);
const isSubmitting = ref(false);

// Computed
const isLoading = computed(() => store.mode === 'streaming' && !store.isFinalized);
const currentSuggestion = computed(() => store.suggestions[store.currentIndex]);
const progressPercent = computed(() => {
  if (store.suggestions.length === 0) return 0;
  return ((store.currentIndex + 1) / store.suggestions.length) * 100;
});
const paginationText = computed(() => `${store.currentIndex + 1}/${store.suggestions.length}`);

const lineBadgeText = computed(() => {
  if (!currentSuggestion.value) return '';
  const s = currentSuggestion.value;
  return s.lineRange ? `L${s.lineRange.start}-${s.lineRange.end}` : `L${s.lineNumber}`;
});

const formattedDescription = computed(() => {
  if (!currentSuggestion.value) return '';
  // Basic markdown-ish
  return currentSuggestion.value.description.replace(/`([^`]+)`/g, '<span class="pr-ai-code-inline">$1</span>');
});

const originalCodeLines = computed(() => {
  if (!currentSuggestion.value || !store.diff) return [];
  const s = currentSuggestion.value;
  const start = s.lineRange?.start ?? s.lineNumber;
  const end = s.lineRange?.end ?? s.lineNumber;

  const file = store.diff.files.find(f => f.path === s.filePath);
  if (!file) return ['// File not found'];

  const lines: string[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.newLineNumber !== null && line.newLineNumber >= start && line.newLineNumber <= end) {
        lines.push(line.content);
      }
    }
  }
  return lines.length > 0 ? lines : ['// Original code not available'];
});

const suggestedCodeLines = computed(() => {
  if (!currentSuggestion.value?.suggestedCode) return [];
  return currentSuggestion.value.suggestedCode.split('\n');
});

// Extract diff context lines around the suggestion for the popout
const diffContextLines = computed(() => {
  if (!currentSuggestion.value || !store.diff) return [];
  const s = currentSuggestion.value;
  const targetStart = s.lineRange?.start ?? s.lineNumber;
  const targetEnd = s.lineRange?.end ?? s.lineNumber;
  const contextPadding = 3; // Lines of context before/after

  const file = store.diff.files.find(f => f.path === s.filePath);
  if (!file) return [];

  const result: { type: 'added' | 'removed' | 'context' | 'highlight'; content: string; lineNum: string }[] = [];

  for (const hunk of file.hunks) {
    // Check if this hunk contains or is near our target lines
    const hunkNewEnd = hunk.newStart + hunk.newLines;
    const expandedStart = targetStart - contextPadding;
    const expandedEnd = targetEnd + contextPadding;

    if (hunkNewEnd < expandedStart || hunk.newStart > expandedEnd) {
      continue; // Skip hunks that don't overlap with our range
    }

    for (const line of hunk.lines) {
      const lineNum = line.newLineNumber ?? line.oldLineNumber;
      if (lineNum === null) continue;

      // Include lines within our expanded range
      if (lineNum >= expandedStart && lineNum <= expandedEnd) {
        const isTargetLine = lineNum >= targetStart && lineNum <= targetEnd;
        result.push({
          type: isTargetLine && line.type !== 'context' ? line.type : (isTargetLine ? 'highlight' : line.type),
          content: line.content,
          lineNum: line.type === 'removed'
            ? (line.oldLineNumber?.toString() ?? '')
            : (line.newLineNumber?.toString() ?? '')
        });
      }
    }
  }

  return result;
});

const severityClass = computed(() => {
  if (!currentSuggestion.value) return '';
  switch (currentSuggestion.value.priority) {
    case 'high': return 'pr-ai-badge--high';
    case 'medium': return 'pr-ai-badge--medium';
    case 'low': return 'pr-ai-badge--low';
    default: return '';
  }
});

const severityLabel = computed(() => {
  if (!currentSuggestion.value) return '';
  return currentSuggestion.value.priority.charAt(0).toUpperCase() + currentSuggestion.value.priority.slice(1);
});

const severityIcon = computed(() => {
  if (!currentSuggestion.value) return '';
  return currentSuggestion.value.priority === 'high' ? ICONS.ALERT_CIRCLE : ICONS.INFO;
});

const providersList = computed(() => {
  if (!currentSuggestion.value) return [];
  const s = currentSuggestion.value as ConsensusSuggestion;
  return s.contributingProviders || ['gemini'];
});

// Methods
function formatCategory(cat: string) {
  return cat.replace(/_/g, ' ');
}

// function showToast(msg: string, type: 'success' | 'error' = 'success') {
//   actions.showToast(msg, type);
// }

function startReview() {
  actions.startReview();
}

function openReview() {
  startReview();
}

function closePanel() {
  if (store.pendingCount > 0 && !confirm(`${store.pendingCount} unsaved drafts. Discard?`)) return;
  store.isVisible = false;
}

function prevSuggestion() {
  if (store.currentIndex > 0) {
    store.currentIndex--;
    store.isCodeExpanded = false;
  }
}

function nextSuggestion() {
  if (store.currentIndex < store.suggestions.length - 1) {
    store.currentIndex++;
    store.isCodeExpanded = false;
  }
}

async function postSuggestion(suggestion: ReviewSuggestion): Promise<boolean> {
  if (!store.prContext) {
    store.prContext = await fetchPRContext();
  }
  if (!store.prContext?.headCommitOid) {
    // showToast('Could not get PR context', 'error');
    console.error('Could not get PR context');
    return false;
  }

  const comment = formatSuggestionComment(suggestion.description, suggestion.suggestedCode);
  const hasLineRange = suggestion.lineRange && suggestion.lineRange.start !== suggestion.lineRange.end;

  const success = hasLineRange && suggestion.lineRange
    ? await postMultiLineComment(store.prContext, suggestion.filePath, suggestion.lineRange.start, suggestion.lineRange.end, comment)
    : await postLineComment(store.prContext, suggestion.filePath, suggestion.lineNumber, comment);

  return success;
}

async function postCurrent() {
  if (!currentSuggestion.value) return;
  isPosting.value = true;
  if (await postSuggestion(currentSuggestion.value)) {
    store.pendingCount++;
    // showToast(`Draft added (${store.pendingCount} pending)`);
    removeFromList(store.currentIndex);
  } else {
    // showToast('Failed to add comment', 'error');
    console.error('Failed to add comment');
  }
  isPosting.value = false;
}

async function skipCurrent() {
  removeFromList(store.currentIndex);
  // showToast('Skipped');
}

function removeFromList(index: number) {
  store.suggestions.splice(index, 1);
  if (store.suggestions.length === 0) {
    // showToast('All suggestions processed');
  } else if (store.currentIndex >= store.suggestions.length) {
    store.currentIndex = Math.max(0, store.suggestions.length - 1);
  }
  store.isCodeExpanded = false;
}

async function postAll() {
  isPostingAll.value = true;
  let posted = 0;
  const total = store.suggestions.length;

  // Clone array to avoid index issues while splicing
  const suggestions = [...store.suggestions];

  for (const suggestion of suggestions) {
    if (await postSuggestion(suggestion)) {
      posted++;
      store.pendingCount++;
    }
    // removing from store one by one or all at end?
    // Let's remove them from store as we go to show progress if we bound it to store.suggestions
  }

  store.suggestions = [];
  isPostingAll.value = false;
  // showToast(`Added ${posted} drafts.`);
}

async function handleSubmit() {
  isSubmitting.value = true;
  if (!store.prContext) store.prContext = await fetchPRContext();

  // Check settings for autoFinalize
  let autoFinalize = false;
  try {
    const response = await sendToBackground({ type: 'GET_SETTINGS' });
    if (response.type === 'SETTINGS_RESULT') {
      // @ts-ignore
      autoFinalize = response.payload.autoFinalizeReview || false;
    }
  } catch { }

  const result = await submitReview(
    store.prContext!.owner,
    store.prContext!.repo,
    store.prContext!.prNumber,
    autoFinalize ? 'COMMENT' : undefined,
    undefined,
    store.prContext!.headCommitOid
  );

  if (result.success) {
    // showToast('Review submitted!');
    store.pendingCount = 0;
    store.isVisible = false;
    window.location.reload();
  } else {
    // showToast(`Failed: ${result.error}`, 'error');
    console.error(`Failed: ${result.error}`);
  }
  isSubmitting.value = false;
}



function togglePopout() {
  store.isCodePopoutVisible = !store.isCodePopoutVisible;
}

function closePopout() {
  store.isCodePopoutVisible = false;
}

async function postCurrentAndClosePopout() {
  await postCurrent();
  closePopout();
}

function skipCurrentAndClosePopout() {
  skipCurrent();
  closePopout();
}

// Shortcuts
function handleKeydown(e: KeyboardEvent) {
  // If popout is open, Esc closes it
  if (store.isCodePopoutVisible) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePopout();
      return;
    }
    // Allow other shortcuts (like Enter to post) to work in popout?
    // Yes, but let's handle Enter specifically for popout context if needed
  }

  if (!store.isVisible) return;

  // Submit Review Shortcut (Cmd/Ctrl + Enter) when no suggestion is focused or generally?
  // Usually useful when review is done.
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    if (store.pendingCount > 0 && !currentSuggestion.value) {
      handleSubmit();
    }
    return;
  }

  if (e.key === 'Escape') {
    // If popout was not visible (handled above), close main panel
    // But only if we want Esc to close main panel?
    // User might want to just close code view.
    // Let's keep it simple: Esc closes panel if nothing else is open.
    closePanel(); // Warning: this might be annoying if accidental.
    // Maybe ask confirmation? closePanel already has confirmation check if pending items.
    return;
  }

  if (!currentSuggestion.value) return;

  if (e.key === 'Enter') {
    if (e.shiftKey) {
      // Shift + Enter -> Post All
      e.preventDefault();
      postAll();
    } else if (!e.ctrlKey && !e.metaKey) {
      // Enter -> Post Current
      e.preventDefault();
      if (store.isCodePopoutVisible) {
        postCurrentAndClosePopout();
      } else {
        postCurrent();
      }
    }
  } else if (e.key === 'Tab') {
    e.preventDefault();
    if (store.isCodePopoutVisible) {
      skipCurrentAndClosePopout();
    } else {
      skipCurrent();
    }
  } else if (e.key === ' ') {
    // Space -> Toggle Popout (if not typing in an input - which we don't have here really)
    e.preventDefault();
    togglePopout();
  }
}
onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
});
</script>
