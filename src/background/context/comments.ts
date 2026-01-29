/**
 * Comments - Fetch and parse existing PR comments
 *
 * Retrieves existing review comments from a PR to avoid
 * suggesting duplicate issues.
 */

import type { ExistingComment } from './types';
import { logger } from '../../shared/logger';
import { GITHUB_API_URL } from '../../shared/constants';

const TAG = 'Comments';

// Categories to detect in comment text
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  security: ['security', 'vulnerability', 'injection', 'xss', 'csrf', 'auth', 'password', 'secret', 'credential', 'sanitize', 'escape'],
  performance: ['performance', 'slow', 'optimize', 'cache', 'memory', 'leak', 'n+1', 'complexity', 'efficient'],
  style: ['style', 'naming', 'convention', 'format', 'indent', 'spacing', 'lint', 'prettier', 'eslint'],
  logic: ['logic', 'bug', 'error', 'wrong', 'incorrect', 'fix', 'issue', 'problem', 'broken', 'race condition', 'null'],
  best_practice: ['best practice', 'pattern', 'refactor', 'clean', 'dry', 'solid', 'maintainable', 'readable'],
  documentation: ['document', 'comment', 'jsdoc', 'readme', 'explain', 'describe'],
};

/**
 * Fetch all review comments for a PR
 */
export async function fetchExistingComments(
  owner: string,
  repo: string,
  prNumber: number,
  githubToken?: string
): Promise<ExistingComment[]> {
  logger.debug(TAG, 'Fetching existing comments', { owner, repo, prNumber });

  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
  };
  if (githubToken) {
    headers['Authorization'] = `Bearer ${githubToken}`;
  }

  const comments: ExistingComment[] = [];

  try {
    // Fetch review comments (inline comments on specific lines)
    const reviewCommentsUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/pulls/${prNumber}/comments`;
    const reviewCommentsResponse = await fetch(reviewCommentsUrl, { headers });

    if (reviewCommentsResponse.ok) {
      const reviewComments = await reviewCommentsResponse.json();
      for (const comment of reviewComments) {
        comments.push(parseReviewComment(comment));
      }
    }

    // Fetch issue comments (general PR comments, not inline)
    const issueCommentsUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/issues/${prNumber}/comments`;
    const issueCommentsResponse = await fetch(issueCommentsUrl, { headers });

    if (issueCommentsResponse.ok) {
      const issueComments = await issueCommentsResponse.json();
      for (const comment of issueComments) {
        // Issue comments don't have file/line info
        comments.push(parseIssueComment(comment));
      }
    }

    // Fetch reviews (to get review body comments)
    const reviewsUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
    const reviewsResponse = await fetch(reviewsUrl, { headers });

    if (reviewsResponse.ok) {
      const reviews = await reviewsResponse.json();
      for (const review of reviews) {
        if (review.body && review.body.trim()) {
          comments.push(parseReviewBody(review));
        }
      }
    }

    logger.debug(TAG, 'Fetched comments', { count: comments.length });
    return comments;
  } catch (error) {
    logger.error(TAG, 'Failed to fetch comments:', error);
    return [];
  }
}

/**
 * Parse a review comment (inline comment)
 */
function parseReviewComment(comment: any): ExistingComment {
  const body = comment.body || '';
  return {
    id: comment.id,
    path: comment.path || '',
    line: comment.line || comment.original_line || 0,
    body,
    author: comment.user?.login || 'unknown',
    createdAt: comment.created_at,
    category: detectCategory(body),
    summary: extractSummary(body),
  };
}

/**
 * Parse an issue comment (general comment)
 */
function parseIssueComment(comment: any): ExistingComment {
  const body = comment.body || '';
  return {
    id: comment.id,
    path: '', // Issue comments don't have path
    line: 0, // Issue comments don't have line
    body,
    author: comment.user?.login || 'unknown',
    createdAt: comment.created_at,
    category: detectCategory(body),
    summary: extractSummary(body),
  };
}

