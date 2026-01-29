/**
 * Orchestrator - Coordinate parallel provider execution
 *
 * Manages multiple AI providers, runs them in parallel, and coordinates
 * results through the consensus engine.
 */

import type { PRDiff, ExtensionSettings, ChangesSummaryResponse } from '../shared/types';
import type { AIProvider, ProviderName, ProviderSuggestion, ConsensusSuggestion } from './providers/types';
import type { RepoContext } from './context/types';
import { fetchRepoContext } from './context';
import { isDuplicateComment } from './context/comments';
import { ConsensusEngine, ConsensusCallbacks } from './consensus/engine';
import { geminiProvider } from './providers/gemini-provider';
import { claudeProvider } from './providers/claude-provider';
import { logger } from '../shared/logger';

const TAG = 'Orchestrator';

// All available providers
const ALL_PROVIDERS: AIProvider[] = [geminiProvider, claudeProvider];

export interface OrchestratorCallbacks {
  onSuggestion: (suggestion: ConsensusSuggestion) => void;
  onSuggestionUpdate: (id: string, suggestion: ConsensusSuggestion) => void;
  onSummary: (summary: ChangesSummaryResponse) => void;
  onProviderStarted: (provider: ProviderName) => void;
  onProviderCompleted: (provider: ProviderName, count: number) => void;
  onProviderError: (provider: ProviderName, error: string) => void;
  onComplete: (summary: string, assessment: string) => void;
  onError: (error: string) => void;
}

/**
 * Get list of enabled and configured providers
 */
export function getActiveProviders(settings: ExtensionSettings): AIProvider[] {
  const enabledProviders = settings.enabledProviders || ['gemini'];

  return ALL_PROVIDERS.filter(provider => {
    // Check if provider is in enabled list
    if (!enabledProviders.includes(provider.name)) {
      return false;
    }
    // Check if provider is configured
    return provider.isConfigured(settings);
  });
}

/**
 * Check if any providers are available
 */
export function hasAvailableProviders(settings: ExtensionSettings): boolean {
  return getActiveProviders(settings).length > 0;
}

/**
 * Get provider status for display
 */
export function getProviderStatus(settings: ExtensionSettings): {
  available: ProviderName[];
  configured: ProviderName[];
  enabled: ProviderName[];
} {
  const enabledProviders = settings.enabledProviders || ['gemini'];

  return {
    available: ALL_PROVIDERS.map(p => p.name),
    configured: ALL_PROVIDERS.filter(p => p.isConfigured(settings)).map(p => p.name),
    enabled: enabledProviders,
  };
}

/**
 * Orchestrate a review across multiple providers
 */
