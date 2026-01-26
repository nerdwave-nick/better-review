import { requestReview } from './gemini-service';
import { DEFAULT_SETTINGS } from '../shared/messages';
import type {
  ContentMessage,
  BackgroundMessage,
} from '../shared/messages';
import type { ExtensionSettings, PRDiff } from '../shared/types';

// Storage key for settings
const SETTINGS_KEY = 'pr_ai_review_settings';

// Current review state
let currentReviewTabId: number | null = null;

/**
 * Initialize the service worker
 */
function init(): void {
  console.log('[Service Worker] Initializing...');

  // Set up message listener
  chrome.runtime.onMessage.addListener(handleMessage);

  // Set up install/update listener
  chrome.runtime.onInstalled.addListener(handleInstalled);

  console.log('[Service Worker] Initialized');
}

/**
 * Handles extension install/update
 */
function handleInstalled(details: chrome.runtime.InstalledDetails): void {
  if (details.reason === 'install') {
    // Initialize default settings
    chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
    console.log('[Service Worker] Extension installed, default settings saved');
  }
}

/**
 * Handles messages from content scripts and popup
 */
function handleMessage(
  message: ContentMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: BackgroundMessage) => void
): boolean {
  // Return true to indicate we'll send response asynchronously
  handleMessageAsync(message, sender, sendResponse);
  return true;
}

/**
 * Async handler for messages
 */
