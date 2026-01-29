/**
 * Consensus Engine - Merge and score suggestions from multiple providers
 *
 * Collects suggestions from multiple AI providers, groups similar ones,
 * merges them with confidence scoring, and emits consensus suggestions.
 */

import type { ProviderName, ProviderSuggestion, ConsensusSuggestion } from '../providers/types';
import type { ExistingComment } from '../context/types';
import { groupBySimilarity, calculateSimilarity, MERGE_THRESHOLD } from './similarity';
import { isDuplicateComment } from '../context/comments';
import { logger } from '../../shared/logger';

const TAG = 'Consensus';

// Debounce window in milliseconds for collecting suggestions
const DEBOUNCE_WINDOW_MS = 500;

// Priority order for merging (higher priority wins)
const PRIORITY_ORDER: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

export interface ConsensusCallbacks {
  onSuggestion: (suggestion: ConsensusSuggestion) => void;
  onSuggestionUpdate: (id: string, suggestion: ConsensusSuggestion) => void;
  onProviderStarted: (provider: ProviderName) => void;
  onProviderCompleted: (provider: ProviderName, count: number) => void;
  onProviderError: (provider: ProviderName, error: string) => void;
  onComplete: (summary: string, assessment: string) => void;
}

/**
 * Calculate confidence based on how many providers agree
 */
function calculateConfidence(
  providers: ProviderName[],
  totalProviders: number
): { confidence: number; level: 'high' | 'medium' | 'low' } {
  const providerCount = providers.length;

  if (totalProviders === 1) {
    // Single provider mode - slightly lower confidence
    return { confidence: 0.6, level: 'medium' };
  }

  if (providerCount === 1) {
    return { confidence: 0.4, level: 'low' };
  }

  if (providerCount === 2) {
    return { confidence: 0.75, level: 'medium' };
  }

  // All providers agree (3+)
  return { confidence: 0.9, level: 'high' };
}

/**
 * Merge a group of similar suggestions into a single consensus suggestion
 */
