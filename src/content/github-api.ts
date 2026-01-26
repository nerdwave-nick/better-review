import { sendToBackground } from '../shared/messages';
import { extractPRFromUrl } from '../shared/utils';

export interface PRContext {
  owner: string;
  repo: string;
  prNumber: number;
  baseCommitOid: string;
  headCommitOid: string;
}

/**
 * Fetch PR context via background script, fallback to page scraping
 */
export async function fetchPRContext(): Promise<PRContext | null> {
  const prInfo = extractPRFromUrl();
  if (!prInfo) return null;

  try {
    const response = await sendToBackground({ type: 'FETCH_PR_CONTEXT', payload: prInfo });

    if (response.type === 'PR_CONTEXT_RESULT' && response.payload.headCommitOid) {
      return response.payload;
    }
  } catch { /* fallback to page scraping */ }

  return extractPRContextFromPage();
}

/**
 * Extract PR context from page HTML (fallback)
 */
function extractPRContextFromPage(): PRContext | null {
  const prInfo = extractPRFromUrl();
  if (!prInfo) return null;

  const { owner, repo, prNumber } = prInfo;
  const html = document.documentElement.outerHTML;

  const baseMatch = html.match(/"(?:baseCommitOid|base_sha|baseSha)"\s*:\s*"([a-f0-9]{7,40})"/i);
  const headMatch = html.match(/"(?:headCommitOid|head_sha|headSha)"\s*:\s*"([a-f0-9]{7,40})"/i);

  return {
    owner,
    repo,
    prNumber,
    baseCommitOid: baseMatch?.[1] || '',
    headCommitOid: headMatch?.[1] || '',
  };
}

/**
 * Format comment with GitHub suggestion syntax
 */
export function formatSuggestionComment(description: string, suggestedCode?: string): string {
  return suggestedCode ? `${description}\n\n\`\`\`suggestion\n${suggestedCode}\n\`\`\`` : description;
}

/**
 * Post a single-line comment
 */
export async function postLineComment(
  context: PRContext,
  path: string,
  line: number,
  body: string
): Promise<boolean> {
  if (!context.headCommitOid) return false;

  try {
    const response = await sendToBackground({
      type: 'POST_COMMENT',
      payload: {
        owner: context.owner,
        repo: context.repo,
        prNumber: context.prNumber,
        body,
        path,
        line,
        commitId: context.headCommitOid,
        side: 'RIGHT',
      },
    });
    return response.type === 'POST_COMMENT_RESULT' && response.payload.success;
  } catch {
    return false;
  }
}

/**
 * Post a multi-line comment
 */
export async function postMultiLineComment(
  context: PRContext,
  path: string,
  startLine: number,
  endLine: number,
  body: string
): Promise<boolean> {
  if (!context.headCommitOid) return false;

  try {
    const response = await sendToBackground({
      type: 'POST_COMMENT',
      payload: {
        owner: context.owner,
        repo: context.repo,
        prNumber: context.prNumber,
        body,
        path,
        line: endLine,
        commitId: context.headCommitOid,
        side: 'RIGHT',
        startLine,
        startSide: 'RIGHT',
      },
    });
    return response.type === 'POST_COMMENT_RESULT' && response.payload.success;
  } catch {
    return false;
  }
}

/**
 * Submit the review
 */
export async function submitReview(
  owner: string,
  repo: string,
  prNumber: number,
  event?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
  body?: string,
  commitId?: string
): Promise<{ success: boolean; url?: string; error?: string; isDraft?: boolean }> {
  try {
    const response = await sendToBackground({
      type: 'SUBMIT_REVIEW',
      payload: { owner, repo, prNumber, event, body, commitId },
    });

    if (response.type === 'SUBMIT_REVIEW_RESULT' && response.payload.success) {
      return { success: true, url: response.payload.url, isDraft: !event };
    }
    if (response.type === 'SUBMIT_REVIEW_ERROR') {
      return { success: false, error: response.payload.error };
    }
    return { success: false, error: 'Unknown error' };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
