/**
 * Repo Summary - Fetch and parse repository context
 *
 * Fetches README.md, package.json, and other config files to build
 * a repo profile for AI context.
 */

import type { RepoSummary, TechStack } from './types';
import { getRepoCacheKey, REPO_CACHE_EXPIRY_MS } from './types';
import { logger } from '../../shared/logger';
import { GITHUB_API_URL } from '../../shared/constants';

const TAG = 'RepoSummary';

// Maximum characters for README summary
const MAX_README_CHARS = 3000;

/**
 * Fetch repo summary with caching
 */
export async function fetchRepoSummary(
  owner: string,
  repo: string,
  githubToken?: string
): Promise<RepoSummary | null> {
  const cacheKey = getRepoCacheKey(owner, repo);

  // Check cache first
  try {
    const cached = await getCachedSummary(cacheKey);
    if (cached) {
      logger.debug(TAG, 'Using cached repo summary', { owner, repo });
      return cached;
    }
  } catch (e) {
    // Cache miss or error, continue to fetch
  }

  logger.debug(TAG, 'Fetching repo summary', { owner, repo });

  try {
    // Fetch repo info, README, and config files in parallel
    const [repoInfo, readme, techStack] = await Promise.all([
      fetchRepoInfo(owner, repo, githubToken),
      fetchReadme(owner, repo, githubToken),
      detectTechStack(owner, repo, githubToken),
    ]);

    if (!repoInfo) {
      return null;
    }

    const summary: RepoSummary = {
      name: repo,
      fullName: `${owner}/${repo}`,
      description: repoInfo.description,
      techStack,
      readmeSummary: readme ? summarizeReadme(readme) : undefined,
      cachedAt: Date.now(),
    };

    // Cache the result
    await cacheSummary(cacheKey, summary);

    return summary;
  } catch (error) {
    logger.error(TAG, 'Failed to fetch repo summary:', error);
    return null;
  }
}

/**
 * Fetch basic repo info from GitHub API
 */
