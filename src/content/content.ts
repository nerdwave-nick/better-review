import { extractPRDiff, extractPRMetadata } from './diff-parser';
import {
  renderReviewButton,
  renderSuggestions,
  renderReviewSummary,
  updateReviewButtonState,
  clearSuggestionOverlays,
  showToast,
} from './overlay-ui';
import { sendToBackground, DEFAULT_SETTINGS } from '../shared/messages';
import type { BackgroundMessage, ContentMessage } from '../shared/messages';
import type { ReviewResponse, ExtensionSettings } from '../shared/types';

// State
let isReviewing = false;
let currentSettings: ExtensionSettings = DEFAULT_SETTINGS;
let lastReviewResponse: ReviewResponse | null = null;

/**
 * Initialize the extension on GitHub PR pages
 */
async function init(): Promise<void> {
  // Verify we're on a PR page with diff content
  const metadata = extractPRMetadata();
  if (!metadata) {
    console.log('[PR AI Review] Not on a PR page, skipping initialization');
    return;
  }

  console.log('[PR AI Review] Initializing on PR page:', metadata);

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
    console.warn('[PR AI Review] Failed to load settings:', error);
  }
}

/**
 * Handles click on the AI Review button
 */
async function handleReviewClick(): Promise<void> {
  if (isReviewing) {
    // Cancel ongoing review
    try {
      await sendToBackground({ type: 'CANCEL_REVIEW' });
      isReviewing = false;
      updateReviewButtonState('idle');
      showToast('Review cancelled');
    } catch (error) {
      console.error('[PR AI Review] Failed to cancel review:', error);
    }
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

    console.log('[PR AI Review] Extracted diff:', {
      files: diff.files.length,
      title: diff.title,
    });

    // Send review request to background script
    const response = await sendToBackground({
      type: 'REQUEST_REVIEW',
      payload: diff,
    });

    handleReviewResponse(response);
  } catch (error) {
    console.error('[PR AI Review] Review failed:', error);
    isReviewing = false;
    updateReviewButtonState('error');
    showToast(error instanceof Error ? error.message : 'Review failed', 'error');

    // Reset to idle after showing error
    setTimeout(() => {
      updateReviewButtonState('idle');
    }, 3000);
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
    renderSuggestions(response.payload.suggestions);

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
    }, 3000);
  }
}

/**
 * Handles messages from the background script
 */
function handleBackgroundMessage(
  message: BackgroundMessage,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
): boolean {
  switch (message.type) {
    case 'REVIEW_PROGRESS':
      // Could show progress indicator
      console.log('[PR AI Review] Progress:', message.payload.status);
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
  return new Promise(resolve => setTimeout(resolve, 500));
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
  isReviewing = false;
  lastReviewResponse = null;
  clearSuggestionOverlays();

  // Remove existing button
  const existingButton = document.querySelector('.pr-ai-review-btn');
  if (existingButton) {
    existingButton.remove();
  }

  // Remove existing summary
  const existingSummary = document.querySelector('.pr-ai-summary');
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
        waitForDiffContent().then(handleReviewClick).catch(console.error);
      }
    }, 500);
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
