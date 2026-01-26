// Centralized constants and configuration

// API URLs
export const GITHUB_WEB_URL = 'https://github.com';
export const GITHUB_API_URL = 'https://api.github.com';

// Storage keys
export const STORAGE_KEYS = {
  SETTINGS: 'pr_ai_review_settings',
} as const;

// Timeouts (in milliseconds)
export const TIMEOUTS = {
  TOAST_DURATION: 3000,
  NAVIGATION_DEBOUNCE: 500,
  DIFF_CONTENT_WAIT: 500,
  BUTTON_STATE_RESET: 3000,
} as const;

// Gemini AI configuration
export const GEMINI_CONFIG = {
  MODEL: 'gemini-2.5-flash-preview-05-20',
  MAX_OUTPUT_TOKENS: 65000,
  TEMPERATURE: 0.3,
} as const;

// CSS class names used by the extension
export const CSS_CLASSES = {
  REVIEW_BUTTON: 'pr-ai-review-btn',
  TOAST: 'pr-ai-toast',
  SUGGESTION_NAV: 'pr-ai-suggestion-nav',
  SUGGESTION_OVERLAY: 'pr-ai-suggestion-overlay',
  SUMMARY: 'pr-ai-summary',
} as const;

// PR URL pattern for GitHub
export const PR_URL_PATTERN = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

// Log tags for consistent logging
export const LOG_TAGS = {
  SERVICE_WORKER: 'ServiceWorker',
  CONTENT: 'Content',
  GEMINI: 'Gemini',
  POPUP: 'Popup',
  DIFF_PARSER: 'DiffParser',
  GITHUB_API: 'GitHubAPI',
  OVERLAY_UI: 'OverlayUI',
} as const;
