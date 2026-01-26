import type { PRDiff, FileDiff, DiffHunk } from '../shared/types';
import { sendToBackground } from '../shared/messages';

/**
 * Extracts PR metadata from the current GitHub PR page URL
 */
export function extractPRMetadata(): { owner: string; repo: string; prNumber: number } | null {
  const match = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;

  return {
    owner: match[1],
    repo: match[2],
    prNumber: parseInt(match[3], 10),
  };
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
 * Parse a unified diff string into FileDiff array
 */
function parseUnifiedDiff(diffText: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = diffText.split('\n');

  let currentFile: FileDiff | null = null;
  let currentHunk: DiffHunk | null = null;
  let currentOldLine = 0;
  let currentNewLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // New file: diff --git a/path b/path
    if (line.startsWith('diff --git')) {
      if (currentFile) {
        if (currentHunk) {
          currentFile.hunks.push(currentHunk);
          currentHunk = null;
        }
        files.push(currentFile);
      }

      const match = line.match(/diff --git a\/(.+) b\/(.+)/);
      const path = match ? match[2] : '';

      currentFile = {
        path,
        status: 'modified',
        hunks: [],
        isBinary: false,
      };
      continue;
    }

    if (!currentFile) continue;

    // File status
    if (line.startsWith('new file')) {
      currentFile.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file')) {
      currentFile.status = 'removed';
      continue;
    }
    if (line.startsWith('rename from') || line.startsWith('rename to')) {
      currentFile.status = 'renamed';
      continue;
    }
    if (line.startsWith('Binary files')) {
      currentFile.isBinary = true;
      continue;
    }

    // Skip --- and +++ lines
    if (line.startsWith('---') || line.startsWith('+++')) {
      continue;
    }

    // Hunk header: @@ -oldStart,oldLines +newStart,newLines @@
    if (line.startsWith('@@')) {
      if (currentHunk) {
        currentFile.hunks.push(currentHunk);
      }

      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        currentHunk = {
          oldStart: parseInt(match[1], 10),
          oldLines: match[2] ? parseInt(match[2], 10) : 1,
          newStart: parseInt(match[3], 10),
          newLines: match[4] ? parseInt(match[4], 10) : 1,
          lines: [],
        };
        // Initialize line counters for this hunk
        currentOldLine = currentHunk.oldStart;
        currentNewLine = currentHunk.newStart;
      }
      continue;
    }

    // Diff lines - use tracked line numbers
    if (currentHunk) {
      if (line.startsWith('+')) {
        currentHunk.lines.push({
          type: 'added',
          content: line.substring(1),
          oldLineNumber: null,
          newLineNumber: currentNewLine,
        });
        currentNewLine++;
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({
          type: 'removed',
          content: line.substring(1),
          oldLineNumber: currentOldLine,
          newLineNumber: null,
        });
        currentOldLine++;
      } else if (line.startsWith(' ') || line === '') {
        currentHunk.lines.push({
          type: 'context',
          content: line.substring(1),
          oldLineNumber: currentOldLine,
          newLineNumber: currentNewLine,
        });
        currentOldLine++;
        currentNewLine++;
      }
    }
  }

  // Save last file
  if (currentFile) {
    if (currentHunk) {
      currentFile.hunks.push(currentHunk);
    }
    files.push(currentFile);
  }

  return files;
}

/**
 * Fetches PR diff via background service worker (avoids CORS)
 */
export async function extractPRDiff(): Promise<PRDiff | null> {
  const metadata = extractPRMetadata();
  if (!metadata) return null;

  try {
    console.log('[PR AI Review] Requesting diff via background...');

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

    const files = parseUnifiedDiff(response.payload.diffText);
    const details = extractPRDetails();

    console.log('[PR AI Review] Parsed', files.length, 'files');

    return {
      ...metadata,
      ...details,
      files,
    };
  } catch (error) {
    console.error('[PR AI Review] Error fetching diff:', error);
    return null;
  }
}
