import { Octokit } from '@octokit/rest';
import { requestReview, generatePRDescription } from './gemini-service';
import { orchestrateReview, hasAvailableProviders } from './orchestrator';
import { DEFAULT_SETTINGS } from '../shared/messages';
import type { ContentMessage, BackgroundMessage, StreamPortMessage } from '../shared/messages';
import type { ExtensionSettings, PRDiff } from '../shared/types';
import { STORAGE_KEYS, GITHUB_WEB_URL } from '../shared/constants';

// Pending comments cache per PR
const pendingComments = new Map<string, Array<{
  path: string;
  line: number;
  body: string;
  side: string;
  startLine?: number;
  startSide?: string;
}>>();

// Octokit instance (created when needed with token)
let octokit: Octokit | null = null;

async function getOctokit(): Promise<Octokit | null> {
  const settings = await getSettings();
  if (!settings.githubToken) return null;
  if (!octokit) {
    octokit = new Octokit({ auth: settings.githubToken });
  }
  return octokit;
}

// Initialize
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender, sendResponse);
  return true;
});

chrome.runtime.onConnect.addListener(handleStreamingPort);

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
  }
});

// Streaming port handler
function handleStreamingPort(port: chrome.runtime.Port): void {
  if (!port.name.startsWith('review-stream-')) return;

  let aborted = false;
  port.onDisconnect.addListener(() => { aborted = true; });

  port.onMessage.addListener(async (msg: StreamPortMessage) => {
    if (msg.type !== 'START') return;

    const settings = await getSettings();
    if (!hasAvailableProviders(settings)) {
      port.postMessage({ type: 'ERROR', payload: { error: 'No AI providers configured. Please set up at least one API key in settings.' } });
      return;
    }

    await orchestrateReview(
      msg.payload,
      settings,
      {
        onSuggestion: (suggestion) => !aborted && port.postMessage({ type: 'CONSENSUS_CHUNK', payload: suggestion }),
        onSuggestionUpdate: (id, suggestion) => !aborted && port.postMessage({ type: 'CHUNK_UPDATE', payload: { id, suggestion } }),
        onSummary: (summaryData) => !aborted && port.postMessage({ type: 'SUMMARY', payload: summaryData }),
        onProviderStarted: (provider) => !aborted && port.postMessage({ type: 'PROVIDER_STARTED', payload: { provider } }),
        onProviderCompleted: (provider, count) => !aborted && port.postMessage({ type: 'PROVIDER_COMPLETED', payload: { provider, count } }),
        onProviderError: (provider, error) => !aborted && port.postMessage({ type: 'PROVIDER_ERROR', payload: { provider, error } }),
        onComplete: (summary, assessment) => !aborted && port.postMessage({ type: 'END', payload: { summary, overallAssessment: assessment } }),
        onError: (error) => !aborted && port.postMessage({ type: 'ERROR', payload: { error } }),
      }
    );
  });
}

// Message handler
async function handleMessage(
  message: ContentMessage,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: BackgroundMessage) => void
): Promise<void> {
  try {
    switch (message.type) {
      case 'REQUEST_REVIEW':
        return handleReviewRequest(message.payload, sendResponse);

      case 'GET_SETTINGS':
        return sendResponse({ type: 'SETTINGS_RESULT', payload: await getSettings() });

      case 'SAVE_SETTINGS':
        await saveSettings(message.payload);
        octokit = null; // Reset octokit to pick up new token
        return sendResponse({ type: 'SETTINGS_RESULT', payload: await getSettings() });

      case 'CHECK_CONNECTION':
        const settings = await getSettings();
        return sendResponse({ type: 'CONNECTION_STATUS', payload: { connected: hasAvailableProviders(settings), lastPing: Date.now() } });

      case 'FETCH_DIFF':
        return handleFetchDiff(message.payload, sendResponse);

      case 'FETCH_COMPARE_DIFF':
        return handleFetchCompareDiff(message.payload, sendResponse);

      case 'FETCH_PR_CONTEXT':
        return handleFetchPRContext(message.payload, sendResponse);

      case 'POST_COMMENT':
        return handlePostComment(message.payload, sendResponse);

      case 'SUBMIT_REVIEW':
        return handleSubmitReview(message.payload, sendResponse);

      case 'GENERATE_PR_DESCRIPTION':
        return handleGeneratePRDescription(message.payload, sendResponse);

      default:
        return sendResponse({ type: 'REVIEW_ERROR', payload: { error: 'Unknown message type' } });
    }
  } catch (error) {
    sendResponse({ type: 'REVIEW_ERROR', payload: { error: error instanceof Error ? error.message : 'Unknown error' } });
  }
}

