/**
 * Context Orchestrator - Coordinate fetching of all context types
 *
 * Fetches repo summary, related files, and existing comments
 * based on settings.
 */

import type { RepoContext, ContextSettings } from './types';
import { DEFAULT_CONTEXT_SETTINGS } from './types';
import type { PRDiff, ExtensionSettings } from '../../shared/types';
import { fetchRepoSummary, formatRepoSummaryForPrompt } from './repo-summary';
import { fetchRelatedFiles, formatRelatedFilesForPrompt } from './related-files';
import { fetchExistingComments, formatCommentsForPrompt } from './comments';
import { logger } from '../../shared/logger';

const TAG = 'Context';

// Re-export types and functions
export * from './types';
export { formatRepoSummaryForPrompt } from './repo-summary';
export { formatRelatedFilesForPrompt } from './related-files';
export { formatCommentsForPrompt, isDuplicateComment } from './comments';

// Rough token estimation (4 chars ~= 1 token)
const CHARS_PER_TOKEN = 4;

/**
 * Fetch all context for a PR review
 */
export async function fetchRepoContext(
  diff: PRDiff,
  settings: ExtensionSettings
): Promise<RepoContext> {
  const contextSettings = getContextSettings(settings);

  logger.debug(TAG, 'Fetching repo context', {
    owner: diff.owner,
    repo: diff.repo,
    prNumber: diff.prNumber,
    settings: contextSettings,
  });

  const context: RepoContext = {
    relatedFiles: [],
    existingComments: [],
    tokenBudget: {
      repoSummary: 0,
      relatedFiles: 0,
      existingComments: 0,
      total: 0,
    },
  };

  // Fetch all context in parallel
  const promises: Promise<void>[] = [];

  // Fetch repo summary
  if (contextSettings.includeRepoSummary) {
    promises.push(
      fetchRepoSummary(diff.owner, diff.repo, settings.githubToken)
        .then(summary => {
          if (summary) {
            context.repoSummary = summary;
            context.tokenBudget.repoSummary = estimateTokens(
              formatRepoSummaryForPrompt(summary)
            );
          }
        })
        .catch(e => logger.warn(TAG, 'Failed to fetch repo summary:', e))
    );
  }

  // Fetch related files
  if (contextSettings.includeRelatedFiles) {
    promises.push(
      fetchRelatedFiles(
        diff.owner,
        diff.repo,
        diff.baseBranch,
        diff.files,
        settings.githubToken,
        contextSettings.maxRelatedFiles
      )
        .then(files => {
          context.relatedFiles = files;
          context.tokenBudget.relatedFiles = estimateTokens(
            formatRelatedFilesForPrompt(files)
          );
        })
        .catch(e => logger.warn(TAG, 'Failed to fetch related files:', e))
    );
  }

  // Fetch existing comments
  if (contextSettings.skipDiscussedIssues) {
    promises.push(
      fetchExistingComments(
        diff.owner,
        diff.repo,
        diff.prNumber,
        settings.githubToken
      )
        .then(comments => {
          context.existingComments = comments;
          context.tokenBudget.existingComments = estimateTokens(
            formatCommentsForPrompt(comments)
          );
        })
        .catch(e => logger.warn(TAG, 'Failed to fetch existing comments:', e))
    );
  }

  // Wait for all fetches to complete
  await Promise.all(promises);

  // Calculate total tokens
  context.tokenBudget.total =
    context.tokenBudget.repoSummary +
    context.tokenBudget.relatedFiles +
    context.tokenBudget.existingComments;

  logger.debug(TAG, 'Context fetched', {
    hasRepoSummary: !!context.repoSummary,
    relatedFilesCount: context.relatedFiles.length,
    existingCommentsCount: context.existingComments.length,
    totalTokens: context.tokenBudget.total,
  });

  // Trim context if over budget
  if (context.tokenBudget.total > contextSettings.maxTokensForContext) {
    trimContext(context, contextSettings.maxTokensForContext);
  }

  return context;
}

/**
 * Extract context settings from extension settings
 */
function getContextSettings(settings: ExtensionSettings): ContextSettings {
  return {
    includeRepoSummary: settings.includeRepoSummary ?? DEFAULT_CONTEXT_SETTINGS.includeRepoSummary,
    includeRelatedFiles: settings.includeRelatedFiles ?? DEFAULT_CONTEXT_SETTINGS.includeRelatedFiles,
    skipDiscussedIssues: settings.skipDiscussedIssues ?? DEFAULT_CONTEXT_SETTINGS.skipDiscussedIssues,
    maxRelatedFiles: DEFAULT_CONTEXT_SETTINGS.maxRelatedFiles,
    maxTokensForContext: DEFAULT_CONTEXT_SETTINGS.maxTokensForContext,
  };
}

/**
 * Estimate token count from text
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Trim context to fit within token budget
 */
function trimContext(context: RepoContext, maxTokens: number): void {
  // Priority: existing comments > repo summary > related files
  // (comments are most important for deduplication)

  while (context.tokenBudget.total > maxTokens && context.relatedFiles.length > 0) {
    // Remove related files one by one
    const removed = context.relatedFiles.pop();
    if (removed) {
      const removedTokens = estimateTokens(removed.content);
      context.tokenBudget.relatedFiles -= removedTokens;
      context.tokenBudget.total -= removedTokens;
    }
  }

  // If still over budget, truncate repo summary
  if (context.tokenBudget.total > maxTokens && context.repoSummary?.readmeSummary) {
    const excessTokens = context.tokenBudget.total - maxTokens;
    const excessChars = excessTokens * CHARS_PER_TOKEN;

    if (context.repoSummary.readmeSummary.length > excessChars) {
      context.repoSummary.readmeSummary = context.repoSummary.readmeSummary.substring(
        0,
        context.repoSummary.readmeSummary.length - excessChars
      ) + '\n[... truncated ...]';

      context.tokenBudget.repoSummary = estimateTokens(
        formatRepoSummaryForPrompt(context.repoSummary)
      );
      context.tokenBudget.total =
        context.tokenBudget.repoSummary +
        context.tokenBudget.relatedFiles +
        context.tokenBudget.existingComments;
    }
  }

  logger.debug(TAG, 'Context trimmed', {
    relatedFilesCount: context.relatedFiles.length,
    totalTokens: context.tokenBudget.total,
  });
}

/**
 * Format full context for prompt inclusion
 */
export function formatContextForPrompt(context: RepoContext): string {
  const parts: string[] = [];

  if (context.repoSummary) {
    parts.push(formatRepoSummaryForPrompt(context.repoSummary));
  }

  if (context.relatedFiles.length > 0) {
    parts.push('\n' + formatRelatedFilesForPrompt(context.relatedFiles));
  }

  if (context.existingComments.length > 0) {
    parts.push('\n' + formatCommentsForPrompt(context.existingComments));
  }

  return parts.join('\n');
}
