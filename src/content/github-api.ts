/**
 * GitHub API for posting PR review comments
 */

import { sendToBackground } from '../shared/messages';

export interface PRContext {
  owner: string;
  repo: string;
  prNumber: number;
  baseCommitOid: string;
  headCommitOid: string;
}

/**
 * Extract PR context from the URL
 */
function extractPRFromUrl(): { owner: string; repo: string; prNumber: number } | null {
  const match = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) {
    return null;
  }
  return {
    owner: match[1],
    repo: match[2],
    prNumber: parseInt(match[3], 10),
  };
}

/**
 * Fetch PR context from GitHub API via background script (avoids CORS)
 */
export async function fetchPRContext(): Promise<PRContext | null> {
  console.log('[PR AI Review] Fetching PR context via background script...');

  const prInfo = extractPRFromUrl();
  if (!prInfo) {
    console.error('[PR AI Review] Not on a PR page');
    return null;
  }

  const { owner, repo, prNumber } = prInfo;
  console.log('[PR AI Review] PR:', `${owner}/${repo}#${prNumber}`);

  try {
    const response = await sendToBackground({
      type: 'FETCH_PR_CONTEXT',
      payload: { owner, repo, prNumber },
    });

    console.log('[PR AI Review] Background response:', response);

    if (response.type === 'PR_CONTEXT_RESULT') {
      const { baseCommitOid, headCommitOid } = response.payload;

      if (!baseCommitOid || !headCommitOid) {
        console.warn('[PR AI Review] API response missing commit SHAs, falling back to page scraping');
        return extractPRContextFromPage();
      }

      console.log('[PR AI Review] PR Context from API:', { owner, repo, prNumber, baseCommitOid, headCommitOid });
      return { owner, repo, prNumber, baseCommitOid, headCommitOid };
    } else if (response.type === 'PR_CONTEXT_ERROR') {
      console.error('[PR AI Review] Background script error:', response.payload.error);
      // Fall back to page scraping
      return extractPRContextFromPage();
    }

    // Unexpected response type
    console.warn('[PR AI Review] Unexpected response type:', response.type);
    return extractPRContextFromPage();
  } catch (error) {
    console.error('[PR AI Review] Error fetching from background:', error);
    // Fall back to page scraping
    return extractPRContextFromPage();
  }
}

/**
 * Extract PR context from the page (fallback method)
 */
export function extractPRContextFromPage(): PRContext | null {
  console.log('[PR AI Review] Extracting PR context from page...');

  const prInfo = extractPRFromUrl();
  if (!prInfo) {
    console.error('[PR AI Review] Not on a PR page');
    return null;
  }

  const { owner, repo, prNumber } = prInfo;

  // Try to get commit OIDs from various sources
  let baseCommitOid = '';
  let headCommitOid = '';

  // Method 1: From embedded JSON data in script tags
  const scripts = document.querySelectorAll('script[type="application/json"], script[data-target]');
  for (const script of scripts) {
    try {
      const text = script.textContent || '';
      const data = JSON.parse(text);

      // Deep search for commit OIDs
      const searchObj = (obj: Record<string, unknown>, depth = 0): void => {
        if (depth > 5 || !obj || typeof obj !== 'object') return;

        for (const [key, value] of Object.entries(obj)) {
          const keyLower = key.toLowerCase();
          if ((keyLower === 'basecommitoid' || keyLower === 'basesha' || keyLower === 'base_sha') &&
              typeof value === 'string' && value.length >= 7) {
            baseCommitOid = baseCommitOid || value;
          }
          if ((keyLower === 'headcommitoid' || keyLower === 'headsha' || keyLower === 'head_sha') &&
              typeof value === 'string' && value.length >= 7) {
            headCommitOid = headCommitOid || value;
          }
          if (typeof value === 'object' && value !== null) {
            searchObj(value as Record<string, unknown>, depth + 1);
          }
        }
      };

      searchObj(data);
    } catch {
      // Not valid JSON, skip
    }
  }
  console.log('[PR AI Review] Method 1 (script tags):', { baseCommitOid, headCommitOid });

  // Method 2: From the page HTML using regex
  if (!baseCommitOid || !headCommitOid) {
    const pageHTML = document.documentElement.outerHTML;

    const patterns = [
      /"baseCommitOid"\s*:\s*"([a-f0-9]{7,40})"/i,
      /"base_sha"\s*:\s*"([a-f0-9]{7,40})"/i,
      /"baseSha"\s*:\s*"([a-f0-9]{7,40})"/i,
    ];

    for (const pattern of patterns) {
      if (!baseCommitOid) {
        const match = pageHTML.match(pattern);
        if (match) baseCommitOid = match[1];
      }
    }

    const headPatterns = [
      /"headCommitOid"\s*:\s*"([a-f0-9]{7,40})"/i,
      /"head_sha"\s*:\s*"([a-f0-9]{7,40})"/i,
      /"headSha"\s*:\s*"([a-f0-9]{7,40})"/i,
    ];

    for (const pattern of headPatterns) {
      if (!headCommitOid) {
        const match = pageHTML.match(pattern);
        if (match) headCommitOid = match[1];
      }
    }
    console.log('[PR AI Review] Method 2 (HTML regex):', { baseCommitOid, headCommitOid });
  }

  console.log('[PR AI Review] Final PR Context from page:', { owner, repo, prNumber, baseCommitOid, headCommitOid });

  return { owner, repo, prNumber, baseCommitOid, headCommitOid };
}

