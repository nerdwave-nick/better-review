/**
 * Provider Types - Shared interfaces for AI providers
 */

import type { ReviewSuggestion, PRDiff, ExtensionSettings, ChangesSummaryResponse } from '../../shared/types';
import type { RepoContext } from '../context/types';

// Supported AI providers
export type ProviderName = 'gemini' | 'claude';

// Suggestion with provider attribution
export interface ProviderSuggestion extends ReviewSuggestion {
  providerId: ProviderName;
}

// Consensus suggestion with confidence scoring
export interface ConsensusSuggestion extends ReviewSuggestion {
  confidence: number; // 0.0-1.0
  confidenceLevel: 'high' | 'medium' | 'low';
  contributingProviders: ProviderName[];
  providerCount: number;
  // Original descriptions from each provider (for tooltip/details)
  providerDescriptions?: Partial<Record<ProviderName, string>>;
}

// Changes summary with provider attribution
export interface ProviderSummary extends ChangesSummaryResponse {
  providerId: ProviderName;
}

// AI Provider interface
export interface AIProvider {
  name: ProviderName;

  /**
   * Check if this provider is configured and ready to use
   */
  isConfigured(settings: ExtensionSettings): boolean;

  /**
   * Generate a summary of changes (Phase 1)
   */
  generateSummary?(
    diff: PRDiff,
    settings: ExtensionSettings
  ): Promise<ChangesSummaryResponse>;

  /**
   * Stream a code review for the given diff
   */
  streamReview(
    diff: PRDiff,
    settings: ExtensionSettings,
    onSuggestion: (suggestion: ProviderSuggestion) => void,
    onSummary: (summary: ChangesSummaryResponse) => void,
    onComplete: (assessment: string) => void,
    onError: (error: string) => void,
    repoContext?: RepoContext,
    existingSummary?: ChangesSummaryResponse // Optimization: Use pre-generated summary
  ): Promise<void>;
}

// Provider status for UI updates
export interface ProviderStatus {
  provider: ProviderName;
  status: 'pending' | 'running' | 'completed' | 'error';
  suggestionCount?: number;
  error?: string;
}
