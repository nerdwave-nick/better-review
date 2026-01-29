/**
 * Related Files - Extract and fetch files related to PR changes
 *
 * Analyzes imports in changed files and fetches relevant context
 * from the repository.
 */

import type { RelatedFile } from './types';
import type { FileDiff } from '../../shared/types';
import { logger } from '../../shared/logger';
import { GITHUB_API_URL } from '../../shared/constants';

const TAG = 'RelatedFiles';

// Maximum content size per file (chars)
const MAX_FILE_CONTENT = 5000;

// Maximum total related files
const DEFAULT_MAX_FILES = 10;

// Import patterns for different languages
const IMPORT_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /import\s+(?:type\s+)?(?:{[^}]+}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ],
  javascript: [
    /import\s+(?:{[^}]+}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ],
  python: [
    /from\s+(\S+)\s+import/g,
    /import\s+(\S+)/g,
  ],
  go: [
    /import\s+"([^"]+)"/g,
    /import\s+\w+\s+"([^"]+)"/g,
  ],
  rust: [
    /use\s+(\S+)/g,
    /mod\s+(\w+)/g,
  ],
};

// File extensions to language mapping
const EXT_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
};

/**
 * Fetch related files for the given PR diff
 */
export async function fetchRelatedFiles(
  owner: string,
  repo: string,
  baseBranch: string,
  files: FileDiff[],
  githubToken?: string,
  maxFiles: number = DEFAULT_MAX_FILES
): Promise<RelatedFile[]> {
  logger.debug(TAG, 'Fetching related files', { owner, repo, fileCount: files.length });

  // Extract all imports from changed files
  const imports = extractImportsFromDiff(files);
  logger.debug(TAG, 'Extracted imports', { count: imports.size });

  // Resolve imports to actual file paths
  const resolvedPaths = resolveImportPaths(imports, files);
  logger.debug(TAG, 'Resolved paths', { count: resolvedPaths.length });

  // Fetch file contents (limited by maxFiles)
  const relatedFiles: RelatedFile[] = [];
  const pathsToFetch = resolvedPaths.slice(0, maxFiles);

  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3.raw',
  };
  if (githubToken) {
    headers['Authorization'] = `Bearer ${githubToken}`;
  }

  // Fetch files in parallel (batched)
  const batchSize = 5;
  for (let i = 0; i < pathsToFetch.length; i += batchSize) {
    const batch = pathsToFetch.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async ({ path, relevance }) => {
        try {
          const content = await fetchFileContent(owner, repo, baseBranch, path, headers);
          if (content) {
            return {
              path,
              content: truncateContent(content),
              relevance,
              truncated: content.length > MAX_FILE_CONTENT,
            };
          }
        } catch (e) {
          logger.debug(TAG, `Failed to fetch ${path}:`, e);
        }
        return null;
      })
    );

    relatedFiles.push(...results.filter((f): f is RelatedFile => f !== null));
  }

  logger.debug(TAG, 'Fetched related files', { count: relatedFiles.length });
  return relatedFiles;
}

/**
 * Extract imports from all changed files in the diff
 */
function extractImportsFromDiff(files: FileDiff[]): Set<{ path: string; importPath: string }> {
  const imports = new Set<{ path: string; importPath: string }>();

  for (const file of files) {
    if (file.isBinary) continue;

    const ext = getFileExtension(file.path);
    const language = EXT_TO_LANGUAGE[ext];
    if (!language) continue;

    const patterns = IMPORT_PATTERNS[language] || [];

    // Extract content from added lines
    const content = file.hunks
      .flatMap(h => h.lines)
      .filter(l => l.type === 'added' || l.type === 'context')
      .map(l => l.content)
      .join('\n');

    for (const pattern of patterns) {
      // Reset lastIndex for global patterns
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const importPath = match[1];
        if (importPath && !isExternalImport(importPath, language)) {
          imports.add({ path: file.path, importPath });
        }
      }
    }
  }

  return imports;
}

/**
 * Check if an import is external (npm package, standard library, etc.)
 */
function isExternalImport(importPath: string, language: string): boolean {
  // Skip node_modules style imports (no relative path)
  if (language === 'typescript' || language === 'javascript') {
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
      return true;
    }
  }

  // Skip Python standard library
  if (language === 'python') {
    const stdLibModules = ['os', 'sys', 'json', 'typing', 'pathlib', 'datetime', 'collections', 'itertools'];
    if (stdLibModules.includes(importPath.split('.')[0])) {
      return true;
    }
  }

  // Skip Go standard library
  if (language === 'go') {
    if (!importPath.includes('.')) {
      return true;
    }
  }

  return false;
}

