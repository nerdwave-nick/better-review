# GitHub PR Review AI Assistant

A Chrome extension that integrates with GitHub Pull Request pages and uses Google's Gemini AI to provide intelligent code review suggestions with inline overlays.

## Features

- **AI-Powered Code Review**: Get intelligent suggestions for your pull requests using Gemini AI
- **Inline Overlays**: See suggestions directly in the GitHub diff view
- **Priority Indicators**: Suggestions are color-coded by priority (high/medium/low)
- **Category Tagging**: Issues are categorized (security, performance, style, logic, etc.)
- **One-Click Actions**: Accept suggestions as comments or copy code fixes
- **Customizable Settings**: Adjust review strictness and focus areas
- **Private Repo Support**: Use GitHub tokens to review private repositories

## Prerequisites

1. **Node.js** (v18 or higher)
2. **Google Chrome** or Chromium-based browser
3. **Gemini API Key** from [Google AI Studio](https://aistudio.google.com/apikey)

## Installation

### 1. Build the Extension

```bash
cd extension
npm install
npm run build
```

### 2. Load the Extension in Chrome

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `extension/dist` folder

### 3. Configure API Key

1. Click the extension icon in Chrome toolbar
2. Enter your **Gemini API Key** (get one from [Google AI Studio](https://aistudio.google.com/apikey))
3. Click "Save Settings"

## Usage

1. Navigate to any GitHub Pull Request page
2. Click the purple "AI Review" button in the PR header
3. Wait for the AI to analyze the code changes
4. Review the inline suggestions that appear on relevant lines
5. Click on priority badges to expand suggestion details
6. Use action buttons to:
   - **Post Comment**: Opens GitHub's comment form with the suggestion
   - **Copy Code**: Copies suggested code to clipboard
   - **Dismiss**: Hides the suggestion

## Configuration

Click the extension icon to open settings:

- **Gemini API Key**: Required for AI-powered reviews
  - Get your key at https://aistudio.google.com/apikey
  - Free tier includes generous usage limits

- **Review Strictness**
  - Quick: Only critical issues
  - Balanced: Standard review (default)
  - Thorough: Comprehensive analysis

- **Focus Areas**
  - All (default)
  - Security
  - Performance
  - Code Style

- **Auto-Review**: Automatically review PRs when you open them

- **GitHub Token**: Required for private repositories
  - Generate a token at https://github.com/settings/tokens
  - Token needs `repo` scope

## Development

### Watch Mode

For development with auto-rebuild:

```bash
npm run dev
```

### Type Checking

```bash
npm run typecheck
```

### Package for Distribution

```bash
npm run package
```

This creates `pr-ai-review.zip` for distribution.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Chrome Extension                             │
├─────────────────┬─────────────────┬─────────────────────────────┤
│  Content Script │  Background SW  │  Popup/Settings             │
│  (GitHub DOM)   │  (Gemini API)   │  (Configuration)            │
└────────┬────────┴────────┬────────┴─────────────────────────────┘
         │                 │
         │    Chrome       │
         │    Messages     │
         ▼                 ▼
┌─────────────────────────────────────────────────────────────────┐
│              Google Gemini API                                   │
│              (AI Processing)                                     │
└─────────────────────────────────────────────────────────────────┘
```

## Files Structure

```
extension/
├── manifest.json           # Chrome extension manifest (v3)
├── src/
│   ├── content/
│   │   ├── content.ts      # Main content script
│   │   ├── diff-parser.ts  # GitHub diff extraction
│   │   ├── overlay-ui.ts   # Inline UI components
│   │   └── styles.css      # Styling
│   ├── background/
│   │   ├── service-worker.ts  # Background service worker
│   │   └── gemini-service.ts  # Gemini API integration
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.ts
│   │   └── popup.css
│   └── shared/
│       ├── types.ts        # TypeScript types
│       └── messages.ts     # Message definitions
└── assets/
    └── icons/              # Extension icons
```

## Troubleshooting

### "Gemini API key is required" error

1. Open the extension popup (click the extension icon)
2. Enter your Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)
3. Click "Save Settings"
4. Try the review again

### "Invalid Gemini API key" error

1. Verify your API key is correct
2. Check that the key hasn't been revoked in Google AI Studio
3. Try generating a new API key

### "API quota exceeded" error

1. Wait a few minutes and try again
2. Check your usage at [Google AI Studio](https://aistudio.google.com/)
3. The free tier has generous limits for personal use

### No suggestions appear

1. Make sure you're on a PR "Files changed" tab
2. Check the browser console for errors (F12 → Console)
3. Verify the diff contains actual code changes (not just renames)

### Build errors

1. Delete `node_modules` and run `npm install` again
2. Ensure you're using Node.js v18 or higher
3. Check for TypeScript errors with `npm run typecheck`

## License

MIT
