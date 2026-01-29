/**
 * Similarity Matching - Algorithm for matching suggestions across providers
 *
 * Calculates similarity scores between suggestions from different providers
 * to determine if they should be merged.
 */

import type { ProviderSuggestion } from '../providers/types';

// Merge threshold - suggestions with similarity >= this value will be merged
// Lowered to catch more semantic duplicates even if descriptions vary
export const MERGE_THRESHOLD = 0.55;

// Weights for similarity components
// Adjusted to prioritize spatial proximity (file + line)
const WEIGHTS = {
  FILE_MATCH: 0.35,
  LINE_PROXIMITY: 0.30,
  CATEGORY_MATCH: 0.15,
  DESCRIPTION_OVERLAP: 0.20,
};

// Maximum line difference to consider for proximity scoring
const MAX_LINE_DISTANCE = 5;

/**
 * Calculate similarity between two suggestions
 * Returns a score between 0.0 and 1.0
 */
export function calculateSimilarity(a: ProviderSuggestion, b: ProviderSuggestion): number {
  // Different files = no similarity
  if (a.filePath !== b.filePath) {
    return 0;
  }

  let score = WEIGHTS.FILE_MATCH; // Base score for file match

  // Line proximity scoring
  const lineDiff = Math.abs(getEffectiveLine(a) - getEffectiveLine(b));
  if (lineDiff <= MAX_LINE_DISTANCE) {
    // Linear decrease from full score at 0 lines to 0 at MAX_LINE_DISTANCE
    score += WEIGHTS.LINE_PROXIMITY * (1 - lineDiff / MAX_LINE_DISTANCE);
  }

  // Category match
  if (a.category === b.category) {
    score += WEIGHTS.CATEGORY_MATCH;
  }

  // Description overlap using token-based similarity
  const descriptionSimilarity = calculateTokenOverlap(a.description, b.description);
  score += WEIGHTS.DESCRIPTION_OVERLAP * descriptionSimilarity;

  return score;
}

/**
 * Get the effective line number for comparison
 * Uses the middle of the line range if available
 */
function getEffectiveLine(suggestion: ProviderSuggestion): number {
  if (suggestion.lineRange) {
    return Math.floor((suggestion.lineRange.start + suggestion.lineRange.end) / 2);
  }
  return suggestion.lineNumber;
}

/**
 * Calculate token overlap between two descriptions
 * Uses a simple bag-of-words approach with normalization
 */
export function calculateTokenOverlap(textA: string, textB: string): number {
  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);

  if (tokensA.size === 0 || tokensB.size === 0) {
    return 0;
  }

  // Calculate Jaccard similarity
  const intersection = new Set([...tokensA].filter(t => tokensB.has(t)));
  const union = new Set([...tokensA, ...tokensB]);

  return intersection.size / union.size;
}

/**
 * Tokenize text into a set of normalized tokens
 * Removes common stop words and normalizes case
 */
function tokenize(text: string): Set<string> {
  // Common stop words to filter out
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
    'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
    'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above',
    'below', 'between', 'under', 'again', 'further', 'then', 'once',
    'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few',
    'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
    'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but',
    'if', 'or', 'because', 'until', 'while', 'this', 'that', 'these',
    'those', 'it', 'its', 'you', 'your', 'i', 'we', 'they', 'them',
  ]);

  // Extract words, normalize, and filter
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
    .split(/\s+/)
    .filter(word => word.length > 2 && !STOP_WORDS.has(word))
    .map(word => {
      // Basic stemming
      if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
      if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
      if (word.endsWith('s') && word.length > 3) return word.slice(0, -1);
      return word;
    });

  return new Set(words);
}

/**
 * Find similar suggestions in a collection
 * Returns indices of suggestions that are similar to the given one
 */
export function findSimilarSuggestions(
  suggestion: ProviderSuggestion,
  candidates: ProviderSuggestion[],
  excludeIndex: number = -1
): number[] {
  const similar: number[] = [];

  for (let i = 0; i < candidates.length; i++) {
    if (i === excludeIndex) continue;

    const similarity = calculateSimilarity(suggestion, candidates[i]);
    if (similarity >= MERGE_THRESHOLD) {
      similar.push(i);
    }
  }

  return similar;
}

/**
 * Group suggestions by similarity
 * Returns an array of groups, where each group contains similar suggestions
 */
export function groupBySimilarity(suggestions: ProviderSuggestion[]): ProviderSuggestion[][] {
  const groups: ProviderSuggestion[][] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < suggestions.length; i++) {
    if (assigned.has(i)) continue;

    const group: ProviderSuggestion[] = [suggestions[i]];
    assigned.add(i);

    // Find all similar suggestions
    for (let j = i + 1; j < suggestions.length; j++) {
      if (assigned.has(j)) continue;

      const similarity = calculateSimilarity(suggestions[i], suggestions[j]);
      if (similarity >= MERGE_THRESHOLD) {
        group.push(suggestions[j]);
        assigned.add(j);
      }
    }

    groups.push(group);
  }

  return groups;
}
