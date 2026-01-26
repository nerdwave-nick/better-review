# PR Review AI

Chrome extension that uses Gemini AI to review GitHub pull requests.

## Setup

```bash
npm install
npm run build
```

Load the extension:
1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `dist` folder

## Usage

1. Get a Gemini API key from https://aistudio.google.com/apikey
2. Click the extension icon and paste your API key
3. Go to any GitHub PR and click the "AI Review" button

For private repos, add a GitHub token with `repo` scope in the extension settings.

## License

MIT