// Review request handler
async function handleReviewRequest(diff: PRDiff, sendResponse: (r: BackgroundMessage) => void): Promise<void> {
  const settings = await getSettings();
  if (!hasAvailableProviders(settings)) {
    return sendResponse({ type: 'REVIEW_ERROR', payload: { error: 'No AI providers configured. Please set up at least one API key in settings.' } });
  }

  try {
    // For non-streaming requests, use the legacy Gemini path if available
    if (settings.geminiApiKey) {
      const response = await requestReview(diff, settings);
      sendResponse({ type: 'REVIEW_RESULT', payload: response });
    } else {
      sendResponse({ type: 'REVIEW_ERROR', payload: { error: 'Non-streaming review requires Gemini API key.' } });
    }
  } catch (error) {
    sendResponse({ type: 'REVIEW_ERROR', payload: { error: error instanceof Error ? error.message : 'Review failed' } });
  }
}

// Fetch diff
async function handleFetchDiff(
  payload: { owner: string; repo: string; prNumber: number },
  sendResponse: (r: BackgroundMessage) => void
): Promise<void> {
  try {
    const response = await fetch(`${GITHUB_WEB_URL}/${payload.owner}/${payload.repo}/pull/${payload.prNumber}.diff`);
    if (!response.ok) throw new Error(`Failed to fetch diff: ${response.status}`);
    sendResponse({ type: 'DIFF_RESULT', payload: { diffText: await response.text() } });
  } catch (error) {
    sendResponse({ type: 'DIFF_ERROR', payload: { error: error instanceof Error ? error.message : 'Failed to fetch diff' } });
  }
}

// Fetch compare diff (for PR creation page)
async function handleFetchCompareDiff(
  payload: { owner: string; repo: string; compareSpec: string },
  sendResponse: (r: BackgroundMessage) => void
): Promise<void> {
  try {
    const response = await fetch(`${GITHUB_WEB_URL}/${payload.owner}/${payload.repo}/compare/${payload.compareSpec}.diff`);
    if (!response.ok) throw new Error(`Failed to fetch compare diff: ${response.status}`);
    sendResponse({ type: 'DIFF_RESULT', payload: { diffText: await response.text() } });
  } catch (error) {
    sendResponse({ type: 'DIFF_ERROR', payload: { error: error instanceof Error ? error.message : 'Failed to fetch compare diff' } });
  }
}

