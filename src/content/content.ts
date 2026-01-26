import { extractPRDiff, extractPRMetadata } from './diff-parser';
import {
  renderReviewButton,
  renderSuggestions,
  renderReviewSummary,
  updateReviewButtonState,
  clearSuggestionOverlays,
  showToast,
  initializeSuggestions,
  appendSuggestion,
  finalizeSuggestions
} from './overlay-ui';
import { sendToBackground, DEFAULT_SETTINGS } from '../shared/messages';
import type { BackgroundMessage, StreamPortMessage } from '../shared/messages';
import type { ReviewResponse, ExtensionSettings, PRDiff } from '../shared/types';
import { TIMEOUTS, CSS_CLASSES, LOG_TAGS } from '../shared/constants';
import { logger } from '../shared/logger';

const TAG = LOG_TAGS.CONTENT;

// State
let isReviewing = false;
let currentSettings: ExtensionSettings = DEFAULT_SETTINGS;
let lastReviewResponse: ReviewResponse | null = null;
let currentDiff: PRDiff | null = null;
let currentPort: chrome.runtime.Port | null = null;

/**
 * Initialize the extension on GitHub PR pages
 */
async function init(): Promise<void> {
  // Verify we're on a PR page with diff content
  const metadata = extractPRMetadata();
  if (!metadata) {
    logger.debug(TAG, 'Not on a PR page, skipping initialization');
    return;
  }

  logger.debug(TAG, 'Initializing on PR page:', metadata);

  // Load settings
  await loadSettings();

  // Add the review button to the page
  renderReviewButton(handleReviewClick);

  // Set up message listener for background script responses
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);

  // Auto-review if enabled
  if (currentSettings.autoReviewOnLoad) {
    // Wait for diff content to fully load
    await waitForDiffContent();
    handleReviewClick();
  }

  // Set up mutation observer for SPA navigation
  setupNavigationObserver();
}

/**
 * Load extension settings from storage
 */
async function loadSettings(): Promise<void> {
  try {
    const response = await sendToBackground({ type: 'GET_SETTINGS' });
    if (response.type === 'SETTINGS_RESULT') {
      currentSettings = response.payload;
    }
  } catch (error) {
    logger.warn(TAG, 'Failed to load settings:', error);
  }
}

/**
 * Handles click on the AI Review button
 */
