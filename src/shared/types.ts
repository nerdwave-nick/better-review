// Priority levels for review suggestions
export type SuggestionPriority = 'high' | 'medium' | 'low';

// Types of suggestions the AI can make
export type SuggestionType = 'comment' | 'code_change' | 'question' | 'approval';

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
  title: string;
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

// Extension settings
export interface ExtensionSettings {
  strictnessLevel: 'thorough' | 'balanced' | 'quick';
  focusAreas: ('security' | 'performance' | 'style' | 'all')[];
  autoReviewOnLoad: boolean;
  autoFinalizeReview: boolean; // If true, submit review immediately; if false, keep as draft
  githubToken?: string; // For private repos
  geminiApiKey?: string; // For Gemini AI reviews
  darkMode: 'auto' | 'light' | 'dark';
}

// Connection status
export interface ConnectionStatus {
  connected: boolean;
  lastPing?: number;
  error?: string;
}

// Suggestion state in UI
export interface SuggestionState {
  suggestion: ReviewSuggestion;
  status: 'pending' | 'accepted' | 'dismissed';
  expanded: boolean;
}
