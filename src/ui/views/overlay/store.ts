import { reactive } from 'vue';
import type { ReviewSuggestion, ConsensusSuggestion, PRDiff, ProviderName, ExtensionSettings } from '../../../shared/types';
import type { StreamPortMessage } from '../../../shared/messages';
import { sendToBackground, DEFAULT_SETTINGS } from '../../../shared/messages';
import { extractPRDiff, extractPRMetadata } from '../../../content/diff-parser';
import { extractCompareFromUrl, isOnFilesChangedView, getFilesChangedUrl } from '../../../shared/utils';
import { TIMEOUTS, LOG_TAGS } from '../../../shared/constants';
import { logger } from '../../../shared/logger';
import { PRContext } from '../../../content/github-api';

const TAG = LOG_TAGS.CONTENT;

interface OverlayState {
  suggestions: (ReviewSuggestion | ConsensusSuggestion)[];
  currentIndex: number;
  prContext: PRContext | null;
  pendingCount: number;
  diff: PRDiff | null;
  mode: 'idle' | 'streaming' | 'editing';
  activeProviders: Set<ProviderName>;
  providerErrors: Map<ProviderName, string>;
  isFinalized: boolean;
  isCodeExpanded: boolean;
  isCodePopoutVisible: boolean;
  isVisible: boolean; // To toggle the entire overlay
  isReviewButtonVisible: boolean;
  reviewButtonState: 'idle' | 'loading' | 'error';
  descriptionButtonState: 'idle' | 'loading' | 'error';
  pendingAutoComment: boolean; // Flag to auto-add comments after review completes
}

export const store = reactive<OverlayState>({
  suggestions: [],
  currentIndex: 0,
  prContext: null,
  pendingCount: 0,
  diff: null,
  mode: 'idle',
  activeProviders: new Set(),
  providerErrors: new Map(),
  isFinalized: false,
  isCodeExpanded: false,
  isCodePopoutVisible: false,
  isVisible: false,
  isReviewButtonVisible: false,
  reviewButtonState: 'idle',
  descriptionButtonState: 'idle',
  pendingAutoComment: false,
});

// Private state not exposed to Vue
let currentPort: chrome.runtime.Port | null = null;
let currentSettings: ExtensionSettings = DEFAULT_SETTINGS;