async function handleMessageAsync(
  message: ContentMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: BackgroundMessage) => void
): Promise<void> {
  console.log('[Service Worker] Received message:', message.type);

  try {
    switch (message.type) {
      case 'REQUEST_REVIEW':
        await handleReviewRequest(message.payload, sender.tab?.id, sendResponse);
        break;

      case 'GET_SETTINGS':
        const settings = await getSettings();
        sendResponse({ type: 'SETTINGS_RESULT', payload: settings });
        break;

      case 'SAVE_SETTINGS':
        await saveSettings(message.payload);
        const updatedSettings = await getSettings();
        sendResponse({ type: 'SETTINGS_RESULT', payload: updatedSettings });
        break;

      case 'CHECK_CONNECTION':
        const currentSettings = await getSettings();
        sendResponse({
          type: 'CONNECTION_STATUS',
          payload: {
            connected: !!currentSettings.geminiApiKey,
            lastPing: Date.now(),
          },
        });
        break;

      case 'CANCEL_REVIEW':
        currentReviewTabId = null;
        sendResponse({
          type: 'REVIEW_PROGRESS',
          payload: { status: 'cancelled' },
        });
        break;

      case 'FETCH_DIFF':
        await handleFetchDiff(message.payload, sendResponse);
        break;

      case 'FETCH_PR_CONTEXT':
        await handleFetchPRContext(message.payload, sendResponse);
        break;

      case 'POST_COMMENT':
        await handlePostComment(message.payload, sendResponse);
        break;

      case 'SUBMIT_REVIEW':
        await handleSubmitReview(message.payload, sendResponse);
        break;

      default:
        sendResponse({
          type: 'REVIEW_ERROR',
          payload: { error: 'Unknown message type' },
        });
    }
  } catch (error) {
    console.error('[Service Worker] Error handling message:', error);
    sendResponse({
      type: 'REVIEW_ERROR',
      payload: {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
}

/**
 * Handles review request from content script
 */
async function handleReviewRequest(
  diff: PRDiff,
  tabId: number | undefined,
  sendResponse: (response: BackgroundMessage) => void
): Promise<void> {
  if (currentReviewTabId !== null && currentReviewTabId !== tabId) {
    sendResponse({
      type: 'REVIEW_ERROR',
      payload: { error: 'Another review is in progress' },
    });
    return;
  }

  currentReviewTabId = tabId ?? null;

  try {
    // Get current settings
    const settings = await getSettings();

    if (!settings.geminiApiKey) {
      sendResponse({
        type: 'REVIEW_ERROR',
        payload: { error: 'Please set your Gemini API key in the extension settings.' },
      });
      return;
    }

    // Send progress update
    if (tabId) {
      broadcastProgress('Analyzing code...', 10, tabId);
    }

    // Request review from Gemini
    const reviewResponse = await requestReview(diff, settings);

    sendResponse({
      type: 'REVIEW_RESULT',
      payload: reviewResponse,
    });
  } catch (error) {
    console.error('[Service Worker] Review request failed:', error);
    sendResponse({
      type: 'REVIEW_ERROR',
      payload: {
        error: error instanceof Error ? error.message : 'Review failed',
      },
    });
  } finally {
    currentReviewTabId = null;
  }
}

/**
 * Broadcasts progress to content scripts
 */
function broadcastProgress(status: string, progress: number, tabId?: number): void {
  const message = {
    type: 'REVIEW_PROGRESS' as const,
    payload: { status, progress },
  };

  if (tabId) {
    chrome.tabs.sendMessage(tabId, message).catch(() => {});
  } else {
    chrome.tabs.query({ url: 'https://github.com/*/pull/*' }, (tabs) => {
      tabs.forEach((tab) => {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, message).catch(() => {});
        }
      });
    });
  }
}

/**
 * Gets settings from storage
 */
async function getSettings(): Promise<ExtensionSettings> {
  return new Promise((resolve) => {
    chrome.storage.local.get([SETTINGS_KEY], (result) => {
      resolve(result[SETTINGS_KEY] || DEFAULT_SETTINGS);
    });
  });
}

/**
 * Saves settings to storage
 */
async function saveSettings(settings: Partial<ExtensionSettings>): Promise<void> {
  const current = await getSettings();
  const updated = { ...current, ...settings };

  return new Promise((resolve) => {
    chrome.storage.local.set({ [SETTINGS_KEY]: updated }, resolve);
  });
}

/**
 * Gets GitHub token from settings
 */
export async function getGitHubToken(): Promise<string | undefined> {
  const settings = await getSettings();
  return settings.githubToken;
}

/**
 * Handles fetching diff from GitHub
 */
async function handleFetchDiff(
  payload: { owner: string; repo: string; prNumber: number },
  sendResponse: (response: BackgroundMessage) => void
): Promise<void> {
  try {
    const diffUrl = `https://github.com/${payload.owner}/${payload.repo}/pull/${payload.prNumber}.diff`;
    console.log('[Service Worker] Fetching diff from:', diffUrl);

    const response = await fetch(diffUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch diff: ${response.status}`);
    }

    const diffText = await response.text();
    console.log('[Service Worker] Fetched diff, length:', diffText.length);

    sendResponse({
      type: 'DIFF_RESULT',
      payload: { diffText },
    });
  } catch (error) {
    console.error('[Service Worker] Error fetching diff:', error);
    sendResponse({
      type: 'DIFF_ERROR',
      payload: { error: error instanceof Error ? error.message : 'Failed to fetch diff' },
    });
  }
}

/**
 * Handles fetching PR context (commit SHAs) from GitHub API
 */
async function handleFetchPRContext(
  payload: { owner: string; repo: string; prNumber: number },
  sendResponse: (response: BackgroundMessage) => void
): Promise<void> {
  const { owner, repo, prNumber } = payload;

  try {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
    console.log('[Service Worker] Fetching PR context from:', apiUrl);

    const settings = await getSettings();
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
    };

    // Add GitHub token if available for private repos
    if (settings.githubToken) {
      headers['Authorization'] = `token ${settings.githubToken}`;
    }

    const response = await fetch(apiUrl, { headers });

    if (!response.ok) {
      console.error('[Service Worker] GitHub API error:', response.status);
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json();
    console.log('[Service Worker] PR context fetched:', {
      base_sha: data.base?.sha,
      head_sha: data.head?.sha,
    });

    sendResponse({
      type: 'PR_CONTEXT_RESULT',
      payload: {
        owner,
        repo,
        prNumber,
        baseCommitOid: data.base?.sha || '',
        headCommitOid: data.head?.sha || '',
      },
    });
  } catch (error) {
    console.error('[Service Worker] Error fetching PR context:', error);
    sendResponse({
      type: 'PR_CONTEXT_ERROR',
      payload: { error: error instanceof Error ? error.message : 'Failed to fetch PR context' },
    });
  }
}

// Cache for pending comments per PR (stored locally until submission)
const pendingCommentsCache: Map<string, Array<{
  path: string;
  line: number;
  body: string;
  side: string;
  startLine?: number;
  startSide?: string;
}>> = new Map();

/**
 * Get GitHub API headers
 */
async function getGitHubHeaders(): Promise<Record<string, string> | null> {
  const settings = await getSettings();

  if (!settings.githubToken) {
    console.error('[Service Worker] No GitHub token configured');
    return null;
  }

  return {
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'Authorization': `token ${settings.githubToken}`,
  };
}

/**
 * Delete any existing pending review for the current user
 */
async function deleteExistingPendingReview(
  owner: string,
  repo: string,
  prNumber: number,
  headers: Record<string, string>
): Promise<void> {
  try {
    console.log('[Service Worker] Checking for existing pending review...');
    const reviewsUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;

    const response = await fetch(reviewsUrl, { headers });

    if (!response.ok) {
      console.log('[Service Worker] Could not fetch reviews:', response.status);
      return;
    }

    const reviews = await response.json();

    // Find pending review(s) - there should only be one per user, but check all
    const pendingReviews = reviews.filter((r: { state: string }) => r.state === 'PENDING');

    for (const review of pendingReviews) {
      console.log('[Service Worker] Deleting existing pending review:', review.id);

      const deleteUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${review.id}`;

      const deleteResponse = await fetch(deleteUrl, {
        method: 'DELETE',
        headers,
      });

      if (deleteResponse.ok) {
        console.log('[Service Worker] Deleted pending review:', review.id);
      } else {
        const errorText = await deleteResponse.text();
        console.warn('[Service Worker] Failed to delete pending review:', deleteResponse.status, errorText);
      }
    }
  } catch (error) {
    console.error('[Service Worker] Error checking/deleting pending reviews:', error);
    // Continue anyway - the create might still work
  }
}

/**
 * Handles storing a draft comment locally (will be submitted with review)
 */
async function handlePostComment(
  payload: {
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
    path: string;
    line: number;
    commitId: string;
    side?: 'LEFT' | 'RIGHT';
    startLine?: number;
    startSide?: 'LEFT' | 'RIGHT';
  },
  sendResponse: (response: BackgroundMessage) => void
): Promise<void> {
  const { owner, repo, prNumber, body, path, line, side, startLine, startSide } = payload;
  const cacheKey = `${owner}/${repo}/${prNumber}`;

  console.log('[Service Worker] Storing draft comment for PR:', `${owner}/${repo}#${prNumber}`);
  console.log('[Service Worker] Comment:', { path, line, startLine });

  try {
    // Get or create the comments array for this PR
    if (!pendingCommentsCache.has(cacheKey)) {
      pendingCommentsCache.set(cacheKey, []);
    }

    const comments = pendingCommentsCache.get(cacheKey)!;

    // Add the comment to the local cache
    comments.push({
      path,
      line,
      body,
      side: side || 'RIGHT',
      ...(startLine && startLine !== line ? {
        startLine,
        startSide: startSide || 'RIGHT',
      } : {}),
    });

    console.log('[Service Worker] Draft comment stored. Total pending:', comments.length);

    sendResponse({
      type: 'POST_COMMENT_RESULT',
      payload: {
        success: true,
        commentId: comments.length, // Just use the index as ID
      },
    });
  } catch (error) {
    console.error('[Service Worker] Error storing comment:', error);
    sendResponse({
      type: 'POST_COMMENT_ERROR',
      payload: { error: error instanceof Error ? error.message : 'Failed to store comment' },
    });
  }
}

/**
 * Handles submitting a review with all pending comments
 */
async function handleSubmitReview(
  payload: {
    owner: string;
    repo: string;
    prNumber: number;
    event?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; // Optional - if omitted, review stays as draft
    body?: string;
    commitId?: string;
  },
  sendResponse: (response: BackgroundMessage) => void
): Promise<void> {
  const { owner, repo, prNumber, event, body, commitId } = payload;
  const cacheKey = `${owner}/${repo}/${prNumber}`;

  console.log('[Service Worker] Submitting review for PR:', `${owner}/${repo}#${prNumber}`);
  console.log('[Service Worker] Event:', event);

  try {
    const headers = await getGitHubHeaders();

    if (!headers) {
      sendResponse({
        type: 'SUBMIT_REVIEW_ERROR',
        payload: { error: 'GitHub token required. Please add it in extension settings.' },
      });
      return;
    }

    // Get pending comments
    const pendingComments = pendingCommentsCache.get(cacheKey) || [];

    if (pendingComments.length === 0) {
      sendResponse({
        type: 'SUBMIT_REVIEW_ERROR',
        payload: { error: 'No pending comments to submit. Add comments first.' },
      });
      return;
    }

    console.log('[Service Worker] Submitting review with', pendingComments.length, 'comments');

    // First, check for and delete any existing pending review
    // (GitHub only allows one pending review per user per PR)
    await deleteExistingPendingReview(owner, repo, prNumber, headers);

    // Build the review payload with all comments
    // GitHub REST API supports 'line' and 'side' for comments
    const reviewComments = pendingComments.map(comment => {
      const c: Record<string, unknown> = {
        path: comment.path,
        body: comment.body,
        line: comment.line,
        side: comment.side,
      };

      // Add multi-line fields if present
      if (comment.startLine && comment.startLine !== comment.line) {
        c.start_line = comment.startLine;
        c.start_side = comment.startSide || comment.side;
      }

      return c;
    });

    const reviewPayload: Record<string, unknown> = {
      comments: reviewComments,
    };

    // Only include event if specified - omitting it keeps review as draft
    if (event) {
      reviewPayload.event = event;
    }

    if (body) {
      reviewPayload.body = body;
    }

    if (commitId) {
      reviewPayload.commit_id = commitId;
    }

    const createUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;

    console.log('[Service Worker] Creating review at:', createUrl);
    console.log('[Service Worker] Review payload:', JSON.stringify(reviewPayload, null, 2));

    const response = await fetch(createUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(reviewPayload),
    });

    const responseText = await response.text();
    console.log('[Service Worker] Response status:', response.status);
    console.log('[Service Worker] Response:', responseText);

    if (response.ok) {
      const data = JSON.parse(responseText);
      console.log('[Service Worker] Review submitted successfully:', data.id);

      // Clear the pending comments cache
      pendingCommentsCache.delete(cacheKey);

      sendResponse({
        type: 'SUBMIT_REVIEW_RESULT',
        payload: {
          success: true,
          url: data.html_url,
        },
      });
    } else {
      let errorMessage = `GitHub API error: ${response.status}`;
      try {
        const errorData = JSON.parse(responseText);
        if (errorData.message) {
          errorMessage = errorData.message;
        }
        if (errorData.errors) {
          const errors = errorData.errors.map((e: { message?: string; resource?: string; field?: string }) =>
            e.message || `${e.resource}.${e.field}`
          ).join(', ');
          errorMessage += ': ' + errors;
        }
      } catch {
        // Not JSON
      }

      console.error('[Service Worker] Failed to submit review:', errorMessage);
      sendResponse({
        type: 'SUBMIT_REVIEW_ERROR',
        payload: { error: errorMessage },
      });
    }
  } catch (error) {
    console.error('[Service Worker] Error submitting review:', error);
    sendResponse({
      type: 'SUBMIT_REVIEW_ERROR',
      payload: { error: error instanceof Error ? error.message : 'Failed to submit review' },
    });
  }
}

// Initialize on load
init();

// Export for testing
export { handleMessage, getSettings, saveSettings };