async function handleReviewClick(): Promise<void> {
  if (isReviewing) {
    // Cancel ongoing review by disconnecting the port
    if (currentPort) {
      currentPort.disconnect();
      currentPort = null;
    }
    isReviewing = false;
    updateReviewButtonState('idle');
    showToast('Review cancelled');
    return;
  }

  // Start new review
  isReviewing = true;
  updateReviewButtonState('loading');
  clearSuggestionOverlays();

  try {
    // Fetch diff from GitHub API
    const diff = await extractPRDiff();

    if (!diff) {
      throw new Error('Could not fetch diff. Please check you are on a PR page.');
    }

    if (diff.files.length === 0) {
      throw new Error('No files found in the PR diff.');
    }

    currentDiff = diff;

    logger.debug(TAG, 'Extracted diff:', {
      files: diff.files.length,
      title: diff.title,
    });

    // Create port for streaming communication
    const port = chrome.runtime.connect({ name: `review-stream-${Date.now()}` });
    currentPort = port;

    // Initialize UI for streaming
    initializeSuggestions(currentDiff, true);

    let suggestionCount = 0;

    port.onMessage.addListener((msg: StreamPortMessage) => {
      switch (msg.type) {
        case 'CHUNK':
          suggestionCount++;
          appendSuggestion(msg.payload);
          // Show toast for first suggestion to give immediate feedback
          if (suggestionCount === 1) {
            showToast('Found first suggestion, analyzing more...');
          }
          break;
        case 'END':
          isReviewing = false;
          updateReviewButtonState('idle');
          finalizeSuggestions();
          renderReviewSummary(msg.payload.summary, msg.payload.overallAssessment, suggestionCount);
          showToast(`Review complete! ${suggestionCount} suggestion${suggestionCount !== 1 ? 's' : ''} found.`);
          currentPort = null;
          break;
        case 'ERROR':
          isReviewing = false;
          updateReviewButtonState('error');
          showToast(msg.payload.error, 'error');
          currentPort = null;
          setTimeout(() => {
            updateReviewButtonState('idle');
          }, TIMEOUTS.BUTTON_STATE_RESET);
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      if (isReviewing) {
        isReviewing = false;
        updateReviewButtonState('error');
        showToast('Connection lost', 'error');
        setTimeout(() => {
          updateReviewButtonState('idle');
        }, TIMEOUTS.BUTTON_STATE_RESET);
      }
      currentPort = null;
    });

    // Start the review
    port.postMessage({ type: 'START', payload: diff });

  } catch (error) {
    logger.error(TAG, 'Review failed:', error);
    isReviewing = false;
    updateReviewButtonState('error');
    showToast(error instanceof Error ? error.message : 'Review failed', 'error');
    currentPort = null;

    // Reset to idle after showing error
    setTimeout(() => {
      updateReviewButtonState('idle');
    }, TIMEOUTS.BUTTON_STATE_RESET);
  }
}

/**
 * Handles review response from background script
 */
function handleReviewResponse(response: BackgroundMessage): void {
  isReviewing = false;

  if (response.type === 'REVIEW_RESULT') {
    lastReviewResponse = response.payload;
    updateReviewButtonState('idle');

    // Render suggestions
    renderSuggestions(response.payload.suggestions, currentDiff);

    // Render summary banner
    renderReviewSummary(
      response.payload.summary,
      response.payload.overallAssessment,
      response.payload.suggestions.length
    );

    showToast(`Review complete: ${response.payload.suggestions.length} suggestions`);
  } else if (response.type === 'REVIEW_ERROR') {
    updateReviewButtonState('error');
    showToast(response.payload.error, 'error');

    setTimeout(() => {
      updateReviewButtonState('idle');
    }, TIMEOUTS.BUTTON_STATE_RESET);
  }
}

/**
 * Handles messages from the background script (non-streaming messages only)
 */
function handleBackgroundMessage(
  message: BackgroundMessage,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
): boolean {
  switch (message.type) {
    case 'REVIEW_PROGRESS':
      logger.debug(TAG, 'Progress:', message.payload.status);
      break;

    case 'REVIEW_RESULT':
      handleReviewResponse(message);
      break;

    case 'REVIEW_ERROR':
      handleReviewResponse(message);
      break;
  }

  sendResponse();
  return false;
}

/**
 * Waits a short delay for page to stabilize
 */
function waitForDiffContent(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, TIMEOUTS.DIFF_CONTENT_WAIT));
}

/**
 * Sets up observer for SPA navigation on GitHub
 */
function setupNavigationObserver(): void {
  // GitHub uses turbo/pjax for navigation
  let lastUrl = window.location.href;

  const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      handleNavigation();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Also listen for popstate events
  window.addEventListener('popstate', handleNavigation);
}

/**
 * Handles SPA navigation
 */
function handleNavigation(): void {
  // Clean up existing state
  if (currentPort) {
    currentPort.disconnect();
    currentPort = null;
  }
  isReviewing = false;
  lastReviewResponse = null;
  currentDiff = null;
  clearSuggestionOverlays();

  // Remove existing button
  const existingButton = document.querySelector(`.${CSS_CLASSES.REVIEW_BUTTON}`);
  if (existingButton) {
    existingButton.remove();
  }

  // Remove existing summary
  const existingSummary = document.querySelector(`.${CSS_CLASSES.SUMMARY}`);
  if (existingSummary) {
    existingSummary.remove();
  }

  // Check if we're on a PR page and re-initialize
  const metadata = extractPRMetadata();
  if (metadata) {
    // Wait a bit for the new content to load
    setTimeout(() => {
      renderReviewButton(handleReviewClick);

      if (currentSettings.autoReviewOnLoad) {
        waitForDiffContent().then(handleReviewClick).catch(err => logger.error(TAG, 'Auto-review failed:', err));
      }
    }, TIMEOUTS.NAVIGATION_DEBOUNCE);
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Export for testing
export { init, handleReviewClick };