function mergeSuggestions(
  group: ProviderSuggestion[],
  totalProviders: number
): ConsensusSuggestion {
  // Get unique providers
  const providers = [...new Set(group.map(s => s.providerId))];
  const { confidence, level } = calculateConfidence(providers, totalProviders);

  // Use the highest priority suggestion as the base
  const sorted = [...group].sort((a, b) =>
    (PRIORITY_ORDER[b.priority] || 0) - (PRIORITY_ORDER[a.priority] || 0)
  );
  const base = sorted[0];

  // Calculate expanded line range to cover all suggestions
  let startLine = base.lineNumber;
  let endLine = base.lineNumber;

  for (const s of group) {
    const sStart = s.lineRange?.start ?? s.lineNumber;
    const sEnd = s.lineRange?.end ?? s.lineNumber;
    startLine = Math.min(startLine, sStart);
    endLine = Math.max(endLine, sEnd);
  }

  // Collect descriptions from each provider
  const providerDescriptions: Partial<Record<ProviderName, string>> = {};
  for (const s of group) {
    providerDescriptions[s.providerId] = s.description;
  }

  // Use the longest/most detailed description
  const bestDescription = group.reduce((best, s) =>
    s.description.length > best.length ? s.description : best,
    base.description
  );

  // Prefer suggested code from higher priority suggestions
  const suggestedCode = sorted.find(s => s.suggestedCode)?.suggestedCode;

  return {
    id: `consensus_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    filePath: base.filePath,
    lineNumber: startLine,
    lineRange: startLine !== endLine ? { start: startLine, end: endLine } : undefined,
    priority: base.priority,
    type: base.type,
    description: bestDescription,
    suggestedCode,
    category: base.category,
    confidence,
    confidenceLevel: level,
    contributingProviders: providers,
    providerCount: providers.length,
    providerDescriptions,
  };
}

export class ConsensusEngine {
  private totalProviders: number;
  private callbacks: ConsensusCallbacks;
  private pendingSuggestions: ProviderSuggestion[] = [];
  private emittedSuggestions: Map<string, ConsensusSuggestion> = new Map();
  private providerCounts: Map<ProviderName, number> = new Map();
  private completedProviders = new Set<ProviderName>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private summaries: Map<ProviderName, string> = new Map();
  private assessments: Map<ProviderName, string> = new Map();
  private isFinalized = false;
  private existingComments: ExistingComment[] = [];
  private visibleSuggestionIds = new Set<string>();

  constructor(totalProviders: number, callbacks: ConsensusCallbacks) {
    this.totalProviders = totalProviders;
    this.callbacks = callbacks;
  }

  /**
   * Set existing comments for deduplication
   */
  setExistingComments(comments: ExistingComment[]): void {
    this.existingComments = comments;
  }

  /**
   * Add a suggestion from a provider
   */
  addSuggestion(suggestion: ProviderSuggestion): void {
    if (this.isFinalized) return;

    this.pendingSuggestions.push(suggestion);

    // Update provider count
    const count = (this.providerCounts.get(suggestion.providerId) || 0) + 1;
    this.providerCounts.set(suggestion.providerId, count);

    // Debounce processing to allow similar suggestions to arrive
    this.scheduleProcessing();
  }

  /**
   * Schedule debounced processing of pending suggestions
   */
  private scheduleProcessing(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.processPendingSuggestions();
    }, DEBOUNCE_WINDOW_MS);
  }

  /**
   * Process all pending suggestions
   */
  private processPendingSuggestions(): void {
    if (this.pendingSuggestions.length === 0) return;

    // Group similar suggestions
    const groups = groupBySimilarity(this.pendingSuggestions);

    for (const group of groups) {
      this.processGroup(group);
    }

    // Clear pending suggestions after processing
    this.pendingSuggestions = [];
  }

  /**
   * Process a group of similar suggestions
   */
  private processGroup(group: ProviderSuggestion[]): void {
    // Create merged consensus suggestion
    const consensus = mergeSuggestions(group, this.totalProviders);

    // Check if this matches any existing PR comments (deduplication)
    if (isDuplicateComment(consensus, this.existingComments)) {
      logger.debug(TAG, `Skipping duplicate suggestion (matches existing comment)`, {
        file: consensus.filePath,
        line: consensus.lineNumber,
        category: consensus.category
      });
      return;
    }

    // Check if this updates an existing suggestion
    const existingKey = this.findExistingMatch(consensus);

    if (existingKey) {
      // Update existing suggestion with new confidence/providers
      const existing = this.emittedSuggestions.get(existingKey)!;
      const updated = this.mergeWithExisting(existing, consensus);
      this.emittedSuggestions.set(existingKey, updated);

      // Determine visibility
      const shouldBeVisible = this.shouldShowSuggestion(updated);
      const wasVisible = this.visibleSuggestionIds.has(existingKey);

      if (shouldBeVisible) {
        if (wasVisible) {
          // It was already visible, just update it
          this.callbacks.onSuggestionUpdate(existingKey, updated);
          logger.debug(TAG, `Updated suggestion ${existingKey}`, {
            providers: updated.contributingProviders,
            confidence: updated.confidence,
          });
        } else {
          // It was hidden, now it's visible (e.g. gained consensus) -> Emit as new
          this.visibleSuggestionIds.add(existingKey);
          this.callbacks.onSuggestion(updated);
          logger.debug(TAG, `Revealed hidden suggestion ${existingKey} (now has consensus)`, {
            providers: updated.contributingProviders,
          });
        }
      } else {
         logger.debug(TAG, `Updated hidden suggestion ${existingKey} (still hidden)`, {
            providers: updated.contributingProviders,
         });
      }
    } else {
      // New suggestion
      this.emittedSuggestions.set(consensus.id, consensus);

      // Determine visibility
      const shouldBeVisible = this.shouldShowSuggestion(consensus);

      if (shouldBeVisible) {
        this.visibleSuggestionIds.add(consensus.id);
        this.callbacks.onSuggestion(consensus);
        logger.debug(TAG, `New consensus suggestion`, {
          id: consensus.id,
          file: consensus.filePath,
          line: consensus.lineNumber,
          providers: consensus.contributingProviders,
          confidence: consensus.confidence,
        });
      } else {
        logger.debug(TAG, `Hidden suggestion (waiting for consensus)`, {
          id: consensus.id,
          priority: consensus.priority,
        });
      }
    }
  }

  /**
   * Determine if a suggestion should be shown to the user
   */
  private shouldShowSuggestion(suggestion: ConsensusSuggestion): boolean {
    // In single provider mode, show everything
    if (this.totalProviders <= 1) return true;

    // Show if High Priority (Critical)
    if (suggestion.priority === 'high') return true;

    // Show if Consensus reached (more than 1 provider)
    if (suggestion.providerCount > 1) return true;

    // Otherwise hide (Medium/Low with no consensus)
    return false;
  }

  /**
   * Find an existing suggestion that matches the new consensus
   */
  private findExistingMatch(consensus: ConsensusSuggestion): string | null {
    for (const [key, existing] of this.emittedSuggestions) {
      // Create dummy ProviderSuggestion for comparison
      const existingAsSuggestion: ProviderSuggestion = {
        ...existing,
        providerId: existing.contributingProviders[0],
      };
      const consensusAsSuggestion: ProviderSuggestion = {
        ...consensus,
        providerId: consensus.contributingProviders[0],
      };

      const similarity = calculateSimilarity(existingAsSuggestion, consensusAsSuggestion);
      if (similarity >= MERGE_THRESHOLD) {
        return key;
      }
    }
    return null;
  }

  /**
   * Merge a new consensus with an existing emitted suggestion
   */
  private mergeWithExisting(
    existing: ConsensusSuggestion,
    newConsensus: ConsensusSuggestion
  ): ConsensusSuggestion {
    // Combine providers
    const allProviders = [...new Set([
      ...existing.contributingProviders,
      ...newConsensus.contributingProviders,
    ])];

    const { confidence, level } = calculateConfidence(allProviders, this.totalProviders);

    // Expand line range
    const startLine = Math.min(
      existing.lineRange?.start ?? existing.lineNumber,
      newConsensus.lineRange?.start ?? newConsensus.lineNumber
    );
    const endLine = Math.max(
      existing.lineRange?.end ?? existing.lineNumber,
      newConsensus.lineRange?.end ?? newConsensus.lineNumber
    );

    // Merge provider descriptions
    const providerDescriptions: Partial<Record<ProviderName, string>> = {
      ...existing.providerDescriptions,
      ...newConsensus.providerDescriptions,
    };

    // Use higher priority
    const priority = PRIORITY_ORDER[existing.priority] >= PRIORITY_ORDER[newConsensus.priority]
      ? existing.priority
      : newConsensus.priority;

    // Use longer description
    const description = existing.description.length >= newConsensus.description.length
      ? existing.description
      : newConsensus.description;

    return {
      ...existing,
      lineRange: startLine !== endLine ? { start: startLine, end: endLine } : undefined,
      priority,
      description,
      suggestedCode: existing.suggestedCode || newConsensus.suggestedCode,
      confidence,
      confidenceLevel: level,
      contributingProviders: allProviders,
      providerCount: allProviders.length,
      providerDescriptions,
    };
  }

  /**
   * Mark a provider as started
   */
  providerStarted(provider: ProviderName): void {
    this.callbacks.onProviderStarted(provider);
  }

  /**
   * Mark a provider as completed
   */
  providerCompleted(provider: ProviderName, assessment?: string): void {
    if (this.completedProviders.has(provider)) return;

    this.completedProviders.add(provider);
    const count = this.providerCounts.get(provider) || 0;
    this.callbacks.onProviderCompleted(provider, count);

    if (assessment) {
      this.assessments.set(provider, assessment);
    }

    logger.debug(TAG, `Provider ${provider} completed`, { count });

    // Check if all providers are done
    if (this.completedProviders.size >= this.totalProviders) {
      this.finalize();
    }
  }

  /**
   * Handle provider error
   */
  providerError(provider: ProviderName, error: string): void {
    this.callbacks.onProviderError(provider, error);

    // Mark as completed (with error)
    if (!this.completedProviders.has(provider)) {
      this.completedProviders.add(provider);

      // Check if all providers are done
      if (this.completedProviders.size >= this.totalProviders) {
        this.finalize();
      }
    }
  }

  /**
   * Store summary from a provider
   */
  addSummary(provider: ProviderName, summary: string): void {
    this.summaries.set(provider, summary);
  }

  /**
   * Finalize the consensus process
   */
  private finalize(): void {
    if (this.isFinalized) return;
    this.isFinalized = true;

    // Process any remaining pending suggestions
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.processPendingSuggestions();

    // Determine final assessment (request_changes if ANY provider says so)
    let finalAssessment = 'comment';
    for (const assessment of this.assessments.values()) {
      if (assessment === 'request_changes') {
        finalAssessment = 'request_changes';
        break;
      }
      if (assessment === 'approve' && finalAssessment !== 'request_changes') {
        finalAssessment = 'approve';
      }
    }

    // Use the first available summary (prefer the one with most detail)
    const summaryEntries = [...this.summaries.entries()];
    const bestSummary = summaryEntries.reduce(
      (best, [_, summary]) => summary.length > best.length ? summary : best,
      summaryEntries[0]?.[1] || 'Review complete.'
    );

    logger.debug(TAG, 'Consensus finalized', {
      totalSuggestions: this.emittedSuggestions.size,
      providers: [...this.completedProviders],
      assessment: finalAssessment,
    });

    this.callbacks.onComplete(bestSummary, finalAssessment);
  }

  /**
   * Force immediate processing and finalization
   */
  flush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.processPendingSuggestions();
    this.finalize();
  }
}
