// Shared utility functions

import { PR_URL_PATTERN, COMPARE_URL_PATTERN } from './constants';

export interface PRIdentifier {
  owner: string;
  repo: string;
  prNumber: number;
}

export interface CompareIdentifier {
  owner: string;
  repo: string;
  compareSpec: string; // e.g., "main...feature-branch" or just "feature-branch"
}

/**
 * Extract PR information from the current GitHub URL
 */
export function extractPRFromUrl(): PRIdentifier | null {
  const match = window.location.pathname.match(PR_URL_PATTERN);
  if (!match) {
    return null;
  }
  return {
    owner: match[1],
    repo: match[2],
    prNumber: parseInt(match[3], 10),
  };
}

/**
 * Extract compare page information from the current GitHub URL
 */
export function extractCompareFromUrl(): CompareIdentifier | null {
  const match = window.location.pathname.match(COMPARE_URL_PATTERN);
  if (!match) {
    return null;
  }
  return {
    owner: match[1],
    repo: match[2],
    compareSpec: match[3],
  };
}
