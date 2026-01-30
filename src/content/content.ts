import { extractPRMetadata } from './diff-parser';
import { mountOverlay } from '../ui/views/overlay/mount';
import { mountDescriptionButton, unmountDescriptionButton } from '../ui/views/mount-button';
import { store, actions } from '../ui/views/overlay/store';
import { extractCompareFromUrl, isOnFilesChangedView } from '../shared/utils';
import { TIMEOUTS, LOG_TAGS } from '../shared/constants';
import { logger } from '../shared/logger';

const TAG = LOG_TAGS.CONTENT;

/**
 * Initialize the extension on GitHub PR pages
 */
async function init(): Promise<void> {
  // Mount the main overlay (hidden by default)
  mountOverlay();

  // Load settings
  await actions.loadSettings();

  // Check if we're on a PR page
  const metadata = extractPRMetadata();
  if (metadata) {
    logger.debug(TAG, 'Initializing on PR page:', metadata);

    // Show the review button (via Vue store)
    actions.setReviewButtonState('idle');

    // Check if we should auto-start review (from button click redirect)
    const pendingAutoReview = sessionStorage.getItem('pr-ai-pending-auto-review') === 'true';
    if (pendingAutoReview && isOnFilesChangedView()) {
      sessionStorage.removeItem('pr-ai-pending-auto-review');
      setTimeout(() => {
        actions.startReview();
      }, 500);
    }
  }

  // Check for PR description textarea
  initPRDescriptionButton();

  // Set up mutation observer for SPA navigation
  setupNavigationObserver();
}

/**
 * Initialize the PR description generation button
 */
function initPRDescriptionButton(): void {
  const tryAddButton = () => {
    const compareMetadata = extractCompareFromUrl();
    const prMetadata = extractPRMetadata();

    if (compareMetadata || prMetadata) {
      // Find target
      const targetSelectors = [
        '.js-pull-request-form .BtnGroup',
        '.js-pull-request-form .form-actions',
        '[data-testid="create-pr-footer"]',
        '.js-previewable-comment-form .form-actions',
        '.comment-form-actions',
      ];

      let targetContainer: Element | null = null;
      for (const selector of targetSelectors) {
        targetContainer = document.querySelector(selector);
        if (targetContainer) break;
      }

      const textarea = document.querySelector(
        'textarea[name="pull_request[body]"], textarea#pull_request_body, textarea[name="issue[body]"] , textarea#issue_body'
      );

      if (targetContainer) {
        mountDescriptionButton(targetContainer, false);
      } else if (textarea) {
        mountDescriptionButton(document.body, true); // Floating
      }
    }
  };

  tryAddButton();
  setTimeout(tryAddButton, 1000);
  setTimeout(tryAddButton, 2000);
}

/**
 * Sets up observer for SPA navigation on GitHub
 */
function setupNavigationObserver(): void {
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

  window.addEventListener('popstate', handleNavigation);
}

/**
 * Handles SPA navigation
 */
function handleNavigation(): void {
  // Reset store state
  actions.reset();

  // Hide review button until we confirm we are on PR page
  store.isReviewButtonVisible = false;

  // Unmount description button
  unmountDescriptionButton();

  setTimeout(async () => {
    const metadata = extractPRMetadata();
    if (metadata) {
      actions.setReviewButtonState('idle');

      // Check if we should auto-start review (from button click redirect)
      const pendingAutoReview = sessionStorage.getItem('pr-ai-pending-auto-review') === 'true';
      if (pendingAutoReview && isOnFilesChangedView()) {
        sessionStorage.removeItem('pr-ai-pending-auto-review');
        actions.startReview();
      }
    }
    initPRDescriptionButton();
  }, TIMEOUTS.NAVIGATION_DEBOUNCE);
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

export { init };