/**
 * Post a single-line comment
 */
export async function postLineComment(
  context: PRContext,
  path: string,
  line: number,
  text: string
): Promise<boolean> {
  const { owner, repo, prNumber, headCommitOid } = context;

  console.log('[PR AI Review] postLineComment called');
  console.log('[PR AI Review] File path:', path);
  console.log('[PR AI Review] Line:', line);
  console.log('[PR AI Review] Comment text length:', text.length);

  if (!headCommitOid) {
    console.error('[PR AI Review] Missing head commit OID');
    return false;
  }

  try {
    const response = await sendToBackground({
      type: 'POST_COMMENT',
      payload: {
        owner,
        repo,
        prNumber,
        body: text,
        path,
        line,
        commitId: headCommitOid,
        side: 'RIGHT',
      },
    });

    console.log('[PR AI Review] Post comment response:', response);

    if (response.type === 'POST_COMMENT_RESULT' && response.payload.success) {
      console.log('[PR AI Review] Comment posted successfully:', response.payload.url);
      return true;
    } else if (response.type === 'POST_COMMENT_ERROR') {
      console.error('[PR AI Review] Failed to post comment:', response.payload.error);
      return false;
    }

    return false;
  } catch (error) {
    console.error('[PR AI Review] Error posting comment:', error);
    return false;
  }
}

/**
 * Post a multi-line comment (for suggestions)
 */
export async function postMultiLineComment(
  context: PRContext,
  path: string,
  startLine: number,
  endLine: number,
  text: string
): Promise<boolean> {
  const { owner, repo, prNumber, headCommitOid } = context;

  console.log('[PR AI Review] postMultiLineComment called');
  console.log('[PR AI Review] File path:', path);
  console.log('[PR AI Review] Start line:', startLine);
  console.log('[PR AI Review] End line:', endLine);
  console.log('[PR AI Review] Comment text length:', text.length);

  if (!headCommitOid) {
    console.error('[PR AI Review] Missing head commit OID');
    return false;
  }

  try {
    const response = await sendToBackground({
      type: 'POST_COMMENT',
      payload: {
        owner,
        repo,
        prNumber,
        body: text,
        path,
        line: endLine,
        commitId: headCommitOid,
        side: 'RIGHT',
        startLine,
        startSide: 'RIGHT',
      },
    });

    console.log('[PR AI Review] Post comment response:', response);

    if (response.type === 'POST_COMMENT_RESULT' && response.payload.success) {
      console.log('[PR AI Review] Comment posted successfully:', response.payload.url);
      return true;
    } else if (response.type === 'POST_COMMENT_ERROR') {
      console.error('[PR AI Review] Failed to post comment:', response.payload.error);
      return false;
    }

    return false;
  } catch (error) {
    console.error('[PR AI Review] Error posting comment:', error);
    return false;
  }
}

/**
 * Submit the pending review
 * @param event - If omitted, review stays as draft (pending)
 */
export async function submitReview(
  owner: string,
  repo: string,
  prNumber: number,
  event?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
  body?: string,
  commitId?: string
): Promise<{ success: boolean; url?: string; error?: string; isDraft?: boolean }> {
  console.log('[PR AI Review] Submitting review...');
  console.log('[PR AI Review] Event:', event);

  try {
    const response = await sendToBackground({
      type: 'SUBMIT_REVIEW',
      payload: {
        owner,
        repo,
        prNumber,
        event,
        body,
        commitId,
      },
    });

    console.log('[PR AI Review] Submit review response:', response);

    if (response.type === 'SUBMIT_REVIEW_RESULT' && response.payload.success) {
      console.log('[PR AI Review] Review submitted successfully:', response.payload.url);
      return { success: true, url: response.payload.url, isDraft: !event };
    } else if (response.type === 'SUBMIT_REVIEW_ERROR') {
      console.error('[PR AI Review] Failed to submit review:', response.payload.error);
      return { success: false, error: response.payload.error };
    }

    return { success: false, error: 'Unexpected response' };
  } catch (error) {
    console.error('[PR AI Review] Error submitting review:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to submit review' };
  }
}

/**
 * Format comment with GitHub suggestion syntax
 */
export function formatSuggestionComment(
  title: string,
  description: string,
  suggestedCode?: string
): string {
  let comment = '';

  if (title) {
    comment += `**${title}**\n\n`;
  }
  comment += description;

  if (suggestedCode) {
    comment += `\n\n\`\`\`suggestion\n${suggestedCode}\n\`\`\``;
  }

  return comment;
}
