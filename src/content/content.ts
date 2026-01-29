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
  updateSuggestion,
  finalizeSuggestions,
  showStreamingSummary,
  renderPRDescriptionButton,
  updatePRDescriptionButtonState,
  providerStarted,
  providerCompleted,
  providerError
} from './overlay-ui';
import { sendToBackground, DEFAULT_SETTINGS } from '../shared/messages';
import type { BackgroundMessage, StreamPortMessage } from '../shared/messages';
import type { ExtensionSettings, PRDiff } from '../shared/types';
import { TIMEOUTS, CSS_CLASSES, LOG_TAGS } from '../shared/constants';
import { logger } from '../shared/logger';
import { extractCompareFromUrl } from '../shared/utils';

const TAG = LOG_TAGS.CONTENT;

// State
let isReviewing = false;
let isGeneratingDescription = false;
let currentSettings: ExtensionSettings = DEFAULT_SETTINGS;
let currentDiff: PRDiff | null = null;
let currentPort: chrome.runtime.Port | null = null;

/**
 * Initialize the extension on GitHub PR pages
 */
async function init(): Promise<void> {
  // Load settings
  await loadSettings();

  // Check if we're on a PR page
  const metadata = extractPRMetadata();
  if (metadata) {
    logger.debug(TAG, 'Initializing on PR page:', metadata);

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
  }

  // Check for PR description textarea (on both PR pages and compare pages)
  initPRDescriptionButton();

  // Set up mutation observer for SPA navigation
  setupNavigationObserver();
}

/**
 * Initialize the PR description generation button
 * Works on compare pages (new PR) and PR pages (when editing description)
 */
function initPRDescriptionButton(): void {
  // Wait for GitHub's UI to load, then try to add the button
  const tryAddButton = () => {
    const compareMetadata = extractCompareFromUrl();
    const prMetadata = extractPRMetadata();

    if (compareMetadata || prMetadata) {
      renderPRDescriptionButton(handleGenerateDescription);
    }
  };

  // Try immediately
  tryAddButton();

  // Also retry after a short delay (GitHub loads UI dynamically)
  setTimeout(tryAddButton, 1000);
  setTimeout(tryAddButton, 2000);
}

/**
 * Handles click on the Generate PR Description button
 */
async function handleGenerateDescription(): Promise<void> {
  if (isGeneratingDescription) {
    showToast('Already generating description...');
    return;
  }

  // Find the description textarea
  const textarea = findPRDescriptionTextarea();
  if (!textarea) {
    showToast('Could not find PR description field', 'error');
    return;
  }

  const compareMetadata = extractCompareFromUrl();
  const prMetadata = extractPRMetadata();

  if (!compareMetadata && !prMetadata) {
    showToast('Not on a PR or compare page', 'error');
    return;
  }

  isGeneratingDescription = true;
  updatePRDescriptionButtonState('loading');

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
        showToast('PR description generated!');
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
        const settingsResponse = await sendToBackground({ type: 'GET_SETTINGS' });
        if (settingsResponse.type !== 'SETTINGS_RESULT' || !settingsResponse.payload.geminiApiKey) {
          throw new Error('Please set your Gemini API key in settings.');
        }

        // Create a temporary compare spec for the generate endpoint
        const response = await sendToBackground({
          type: 'GENERATE_PR_DESCRIPTION',
          payload: {
            owner: prMetadata.owner,
            repo: prMetadata.repo,
            compareSpec: `pull/${prMetadata.prNumber}`, // This won't be used since we pass diff directly
            template,
          },
        });

        if (response.type === 'PR_DESCRIPTION_RESULT') {
          textarea.value = response.payload.description;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          showToast('PR description generated!');
        } else if (response.type === 'PR_DESCRIPTION_ERROR') {
          throw new Error(response.payload.error);
        }
      }
    }
  } catch (error) {
    logger.error(TAG, 'Failed to generate PR description:', error);
    showToast(error instanceof Error ? error.message : 'Failed to generate description', 'error');
  } finally {
    isGeneratingDescription = false;
    updatePRDescriptionButtonState('idle');
  }
}

/**
 * Find the PR description textarea on the page
 */
function findPRDescriptionTextarea(): HTMLTextAreaElement | null {
  // Try different selectors for GitHub's PR description textarea
  const selectors = [
    // New PR creation (compare page)
    'textarea[name="pull_request[body]"]',
    'textarea#pull_request_body',
    // PR edit mode
    'textarea[name="issue[body]"]',
    'textarea#issue_body',
    // Generic markdown editor
    'textarea.js-comment-field',
    // New GitHub interface
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
        case 'SUMMARY':
          // Show the summary immediately while suggestions are still streaming
          showStreamingSummary(msg.payload.summary, msg.payload.keyChanges, msg.payload.potentialConcerns);
          break;
        case 'CHUNK':
          // Legacy single-provider suggestion
          suggestionCount++;
          appendSuggestion(msg.payload);
          if (suggestionCount === 1) {
            showToast('Found first suggestion, analyzing more...');
          }
          break;
        case 'CONSENSUS_CHUNK':
          // Consensus suggestion from multiple providers
          suggestionCount++;
          appendSuggestion(msg.payload);
          if (suggestionCount === 1) {
            showToast('Found first suggestion, analyzing more...');
          }
          break;
        case 'CHUNK_UPDATE':
          // Update existing suggestion with new confidence/providers
          updateSuggestion(msg.payload.id, msg.payload.suggestion);
          break;
        case 'PROVIDER_STARTED':
          providerStarted(msg.payload.provider);
          break;
        case 'PROVIDER_COMPLETED':
          providerCompleted(msg.payload.provider, msg.payload.count);
          break;
        case 'PROVIDER_ERROR':
          providerError(msg.payload.provider, msg.payload.error);
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
  isGeneratingDescription = false;
  currentDiff = null;
  clearSuggestionOverlays();

  // Remove existing buttons
  const existingButton = document.querySelector(`.${CSS_CLASSES.REVIEW_BUTTON}`);
  if (existingButton) {
    existingButton.remove();
  }

  // Remove PR description button
  const existingDescButton = document.querySelector('.pr-ai-description-btn');
  if (existingDescButton) {
    existingDescButton.remove();
  }

  // Remove existing summary
  const existingSummary = document.querySelector(`.${CSS_CLASSES.SUMMARY}`);
  if (existingSummary) {
    existingSummary.remove();
  }

  // Wait a bit for the new content to load
  setTimeout(() => {
    // Check if we're on a PR page and re-initialize review button
    const metadata = extractPRMetadata();
    if (metadata) {
      renderReviewButton(handleReviewClick);

      if (currentSettings.autoReviewOnLoad) {
        waitForDiffContent().then(handleReviewClick).catch(err => logger.error(TAG, 'Auto-review failed:', err));
      }
    }

    // Re-initialize PR description button
    initPRDescriptionButton();
  }, TIMEOUTS.NAVIGATION_DEBOUNCE);
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Export for testing
export { init, handleReviewClick };