// Actions (helpers to mutate state from outside)
export const actions = {
  reset() {
    store.suggestions = [];
    store.currentIndex = 0;
    store.pendingCount = 0;
    store.mode = 'idle';
    store.activeProviders = new Set();
    store.providerErrors = new Map();
    store.isFinalized = false;
    store.isCodeExpanded = false;
    store.isCodePopoutVisible = false;
    store.isVisible = false;
  },

  setSuggestions(suggestions: ReviewSuggestion[], diff?: PRDiff) {
    this.reset();
    store.suggestions = suggestions;
    if (diff) store.diff = diff;
    store.isVisible = true;
  },

  appendSuggestion(suggestion: ReviewSuggestion | ConsensusSuggestion) {
    store.suggestions.push(suggestion);
    if (!store.isVisible) store.isVisible = true;
  },

  updateSuggestion(id: string, suggestion: ConsensusSuggestion) {
    const index = store.suggestions.findIndex(s => s.id === id);
    if (index !== -1) {
      store.suggestions[index] = suggestion;
    }
  },

  setReviewButtonState(state: 'idle' | 'loading' | 'error') {
    store.reviewButtonState = state;
    store.isReviewButtonVisible = true;
  },

  setDescriptionButtonState(state: 'idle' | 'loading' | 'error') {
    store.descriptionButtonState = state;
  },

  async loadSettings() {
    try {
      const response = await sendToBackground({ type: 'GET_SETTINGS' });
      if (response.type === 'SETTINGS_RESULT') {
        currentSettings = response.payload;
      }
    } catch (error) {
      logger.warn(TAG, 'Failed to load settings:', error);
    }
  },

  async startReview() {
    if (store.reviewButtonState === 'loading') {
      // Cancel ongoing review
      if (currentPort) {
        currentPort.disconnect();
        currentPort = null;
      }
      store.reviewButtonState = 'idle';
      return;
    }

    // Check if we're on the files changed view, redirect if not
    if (!isOnFilesChangedView()) {
      const filesUrl = getFilesChangedUrl();
      if (filesUrl) {
        // Set flag to auto-start review after navigation
        sessionStorage.setItem('pr-ai-pending-auto-review', 'true');
        window.location.href = filesUrl;
        return;
      }
    }

    // Clear any pending flag since we're starting the review
    sessionStorage.removeItem('pr-ai-pending-auto-review');

    // Start new review
    store.reviewButtonState = 'loading';
    this.reset();

    try {
      // Fetch diff from GitHub API
      const diff = await extractPRDiff();

      if (!diff) {
        throw new Error('Could not fetch diff. Please check you are on a PR page.');
      }

      if (diff.files.length === 0) {
        throw new Error('No files found in the PR diff.');
      }

      store.diff = diff;
      store.mode = 'streaming';
      store.isVisible = true;

      logger.debug(TAG, 'Extracted diff:', {
        files: diff.files.length,
        title: diff.title,
      });

      // Create port for streaming communication
      const port = chrome.runtime.connect({ name: `review-stream-${Date.now()}` });
      currentPort = port;

      let suggestionCount = 0;

      port.onMessage.addListener((msg: StreamPortMessage) => {
        switch (msg.type) {
          case 'SUMMARY':
            // Can be used to show summary, currently we just show toast/suggestions
            break;
          case 'CHUNK':
            suggestionCount++;
            this.appendSuggestion(msg.payload);
            if (suggestionCount === 1) {
              // this.showToast('Found first suggestion, analyzing more...');
            }
            break;
          case 'CONSENSUS_CHUNK':
            suggestionCount++;
            this.appendSuggestion(msg.payload);
            if (suggestionCount === 1) {
              // this.showToast('Found first suggestion, analyzing more...');
            }
            break;
          case 'CHUNK_UPDATE':
            this.updateSuggestion(msg.payload.id, msg.payload.suggestion);
            break;
          case 'PROVIDER_STARTED':
            store.activeProviders.add(msg.payload.provider);
            break;
          case 'PROVIDER_COMPLETED':
            store.activeProviders.delete(msg.payload.provider);
            break;
          case 'PROVIDER_ERROR':
            store.activeProviders.delete(msg.payload.provider);
            store.providerErrors.set(msg.payload.provider, msg.payload.error);
            break;
          case 'END':
            store.reviewButtonState = 'idle';
            store.mode = 'idle';
            store.isFinalized = true;
            currentPort = null;

            // If auto-comment is enabled and we have suggestions, trigger auto-comment
            if (currentSettings.autoComment && suggestionCount > 0) {
              store.pendingAutoComment = true;
            }
            break;
          case 'ERROR':
            store.reviewButtonState = 'error';
            store.mode = 'idle';
            // this.showToast(msg.payload.error, 'error');
            currentPort = null;
            setTimeout(() => {
              store.reviewButtonState = 'idle';
            }, TIMEOUTS.BUTTON_STATE_RESET);
            break;
        }
      });

      port.onDisconnect.addListener(() => {
        if (store.reviewButtonState === 'loading') {
          store.reviewButtonState = 'error';
          store.mode = 'idle';
          // this.showToast('Connection lost', 'error');
          setTimeout(() => {
            store.reviewButtonState = 'idle';
          }, TIMEOUTS.BUTTON_STATE_RESET);
        }
        currentPort = null;
      });

      // Start the review
      port.postMessage({ type: 'START', payload: diff });

    } catch (error) {
      logger.error(TAG, 'Review failed:', error);
      store.reviewButtonState = 'error';
      store.mode = 'idle';
      // this.showToast(error instanceof Error ? error.message : 'Review failed', 'error');
      currentPort = null;

      setTimeout(() => {
        store.reviewButtonState = 'idle';
      }, TIMEOUTS.BUTTON_STATE_RESET);
    }
  },

  async generateDescription() {
    if (store.descriptionButtonState === 'loading') {
      // this.showToast('Already generating description...');
      return;
    }

    // Find the description textarea
    const textarea = this.findPRDescriptionTextarea();
    if (!textarea) {
      // this.showToast('Could not find PR description field', 'error');
      return;
    }

    const compareMetadata = extractCompareFromUrl();
    const prMetadata = extractPRMetadata();

    if (!compareMetadata && !prMetadata) {
      // this.showToast('Not on a PR or compare page', 'error');
      return;
    }

    store.descriptionButtonState = 'loading';

    try {
      // Get the current template (what's already in the textarea)
      const template = textarea.value || '';

      if (compareMetadata) {
        // On compare page - fetch diff from compare URL
        const response = await sendToBackground({
          type: 'GENERATE_PR_DESCRIPTION',
          payload: {
            owner: compareMetadata.owner,
            repo: compareMetadata.repo,
            compareSpec: compareMetadata.compareSpec,
            template,
          },
        });

        if (response.type === 'PR_DESCRIPTION_RESULT') {
          textarea.value = response.payload.description;
          // Trigger input event so GitHub's UI updates
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          // this.showToast('PR description generated!');
        } else if (response.type === 'PR_DESCRIPTION_ERROR') {
          throw new Error(response.payload.error);
        }
      } else if (prMetadata) {
        // On PR page - fetch diff from PR URL
        const diffResponse = await sendToBackground({
          type: 'FETCH_DIFF',
          payload: prMetadata,
        });

        if (diffResponse.type === 'DIFF_ERROR') {
          throw new Error(diffResponse.payload.error);
        }

        if (diffResponse.type === 'DIFF_RESULT') {
          // Check settings explicitly here or rely on currentSettings?
          // Let's rely on currentSettings but refresh if empty?
          // Better to just ensure we have API key in background, background handles it.
          // But here we need to know if we can proceed.

          // Create a temporary compare spec for the generate endpoint
          const response = await sendToBackground({
            type: 'GENERATE_PR_DESCRIPTION',
            payload: {
              owner: prMetadata.owner,
              repo: prMetadata.repo,
              compareSpec: `pull/${prMetadata.prNumber}`, // This won't be used since we pass diff directly in background?
              // Actually background `GENERATE_PR_DESCRIPTION` usually takes compareSpec.
              // If we already have DIFF_RESULT, maybe we should have an endpoint that accepts diff?
              // Looking at the original code, it calls GENERATE_PR_DESCRIPTION again.
              // Let's stick to original logic.
              template,
            },
          });

          if (response.type === 'PR_DESCRIPTION_RESULT') {
            textarea.value = response.payload.description;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            // this.showToast('PR description generated!');
          } else if (response.type === 'PR_DESCRIPTION_ERROR') {
            throw new Error(response.payload.error);
          }
        }
      }
    } catch (error) {
      logger.error(TAG, 'Failed to generate PR description:', error);
      // this.showToast(error instanceof Error ? error.message : 'Failed to generate description', 'error');
    } finally {
      store.descriptionButtonState = 'idle';
    }
  },

  findPRDescriptionTextarea(): HTMLTextAreaElement | null {
    const selectors = [
      'textarea[name="pull_request[body]"]',
      'textarea#pull_request_body',
      'textarea[name="issue[body]"]',
      'textarea#issue_body',
      'textarea.js-comment-field',
      'textarea[data-testid="markdown-editor-input"]',
    ];

    for (const selector of selectors) {
      const textarea = document.querySelector(selector) as HTMLTextAreaElement | null;
      if (textarea) {
        return textarea;
      }
    }

    return null;
  }
};