/**
 * Parse a review body
 */
function parseReviewBody(review: any): ExistingComment {
  const body = review.body || '';
  return {
    id: review.id,
    path: '', // Review body doesn't have specific path
    line: 0,
    body,
    author: review.user?.login || 'unknown',
    createdAt: review.submitted_at,
    category: detectCategory(body),
    summary: extractSummary(body),
  };
}

/**
 * Detect the category of a comment based on keywords
 */
function detectCategory(body: string): string | undefined {
  const lowerBody = body.toLowerCase();

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lowerBody.includes(keyword)) {
        return category;
      }
    }
  }

  return undefined;
}

/**
 * Extract a brief summary from comment body
 */
function extractSummary(body: string): string {
  // Remove code blocks
  let summary = body.replace(/```[\s\S]*?```/g, '');

  // Remove inline code
  summary = summary.replace(/`[^`]+`/g, '');

  // Remove markdown links but keep text
  summary = summary.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Remove extra whitespace
  summary = summary.replace(/\s+/g, ' ').trim();

  // Take first sentence or first 100 chars
  const firstSentence = summary.match(/^[^.!?]+[.!?]?/);
  if (firstSentence && firstSentence[0].length <= 150) {
    return firstSentence[0].trim();
  }

  // Truncate if too long
  if (summary.length > 100) {
    return summary.substring(0, 100) + '...';
  }

  return summary;
}

/**
 * Check if a new suggestion might be a duplicate of an existing comment
 */
export function isDuplicateComment(
  suggestion: { filePath: string; lineNumber: number; category: string; description: string },
  existingComments: ExistingComment[],
  lineThreshold: number = 5
): boolean {
  for (const comment of existingComments) {
    // Check if on same file and nearby line
    if (comment.path && comment.path === suggestion.filePath) {
      if (Math.abs(comment.line - suggestion.lineNumber) <= lineThreshold) {
        // Check if similar category
        if (comment.category === suggestion.category) {
          return true;
        }

        // Check for keyword overlap in description
        const suggestionWords = new Set(suggestion.description.toLowerCase().split(/\s+/));
        const commentWords = new Set(comment.body.toLowerCase().split(/\s+/));
        const overlap = [...suggestionWords].filter(w => commentWords.has(w) && w.length > 3);

        if (overlap.length >= 3) {
          return true;
        }
      }
    }

    // For general comments (no path), check for semantic similarity
    if (!comment.path && comment.summary) {
      const summaryWords = new Set(comment.summary.toLowerCase().split(/\s+/));
      const descWords = new Set(suggestion.description.toLowerCase().split(/\s+/));
      const overlap = [...summaryWords].filter(w => descWords.has(w) && w.length > 4);

      if (overlap.length >= 4) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Format existing comments for prompt inclusion
 */
export function formatCommentsForPrompt(comments: ExistingComment[]): string {
  if (comments.length === 0) {
    return '';
  }

  const fileComments = comments.filter(c => c.path);
  const generalComments = comments.filter(c => !c.path);

  const parts: string[] = ['Issues Already Discussed in This PR:'];

  // Format file-specific comments
  for (const comment of fileComments.slice(0, 20)) {
    const category = comment.category ? `[${comment.category}]` : '';
    const location = `${comment.path}:${comment.line}`;
    parts.push(`- ${category} ${location} - "${comment.summary}" (by @${comment.author})`);
  }

  // Format general comments
  if (generalComments.length > 0) {
    parts.push('\nGeneral Discussion:');
    for (const comment of generalComments.slice(0, 10)) {
      const category = comment.category ? `[${comment.category}]` : '';
      parts.push(`- ${category} "${comment.summary}" (by @${comment.author})`);
    }
  }

  parts.push('\nDo NOT repeat these issues. Focus on NEW insights not yet discussed.');

  return parts.join('\n');
}
