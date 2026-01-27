import type { PRDiff, ReviewResponse, ExtensionSettings, ConnectionStatus, ReviewSuggestion } from './types';

// Port message types for streaming communication
export type StreamPortMessage =
  | { type: 'START'; payload: PRDiff }
  | { type: 'SUMMARY'; payload: { summary: string; keyChanges: string[]; potentialConcerns?: string[] } }
  | { type: 'CHUNK'; payload: ReviewSuggestion }
  | { type: 'END'; payload: { summary: string; overallAssessment: string } }
  | { type: 'ERROR'; payload: { error: string } };

// Message types for content script <-> background communication
export type PostCommentPayload = {
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
  path: string;
  line: number;
  commitId: string;
  side?: 'LEFT' | 'RIGHT';
  startLine?: number;
  startSide?: 'LEFT' | 'RIGHT';
};

export type SubmitReviewPayload = {
  owner: string;
  repo: string;
  prNumber: number;
  event?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; // Optional - if omitted, review stays as draft
  body?: string;
  commitId?: string;
};

export type GeneratePRDescriptionPayload = {
  owner: string;
  repo: string;
  compareSpec: string;
  template: string;
};

export type ContentMessage =
  | { type: 'REQUEST_REVIEW'; payload: PRDiff }
  | { type: 'REQUEST_REVIEW_STREAM'; payload: PRDiff }
  | { type: 'FETCH_DIFF'; payload: { owner: string; repo: string; prNumber: number } }
  | { type: 'FETCH_COMPARE_DIFF'; payload: { owner: string; repo: string; compareSpec: string } }
  | { type: 'FETCH_PR_CONTEXT'; payload: { owner: string; repo: string; prNumber: number } }
  | { type: 'POST_COMMENT'; payload: PostCommentPayload }
  | { type: 'SUBMIT_REVIEW'; payload: SubmitReviewPayload }
  | { type: 'GENERATE_PR_DESCRIPTION'; payload: GeneratePRDescriptionPayload }
  | { type: 'GET_SETTINGS' }
  | { type: 'SAVE_SETTINGS'; payload: Partial<ExtensionSettings> }
  | { type: 'CHECK_CONNECTION' }
  | { type: 'CANCEL_REVIEW' };

export type PRContextResult = {
  owner: string;
  repo: string;
  prNumber: number;
  baseCommitOid: string;
  headCommitOid: string;
};

export type BackgroundMessage =
  | { type: 'REVIEW_RESULT'; payload: ReviewResponse }
  | { type: 'REVIEW_STREAM_START' }
  | { type: 'REVIEW_STREAM_CHUNK'; payload: ReviewSuggestion }
  | { type: 'REVIEW_STREAM_END'; payload: { summary: string; overallAssessment: string } }
  | { type: 'REVIEW_ERROR'; payload: { error: string } }
  | { type: 'REVIEW_PROGRESS'; payload: { status: string; progress?: number } }
  | { type: 'SETTINGS_RESULT'; payload: ExtensionSettings }
  | { type: 'CONNECTION_STATUS'; payload: ConnectionStatus }
  | { type: 'DIFF_RESULT'; payload: { diffText: string } }
  | { type: 'DIFF_ERROR'; payload: { error: string } }
  | { type: 'PR_CONTEXT_RESULT'; payload: PRContextResult }
  | { type: 'PR_CONTEXT_ERROR'; payload: { error: string } }
  | { type: 'POST_COMMENT_RESULT'; payload: { success: boolean; commentId?: number; url?: string } }
  | { type: 'POST_COMMENT_ERROR'; payload: { error: string } }
  | { type: 'SUBMIT_REVIEW_RESULT'; payload: { success: boolean; url?: string } }
  | { type: 'SUBMIT_REVIEW_ERROR'; payload: { error: string } }
  | { type: 'PR_DESCRIPTION_RESULT'; payload: { description: string } }
  | { type: 'PR_DESCRIPTION_ERROR'; payload: { error: string } };

// Helper to send message to background script
export function sendToBackground(message: ContentMessage): Promise<BackgroundMessage> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// Helper to send message to content script
export function sendToContentScript(tabId: number, message: BackgroundMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

// Default settings
export const DEFAULT_SETTINGS: ExtensionSettings = {
  strictnessLevel: 'balanced',
  focusAreas: ['all'],
  autoReviewOnLoad: false,
  autoFinalizeReview: false, // Default to draft mode
  darkMode: 'auto',
};