/**
 * Resolve import paths to actual file paths in the repo
 */
function resolveImportPaths(
  imports: Set<{ path: string; importPath: string }>,
  changedFiles: FileDiff[]
): Array<{ path: string; relevance: RelatedFile['relevance'] }> {
  const resolved: Map<string, RelatedFile['relevance']> = new Map();
  const changedPaths = new Set(changedFiles.map(f => f.path));

  for (const { path, importPath } of imports) {
    const dir = getDirectoryPath(path);
    const resolvedPath = resolveRelativePath(dir, importPath);

    // Skip files that are already in the PR
    if (changedPaths.has(resolvedPath)) continue;

    // Determine relevance
    let relevance: RelatedFile['relevance'] = 'import';
    if (importPath.includes('type') || importPath.includes('interface')) {
      relevance = 'type_definition';
    }

    // Add with potential extensions
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', ''];
    for (const ext of extensions) {
      const fullPath = resolvedPath + ext;
      if (!resolved.has(fullPath)) {
        resolved.set(fullPath, relevance);
        break;
      }
    }

    // Also try index files
    const indexExtensions = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
    for (const ext of indexExtensions) {
      const indexPath = resolvedPath + ext;
      if (!resolved.has(indexPath)) {
        resolved.set(indexPath, relevance);
        break;
      }
    }
  }

  // Also look for similar files (same directory, similar name)
  for (const file of changedFiles) {
    const dir = getDirectoryPath(file.path);
    const basename = getBasename(file.path);

    // Look for test files
    const testPatterns = [
      `${dir}/${basename}.test`,
      `${dir}/${basename}.spec`,
      `${dir}/__tests__/${basename}`,
    ];

    for (const testPattern of testPatterns) {
      const extensions = ['.ts', '.tsx', '.js', '.jsx'];
      for (const ext of extensions) {
        const testPath = testPattern + ext;
        if (!changedPaths.has(testPath) && !resolved.has(testPath)) {
          resolved.set(testPath, 'test');
        }
      }
    }
  }

  return Array.from(resolved.entries()).map(([path, relevance]) => ({ path, relevance }));
}

/**
 * Fetch file content from GitHub
 */
async function fetchFileContent(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  headers: Record<string, string>
): Promise<string | null> {
  try {
    const url = `${GITHUB_API_URL}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      return null;
    }

    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Truncate content to max size
 */
function truncateContent(content: string): string {
  if (content.length <= MAX_FILE_CONTENT) {
    return content;
  }
  return content.substring(0, MAX_FILE_CONTENT) + '\n\n// [... truncated ...]';
}

/**
 * Get file extension
 */
function getFileExtension(path: string): string {
  const match = path.match(/\.[^.]+$/);
  return match ? match[0] : '';
}

/**
 * Get directory path from file path
 */
function getDirectoryPath(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/');
  return lastSlash >= 0 ? filePath.substring(0, lastSlash) : '';
}

/**
 * Get basename without extension
 */
function getBasename(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/');
  const filename = lastSlash >= 0 ? filePath.substring(lastSlash + 1) : filePath;
  const lastDot = filename.lastIndexOf('.');
  return lastDot >= 0 ? filename.substring(0, lastDot) : filename;
}

/**
 * Resolve relative path
 */
function resolveRelativePath(baseDir: string, relativePath: string): string {
  if (relativePath.startsWith('/')) {
    return relativePath.substring(1);
  }

  const baseParts = baseDir.split('/').filter(p => p);
  const relativeParts = relativePath.split('/');

  for (const part of relativeParts) {
    if (part === '..') {
      baseParts.pop();
    } else if (part !== '.' && part !== '') {
      baseParts.push(part);
    }
  }

  return baseParts.join('/');
}

/**
 * Format related files for prompt inclusion
 */
export function formatRelatedFilesForPrompt(files: RelatedFile[]): string {
  if (files.length === 0) {
    return '';
  }

  const parts: string[] = ['Related Files from Repository:'];

  for (const file of files) {
    const truncatedNote = file.truncated ? ' (truncated)' : '';
    parts.push(`\n--- ${file.path} [${file.relevance}]${truncatedNote} ---`);
    parts.push(file.content);
  }

  return parts.join('\n');
}
