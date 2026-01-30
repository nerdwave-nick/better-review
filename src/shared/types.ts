// Priority levels for review suggestions
export type SuggestionPriority = 'high' | 'medium' | 'low';

// Types of suggestions the AI can make
export type SuggestionType = 'comment' | 'code_change';

// A single line change in a diff
export interface DiffLine {
  type: 'added' | 'removed' | 'context';
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

// A hunk in a diff (a contiguous block of changes)
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

// A single file's diff
export interface FileDiff {
  path: string;
  oldPath?: string; // For renames
  status: 'added' | 'removed' | 'modified' | 'renamed';
  hunks: DiffHunk[];
  isBinary: boolean;
}

// Full PR diff data
export interface PRDiff {
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  description: string;
  baseBranch: string;
  headBranch: string;
  files: FileDiff[];
}

// An AI-generated review suggestion
export interface ReviewSuggestion {
  id: string;
  filePath: string;
  lineNumber: number; // Line number in the new file
  lineRange?: { start: number; end: number }; // For multi-line suggestions
  priority: SuggestionPriority;
  type: SuggestionType;
  description: string;
  suggestedCode?: string; // For code change suggestions
  category: 'security' | 'performance' | 'style' | 'logic' | 'best_practice' | 'documentation';
}

// Review response from AI
export interface ReviewResponse {
  suggestions: ReviewSuggestion[];
  summary: string;
  overallAssessment: 'approve' | 'request_changes' | 'comment';
  reviewedAt: string;
}

// Supported AI providers
export type ProviderName = 'gemini' | 'claude';

// Extension settings
export interface ExtensionSettings {
  strictnessLevel: 'thorough' | 'balanced' | 'quick';
  focusAreas: ('security' | 'performance' | 'style' | 'all')[];
  autoReviewOnLoad: boolean;
  autoFinalizeReview: boolean; // If true, submit review immediately; if false, keep as draft
  autoComment: boolean; // If true, auto-add all suggestions as draft comments when review completes
  githubToken?: string; // For private repos
  geminiApiKey?: string; // For Gemini AI reviews
  claudeApiKey?: string; // For Claude AI reviews
  enabledProviders: ProviderName[]; // Which providers to use (default: ['gemini'])
  // Context settings
  includeRepoSummary: boolean; // Include README/package.json context
  includeRelatedFiles: boolean; // Include imported/related files
  skipDiscussedIssues: boolean; // Skip issues already mentioned in comments
  darkMode: 'auto' | 'light' | 'dark';
}

// Consensus suggestion with confidence scoring
export interface ConsensusSuggestion extends ReviewSuggestion {
  confidence: number; // 0.0-1.0
  confidenceLevel: 'high' | 'medium' | 'low';
  contributingProviders: ProviderName[];
  providerCount: number;
}

// Connection status
export interface ConnectionStatus {
  connected: boolean;
  lastPing?: number;
  error?: string;
}

// AI-generated changes summary
export interface ChangesSummaryResponse {
  summary: string;
  keyChanges: string[];
  potentialConcerns?: string[];
}
