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

/**
 * Build GitHub API URL for a given endpoint
 */
export function buildGitHubApiUrl(path: string): string {
  return `https://api.github.com${path}`;
}

/**
 * Build GitHub web URL for a given path
 */
export function buildGitHubWebUrl(path: string): string {
  return `https://github.com${path}`;
}

/**
 * Build standard GitHub API headers
 */
export function buildGitHubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
  };
  if (token) {
    headers['Authorization'] = `token ${token}`;
  }
  return headers;
}