export async function orchestrateReview(
  diff: PRDiff,
  settings: ExtensionSettings,
  callbacks: OrchestratorCallbacks
): Promise<void> {
  const activeProviders = getActiveProviders(settings);

  if (activeProviders.length === 0) {
    callbacks.onError('No AI providers are configured. Please set up at least one API key in settings.');
    return;
  }

  logger.debug(TAG, `Starting orchestrated review with ${activeProviders.length} providers`, {
    providers: activeProviders.map(p => p.name),
  });

  // Fetch repo context if any context settings are enabled
  let repoContext: RepoContext | undefined;
  if (settings.includeRepoSummary || settings.includeRelatedFiles || settings.skipDiscussedIssues) {
    try {
      logger.debug(TAG, 'Fetching repo context');
      repoContext = await fetchRepoContext(diff, settings);
      logger.debug(TAG, 'Repo context fetched', {
        hasRepoSummary: !!repoContext.repoSummary,
        relatedFilesCount: repoContext.relatedFiles.length,
        existingCommentsCount: repoContext.existingComments.length,
        totalTokens: repoContext.tokenBudget.total,
      });
    } catch (error) {
      logger.warn(TAG, 'Failed to fetch repo context, continuing without it:', error);
    }
  }

  // Set up consensus engine
  const consensusCallbacks: ConsensusCallbacks = {
    onSuggestion: callbacks.onSuggestion,
    onSuggestionUpdate: callbacks.onSuggestionUpdate,
    onProviderStarted: callbacks.onProviderStarted,
    onProviderCompleted: callbacks.onProviderCompleted,
    onProviderError: callbacks.onProviderError,
    onComplete: callbacks.onComplete,
  };

  const consensus = new ConsensusEngine(activeProviders.length, consensusCallbacks);

  // Pass existing comments to consensus engine for deduplication
  if (repoContext && repoContext.existingComments.length > 0) {
    consensus.setExistingComments(repoContext.existingComments);
  }

  // Track if we've received at least one summary
  let summaryReceived = false;

  // Optimization: Generate summary once (preferably using Claude) and reuse
  let sharedSummary: ChangesSummaryResponse | undefined;
  
  try {
    // Prefer Claude for summary if available and configured
    const summaryProvider = activeProviders.find(p => p.name === 'claude') || activeProviders[0];
    
    if (summaryProvider && summaryProvider.generateSummary) {
      logger.debug(TAG, `Generating shared summary using ${summaryProvider.name}`);
      sharedSummary = await summaryProvider.generateSummary(diff, settings);
      
      // Send summary to UI immediately
      callbacks.onSummary(sharedSummary);
      summaryReceived = true;
      
      // Add summary to consensus engine
      consensus.addSummary(summaryProvider.name, sharedSummary.summary);
    }
  } catch (error) {
    logger.warn(TAG, 'Failed to generate shared summary, providers will generate their own:', error);
  }

  // Run all providers in parallel
  const providerPromises = activeProviders.map(async (provider) => {
    consensus.providerStarted(provider.name);

    try {
      await provider.streamReview(
        diff,
        settings,
        // onSuggestion - feed to consensus engine
        (suggestion: ProviderSuggestion) => {
          consensus.addSuggestion(suggestion);
        },
        // onSummary - forward to callback and store in consensus
        (summary: ChangesSummaryResponse) => {
          consensus.addSummary(provider.name, summary.summary);
          // Only send to UI if we haven't already (e.g. fallback if shared summary failed)
          if (!summaryReceived) {
            summaryReceived = true;
            callbacks.onSummary(summary);
          }
        },
        // onComplete - mark provider as done
        (assessment: string) => {
          consensus.providerCompleted(provider.name, assessment);
        },
        // onError - report provider error
        (error: string) => {
          consensus.providerError(provider.name, error);
        },
        // Pass repo context to provider
        repoContext,
        // Pass shared summary if available
        sharedSummary
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(TAG, `Provider ${provider.name} failed:`, errorMessage);
      consensus.providerError(provider.name, errorMessage);
    }
  });

  // Wait for all providers to complete (or fail)
  await Promise.allSettled(providerPromises);

  logger.debug(TAG, 'All providers completed');
}

/**
 * Run a single provider (for backwards compatibility or single-provider mode)
 */
export async function runSingleProvider(
  providerName: ProviderName,
  diff: PRDiff,
  settings: ExtensionSettings,
  callbacks: {
    onSuggestion: (suggestion: ProviderSuggestion) => void;
    onSummary: (summary: ChangesSummaryResponse) => void;
    onComplete: (summary: string, assessment: string) => void;
    onError: (error: string) => void;
  }
): Promise<void> {
  const provider = ALL_PROVIDERS.find(p => p.name === providerName);

  if (!provider) {
    callbacks.onError(`Unknown provider: ${providerName}`);
    return;
  }

  if (!provider.isConfigured(settings)) {
    callbacks.onError(`Provider ${providerName} is not configured. Please set up the API key in settings.`);
    return;
  }

  // Fetch repo context if any context settings are enabled
  let repoContext: RepoContext | undefined;
  if (settings.includeRepoSummary || settings.includeRelatedFiles || settings.skipDiscussedIssues) {
    try {
      repoContext = await fetchRepoContext(diff, settings);
    } catch (error) {
      logger.warn(TAG, 'Failed to fetch repo context:', error);
    }
  }

  let summary = '';

  await provider.streamReview(
    diff,
    settings,
    (suggestion) => {
      // Deduplicate against existing comments
      if (repoContext && repoContext.existingComments.length > 0) {
        if (isDuplicateComment(suggestion, repoContext.existingComments)) {
          logger.debug(TAG, `Skipping duplicate suggestion (matches existing comment)`, {
            file: suggestion.filePath,
            line: suggestion.lineNumber,
          });
          return;
        }
      }
      callbacks.onSuggestion(suggestion);
    },
    (summaryResponse) => {
      summary = summaryResponse.summary;
      callbacks.onSummary(summaryResponse);
    },
    (assessment) => {
      callbacks.onComplete(summary, assessment);
    },
    callbacks.onError,
    repoContext
  );
}