async function fetchRepoInfo(
  owner: string,
  repo: string,
  token?: string
): Promise<{ description?: string; language?: string } | null> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}`, { headers });
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    return {
      description: data.description,
      language: data.language,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch README.md content
 */
async function fetchReadme(
  owner: string,
  repo: string,
  token?: string
): Promise<string | null> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3.raw',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(
      `${GITHUB_API_URL}/repos/${owner}/${repo}/readme`,
      { headers }
    );
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Detect tech stack from config files
 */
async function detectTechStack(
  owner: string,
  repo: string,
  token?: string
): Promise<TechStack> {
  const techStack: TechStack = {
    language: 'Unknown',
    dependencies: [],
  };

  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3.raw',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Try to fetch package.json first (most common)
  try {
    const response = await fetch(
      `${GITHUB_API_URL}/repos/${owner}/${repo}/contents/package.json`,
      { headers }
    );
    if (response.ok) {
      const content = await response.text();
      const pkg = JSON.parse(content);
      return parsePackageJson(pkg);
    }
  } catch {
    // Not a Node.js project or error
  }

  // Try pyproject.toml for Python
  try {
    const response = await fetch(
      `${GITHUB_API_URL}/repos/${owner}/${repo}/contents/pyproject.toml`,
      { headers }
    );
    if (response.ok) {
      techStack.language = 'Python';
      techStack.buildTool = 'pyproject.toml';
    }
  } catch {
    // Not a Python project
  }

  // Try Cargo.toml for Rust
  try {
    const response = await fetch(
      `${GITHUB_API_URL}/repos/${owner}/${repo}/contents/Cargo.toml`,
      { headers }
    );
    if (response.ok) {
      techStack.language = 'Rust';
      techStack.buildTool = 'Cargo';
    }
  } catch {
    // Not a Rust project
  }

  // Try go.mod for Go
  try {
    const response = await fetch(
      `${GITHUB_API_URL}/repos/${owner}/${repo}/contents/go.mod`,
      { headers }
    );
    if (response.ok) {
      techStack.language = 'Go';
      techStack.buildTool = 'Go modules';
    }
  } catch {
    // Not a Go project
  }

  return techStack;
}

/**
 * Parse package.json to extract tech stack info
 */
function parsePackageJson(pkg: any): TechStack {
  const techStack: TechStack = {
    language: 'JavaScript/TypeScript',
    dependencies: [],
  };

  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };

  // Detect TypeScript
  if (allDeps['typescript']) {
    techStack.language = 'TypeScript';
  }

  // Detect framework
  if (allDeps['react']) {
    techStack.framework = 'React';
  } else if (allDeps['vue']) {
    techStack.framework = 'Vue';
  } else if (allDeps['@angular/core']) {
    techStack.framework = 'Angular';
  } else if (allDeps['next']) {
    techStack.framework = 'Next.js';
  } else if (allDeps['express']) {
    techStack.framework = 'Express';
  } else if (allDeps['fastify']) {
    techStack.framework = 'Fastify';
  } else if (allDeps['nestjs'] || allDeps['@nestjs/core']) {
    techStack.framework = 'NestJS';
  }

  // Detect test framework
  if (allDeps['jest']) {
    techStack.testFramework = 'Jest';
  } else if (allDeps['vitest']) {
    techStack.testFramework = 'Vitest';
  } else if (allDeps['mocha']) {
    techStack.testFramework = 'Mocha';
  }

  // Detect build tool
  if (allDeps['esbuild']) {
    techStack.buildTool = 'esbuild';
  } else if (allDeps['webpack']) {
    techStack.buildTool = 'Webpack';
  } else if (allDeps['vite']) {
    techStack.buildTool = 'Vite';
  } else if (allDeps['rollup']) {
    techStack.buildTool = 'Rollup';
  }

  // Extract key dependencies (non-dev, non-trivial)
  const keyDeps = Object.keys(pkg.dependencies || {})
    .filter(dep => !dep.startsWith('@types/'))
    .slice(0, 10);
  techStack.dependencies = keyDeps;

  return techStack;
}

/**
 * Summarize README content to fit within token budget
 */
function summarizeReadme(readme: string): string {
  // Remove images, badges, and excessive whitespace
  let summary = readme
    .replace(/!\[.*?\]\(.*?\)/g, '') // Remove images
    .replace(/\[!\[.*?\]\(.*?\)\]\(.*?\)/g, '') // Remove badge links
    .replace(/```[\s\S]*?```/g, '[code block]') // Simplify code blocks
    .replace(/\n{3,}/g, '\n\n') // Reduce excessive newlines
    .trim();

  // Truncate to max chars
  if (summary.length > MAX_README_CHARS) {
    summary = summary.substring(0, MAX_README_CHARS) + '\n\n[... truncated ...]';
  }

  return summary;
}

/**
 * Get cached summary from storage
 */
async function getCachedSummary(cacheKey: string): Promise<RepoSummary | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([cacheKey], (result) => {
      const cached = result[cacheKey] as RepoSummary | undefined;
      if (cached && Date.now() - cached.cachedAt < REPO_CACHE_EXPIRY_MS) {
        resolve(cached);
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Cache summary to storage
 */
async function cacheSummary(cacheKey: string, summary: RepoSummary): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [cacheKey]: summary }, resolve);
  });
}

/**
 * Clear cached summary for a repo
 */
export async function clearRepoCache(owner: string, repo: string): Promise<void> {
  const cacheKey = getRepoCacheKey(owner, repo);
  return new Promise((resolve) => {
    chrome.storage.local.remove([cacheKey], resolve);
  });
}

/**
 * Format repo summary for prompt inclusion
 */
export function formatRepoSummaryForPrompt(summary: RepoSummary): string {
  const parts: string[] = [];

  parts.push(`Repository: ${summary.fullName}`);

  if (summary.description) {
    parts.push(`Description: ${summary.description}`);
  }

  parts.push(`Tech Stack: ${summary.techStack.language}`);
  if (summary.techStack.framework) {
    parts.push(`Framework: ${summary.techStack.framework}`);
  }
  if (summary.techStack.testFramework) {
    parts.push(`Testing: ${summary.techStack.testFramework}`);
  }
  if (summary.techStack.dependencies.length > 0) {
    parts.push(`Key Dependencies: ${summary.techStack.dependencies.join(', ')}`);
  }

  if (summary.readmeSummary) {
    parts.push(`\nREADME Summary:\n${summary.readmeSummary}`);
  }

  return parts.join('\n');
}
