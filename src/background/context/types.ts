/**
 * Context Types - Interfaces for repo context and existing comments
 */

// Repository summary information
export interface RepoSummary {
  // Basic info
  name: string;
  fullName: string; // owner/repo
  description?: string;

  // Tech stack detection
  techStack: TechStack;

  // Conventions and guidelines
  conventions?: string;

  // README summary (truncated)
  readmeSummary?: string;

  // Cached timestamp
  cachedAt: number;
}

export interface TechStack {
  language: string;
  framework?: string;
  buildTool?: string;
  testFramework?: string;
  dependencies: string[]; // Key dependencies only
}

// Existing comment on the PR
export interface ExistingComment {
  id: number;
  path: string;
  line: number;
  body: string;
  author: string;
  createdAt: string;
  // Parsed info for deduplication
  category?: string; // security, performance, style, etc.
  summary?: string; // Brief description of the issue
}

// Full context passed to AI providers
export interface RepoContext {
  // Repo-level context
  repoSummary?: RepoSummary;

  // Existing comments to avoid duplication
  existingComments: ExistingComment[];

  // Token budget tracking
  tokenBudget: {
    repoSummary: number;
    existingComments: number;
    total: number;
  };
}

// Settings for context fetching
export interface ContextSettings {
  includeRepoSummary: boolean;
  skipDiscussedIssues: boolean;
  maxTokensForContext: number;
}

// Default context settings
export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  includeRepoSummary: true,
  skipDiscussedIssues: true,
  maxTokensForContext: 20000,
};

// Cache key format
export function getRepoCacheKey(owner: string, repo: string): string {
  return `repo_context_${owner}_${repo}`;
}

// Cache expiry (24 hours)
export const REPO_CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000;
