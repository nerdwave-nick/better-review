/**
 * GitHub API for posting PR review comments
 */

import { sendToBackground } from '../shared/messages';
import { extractPRFromUrl } from '../shared/utils';
import { LOG_TAGS } from '../shared/constants';
import { logger, getErrorMessage } from '../shared/logger';

const TAG = LOG_TAGS.GITHUB_API;

export interface PRContext {
  owner: string;
  repo: string;
  prNumber: number;
  baseCommitOid: string;
  headCommitOid: string;
}

/**
 * Fetch PR context from GitHub API via background script (avoids CORS)
 */
export async function fetchPRContext(): Promise<PRContext | null> {
  logger.debug(TAG, 'Fetching PR context via background script...');

  const prInfo = extractPRFromUrl();
  if (!prInfo) {
    logger.error(TAG, 'Not on a PR page');
    return null;
  }

  const { owner, repo, prNumber } = prInfo;
  logger.debug(TAG, 'PR:', `${owner}/${repo}#${prNumber}`);

  try {
    const response = await sendToBackground({
      type: 'FETCH_PR_CONTEXT',
      payload: { owner, repo, prNumber },
    });

    if (response.type === 'PR_CONTEXT_RESULT') {
      const { baseCommitOid, headCommitOid } = response.payload;

      if (!baseCommitOid || !headCommitOid) {
        logger.warn(TAG, 'API response missing commit SHAs, falling back to page scraping');
        return extractPRContextFromPage();
      }

      logger.debug(TAG, 'PR Context from API:', { owner, repo, prNumber, baseCommitOid, headCommitOid });
      return { owner, repo, prNumber, baseCommitOid, headCommitOid };
    } else if (response.type === 'PR_CONTEXT_ERROR') {
      logger.error(TAG, 'Background script error:', response.payload.error);
      return extractPRContextFromPage();
    }

    logger.warn(TAG, 'Unexpected response type:', response.type);
    return extractPRContextFromPage();
  } catch (error) {
    logger.error(TAG, 'Error fetching from background:', error);
    return extractPRContextFromPage();
  }
}

/**
 * Extract PR context from the page (fallback method)
 */
export function extractPRContextFromPage(): PRContext | null {
  logger.debug(TAG, 'Extracting PR context from page...');

  const prInfo = extractPRFromUrl();
  if (!prInfo) {
    logger.error(TAG, 'Not on a PR page');
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

  // Method 2: From the page HTML using regex
  if (!baseCommitOid || !headCommitOid) {
    const pageHTML = document.documentElement.outerHTML;

    const basePatterns = [
      /"baseCommitOid"\s*:\s*"([a-f0-9]{7,40})"/i,
      /"base_sha"\s*:\s*"([a-f0-9]{7,40})"/i,
      /"baseSha"\s*:\s*"([a-f0-9]{7,40})"/i,
    ];

    for (const pattern of basePatterns) {
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
  }

  logger.debug(TAG, 'Final PR Context from page:', { owner, repo, prNumber, baseCommitOid, headCommitOid });

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

  logger.debug(TAG, 'postLineComment:', { path, line, textLength: text.length });

  if (!headCommitOid) {
    logger.error(TAG, 'Missing head commit OID');
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

    if (response.type === 'POST_COMMENT_RESULT' && response.payload.success) {
      logger.debug(TAG, 'Comment posted successfully');
      return true;
    } else if (response.type === 'POST_COMMENT_ERROR') {
      logger.error(TAG, 'Failed to post comment:', response.payload.error);
      return false;
    }

    return false;
  } catch (error) {
    logger.error(TAG, 'Error posting comment:', error);
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

  logger.debug(TAG, 'postMultiLineComment:', { path, startLine, endLine, textLength: text.length });

  if (!headCommitOid) {
    logger.error(TAG, 'Missing head commit OID');
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

    if (response.type === 'POST_COMMENT_RESULT' && response.payload.success) {
      logger.debug(TAG, 'Comment posted successfully');
      return true;
    } else if (response.type === 'POST_COMMENT_ERROR') {
      logger.error(TAG, 'Failed to post comment:', response.payload.error);
      return false;
    }

    return false;
  } catch (error) {
    logger.error(TAG, 'Error posting comment:', error);
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
  logger.debug(TAG, 'Submitting review, event:', event);

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

    if (response.type === 'SUBMIT_REVIEW_RESULT' && response.payload.success) {
      logger.debug(TAG, 'Review submitted successfully');
      return { success: true, url: response.payload.url, isDraft: !event };
    } else if (response.type === 'SUBMIT_REVIEW_ERROR') {
      logger.error(TAG, 'Failed to submit review:', response.payload.error);
      return { success: false, error: response.payload.error };
    }

    return { success: false, error: 'Unexpected response' };
  } catch (error) {
    logger.error(TAG, 'Error submitting review:', error);
    return { success: false, error: getErrorMessage(error, 'Failed to submit review') };
  }
}

/**
 * Format comment with GitHub suggestion syntax
 */
export function formatSuggestionComment(
  description: string,
  suggestedCode?: string
): string {
  let comment = description;

  if (suggestedCode) {
    comment += `\n\n\`\`\`suggestion\n${suggestedCode}\n\`\`\``;
  }

  return comment;
}
