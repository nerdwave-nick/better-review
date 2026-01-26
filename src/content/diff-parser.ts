import parseDiff from 'parse-diff';
import type { PRDiff, FileDiff } from '../shared/types';
import { sendToBackground } from '../shared/messages';
import { extractPRFromUrl } from '../shared/utils';
import { LOG_TAGS } from '../shared/constants';
import { logger } from '../shared/logger';

const TAG = LOG_TAGS.DIFF_PARSER;

/**
 * Extracts PR metadata from the current GitHub PR page URL
 */
export function extractPRMetadata(): { owner: string; repo: string; prNumber: number } | null {
  return extractPRFromUrl();
}

/**
 * Extracts PR title and description from the page
 */
function extractPRDetails(): { title: string; description: string; baseBranch: string; headBranch: string } {
  const titleElement = document.querySelector('.js-issue-title, .markdown-title, [data-testid="issue-title"]');
  const title = titleElement?.textContent?.trim() || '';

  const descriptionElement = document.querySelector('.comment-body, [data-testid="issue-body"]');
  const description = descriptionElement?.textContent?.trim() || '';

  const baseBranch = document.querySelector('.base-ref, [data-testid="base-ref"]')?.textContent?.trim() || 'main';
  const headBranch = document.querySelector('.head-ref, [data-testid="head-ref"]')?.textContent?.trim() || '';

  return { title, description, baseBranch, headBranch };
}

/**
 * Convert parse-diff output to our FileDiff format
 */
function convertToFileDiff(parsed: parseDiff.File[]): FileDiff[] {
  return parsed.map(file => {
    const status = file.new ? 'added' : file.deleted ? 'removed' : file.from !== file.to ? 'renamed' : 'modified';

    return {
      path: file.to || file.from || '',
      status,
      isBinary: (file as parseDiff.File & { binary?: boolean }).binary || false,
      hunks: (file.chunks || []).map(chunk => ({
        oldStart: chunk.oldStart,
        oldLines: chunk.oldLines,
        newStart: chunk.newStart,
        newLines: chunk.newLines,
        lines: chunk.changes.map(change => {
          const c = change as parseDiff.Change & { ln?: number; ln1?: number; ln2?: number };
          return {
            type: change.type === 'add' ? 'added' : change.type === 'del' ? 'removed' : 'context',
            content: change.content.substring(1), // Remove +/- prefix
            oldLineNumber: change.type !== 'add' ? (c.ln ?? c.ln1 ?? null) : null,
            newLineNumber: change.type !== 'del' ? (c.ln ?? c.ln2 ?? null) : null,
          };
        }),
      })),
    };
  });
}

/**
 * Fetches PR diff via background service worker (avoids CORS)
 */
export async function extractPRDiff(): Promise<PRDiff | null> {
  const metadata = extractPRMetadata();
  if (!metadata) return null;

  try {
    logger.debug(TAG, 'Requesting diff via background...');

    const response = await sendToBackground({
      type: 'FETCH_DIFF',
      payload: metadata,
    });

    if (response.type === 'DIFF_ERROR') {
      throw new Error(response.payload.error);
    }

    if (response.type !== 'DIFF_RESULT') {
      throw new Error('Unexpected response type');
    }

    const parsed = parseDiff(response.payload.diffText);
    const files = convertToFileDiff(parsed);
    const details = extractPRDetails();

    logger.debug(TAG, 'Parsed', files.length, 'files');

    return {
      ...metadata,
      ...details,
      files,
    };
  } catch (error) {
    logger.error(TAG, 'Error fetching diff:', error);
    return null;
  }
}