// Fetch PR context using Octokit
async function handleFetchPRContext(
  payload: { owner: string; repo: string; prNumber: number },
  sendResponse: (r: BackgroundMessage) => void
): Promise<void> {
  const { owner, repo, prNumber } = payload;

  try {
    const client = await getOctokit();
    if (!client) {
      // Fallback to unauthenticated request
      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`);
      if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
      const data = await response.json();
      return sendResponse({
        type: 'PR_CONTEXT_RESULT',
        payload: { owner, repo, prNumber, baseCommitOid: data.base?.sha || '', headCommitOid: data.head?.sha || '' },
      });
    }

    const { data } = await client.pulls.get({ owner, repo, pull_number: prNumber });
    sendResponse({
      type: 'PR_CONTEXT_RESULT',
      payload: { owner, repo, prNumber, baseCommitOid: data.base.sha, headCommitOid: data.head.sha },
    });
  } catch (error) {
    sendResponse({ type: 'PR_CONTEXT_ERROR', payload: { error: error instanceof Error ? error.message : 'Failed to fetch PR context' } });
  }
}

// Store comment locally
async function handlePostComment(
  payload: { owner: string; repo: string; prNumber: number; body: string; path: string; line: number; side?: string; startLine?: number; startSide?: string },
  sendResponse: (r: BackgroundMessage) => void
): Promise<void> {
  const { owner, repo, prNumber, body, path, line, side, startLine, startSide } = payload;
  const key = `${owner}/${repo}/${prNumber}`;

  if (!pendingComments.has(key)) pendingComments.set(key, []);
  const comments = pendingComments.get(key)!;

  comments.push({
    path,
    line,
    body,
    side: side || 'RIGHT',
    ...(startLine && startLine !== line ? { startLine, startSide: startSide || 'RIGHT' } : {}),
  });

  sendResponse({ type: 'POST_COMMENT_RESULT', payload: { success: true, commentId: comments.length } });
}

// Submit review using Octokit
async function handleSubmitReview(
  payload: { owner: string; repo: string; prNumber: number; event?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; body?: string; commitId?: string },
  sendResponse: (r: BackgroundMessage) => void
): Promise<void> {
  const { owner, repo, prNumber, event, body, commitId } = payload;
  const key = `${owner}/${repo}/${prNumber}`;

  const client = await getOctokit();
  if (!client) {
    return sendResponse({ type: 'SUBMIT_REVIEW_ERROR', payload: { error: 'GitHub token required. Add it in extension settings.' } });
  }

  const comments = pendingComments.get(key) || [];
  if (comments.length === 0) {
    return sendResponse({ type: 'SUBMIT_REVIEW_ERROR', payload: { error: 'No pending comments to submit.' } });
  }

  try {
    // Delete existing pending reviews first
    const { data: reviews } = await client.pulls.listReviews({ owner, repo, pull_number: prNumber });
    for (const review of reviews.filter(r => r.state === 'PENDING')) {
      await client.pulls.deletePendingReview({ owner, repo, pull_number: prNumber, review_id: review.id }).catch(() => {});
    }

    // Create review with all comments
    const { data } = await client.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitId,
      body,
      event: event as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' | undefined,
      comments: comments.map(c => ({
        path: c.path,
        body: c.body,
        line: c.line,
        side: c.side as 'LEFT' | 'RIGHT',
        ...(c.startLine ? { start_line: c.startLine, start_side: (c.startSide || c.side) as 'LEFT' | 'RIGHT' } : {}),
      })),
    });

    pendingComments.delete(key);
    sendResponse({ type: 'SUBMIT_REVIEW_RESULT', payload: { success: true, url: data.html_url } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to submit review';
    sendResponse({ type: 'SUBMIT_REVIEW_ERROR', payload: { error: message } });
  }
}

// PR template URL
const PR_TEMPLATE_URL = 'https://raw.githubusercontent.com/TomesGmbH/.github/main/pull_request_template.md';

// Generate PR description
async function handleGeneratePRDescription(
  payload: { owner: string; repo: string; compareSpec: string; template: string },
  sendResponse: (r: BackgroundMessage) => void
): Promise<void> {
  const settings = await getSettings();
  if (!settings.geminiApiKey) {
    return sendResponse({ type: 'PR_DESCRIPTION_ERROR', payload: { error: 'Please set your Gemini API key in settings.' } });
  }

  try {
    // Fetch the diff and template in parallel
    const [diffResponse, templateResponse] = await Promise.all([
      fetch(`${GITHUB_WEB_URL}/${payload.owner}/${payload.repo}/compare/${payload.compareSpec}.diff`),
      fetch(PR_TEMPLATE_URL),
    ]);

    if (!diffResponse.ok) throw new Error(`Failed to fetch diff: ${diffResponse.status}`);
    const diffText = await diffResponse.text();

    // Use fetched template, fallback to payload template if fetch fails
    let template = payload.template;
    if (templateResponse.ok) {
      template = await templateResponse.text();
    }

    // Generate the description
    const description = await generatePRDescription(diffText, template, settings.geminiApiKey);
    sendResponse({ type: 'PR_DESCRIPTION_RESULT', payload: { description } });
  } catch (error) {
    sendResponse({ type: 'PR_DESCRIPTION_ERROR', payload: { error: error instanceof Error ? error.message : 'Failed to generate PR description' } });
  }
}

// Settings helpers
async function getSettings(): Promise<ExtensionSettings> {
  return new Promise(resolve => {
    chrome.storage.local.get([STORAGE_KEYS.SETTINGS], result => {
      resolve(result[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS);
    });
  });
}

async function saveSettings(settings: Partial<ExtensionSettings>): Promise<void> {
  const current = await getSettings();
  return new Promise(resolve => {
    chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: { ...current, ...settings } }, resolve);
  });
}

export { handleMessage, getSettings, saveSettings };
