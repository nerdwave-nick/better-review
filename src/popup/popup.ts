import { sendToBackground, DEFAULT_SETTINGS } from '../shared/messages';
import type { ExtensionSettings } from '../shared/types';

// DOM Elements
const elements = {
  connectionStatus: document.getElementById('connection-status')!,
  statusDot: document.querySelector('.status__dot')!,
  statusText: document.querySelector('.status__text')!,
  geminiApiKey: document.getElementById('gemini-api-key') as HTMLInputElement,
  toggleGeminiKey: document.getElementById('toggle-gemini-key')!,
  strictness: document.getElementById('strictness') as HTMLSelectElement,
  focusAll: document.getElementById('focus-all') as HTMLInputElement,
  focusSecurity: document.getElementById('focus-security') as HTMLInputElement,
  focusPerformance: document.getElementById('focus-performance') as HTMLInputElement,
  focusStyle: document.getElementById('focus-style') as HTMLInputElement,
  autoReview: document.getElementById('auto-review') as HTMLInputElement,
  autoFinalize: document.getElementById('auto-finalize') as HTMLInputElement,
  githubToken: document.getElementById('github-token') as HTMLInputElement,
  toggleToken: document.getElementById('toggle-token')!,
  validateToken: document.getElementById('validate-token')!,
  tokenStatus: document.getElementById('token-status')!,
  theme: document.getElementById('theme') as HTMLSelectElement,
  saveBtn: document.getElementById('save-btn')!,
  saveStatus: document.getElementById('save-status')!,
};

let currentSettings: ExtensionSettings = DEFAULT_SETTINGS;
let tokenVisible = false;
let geminiKeyVisible = false;

/**
 * Initialize popup
 */
async function init(): Promise<void> {
  await loadSettings();
  setupEventListeners();
  await checkConnection();
}

/**
 * Load settings from background script
 */
async function loadSettings(): Promise<void> {
  try {
    const response = await sendToBackground({ type: 'GET_SETTINGS' });
    if (response.type === 'SETTINGS_RESULT') {
      currentSettings = response.payload;
      populateForm();
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

/**
 * Populate form with current settings
 */
function populateForm(): void {
  // Gemini API key
  if (currentSettings.geminiApiKey) {
    elements.geminiApiKey.value = currentSettings.geminiApiKey;
  }

  // Strictness
  elements.strictness.value = currentSettings.strictnessLevel;

  // Focus areas
  const focusAreas = currentSettings.focusAreas || ['all'];
  elements.focusAll.checked = focusAreas.includes('all');
  elements.focusSecurity.checked = focusAreas.includes('security');
  elements.focusPerformance.checked = focusAreas.includes('performance');
  elements.focusStyle.checked = focusAreas.includes('style');

  // Toggle "all" behavior
  updateFocusCheckboxes();

  // Auto review
  elements.autoReview.checked = currentSettings.autoReviewOnLoad;

  // Auto finalize
  elements.autoFinalize.checked = currentSettings.autoFinalizeReview || false;

  // GitHub token
  if (currentSettings.githubToken) {
    elements.githubToken.value = currentSettings.githubToken;
  }

  // Theme
  elements.theme.value = currentSettings.darkMode || 'auto';
}

/**
 * Setup event listeners
 */
function setupEventListeners(): void {
  // Focus "All" checkbox
  elements.focusAll.addEventListener('change', () => {
    if (elements.focusAll.checked) {
      elements.focusSecurity.checked = false;
      elements.focusPerformance.checked = false;
      elements.focusStyle.checked = false;
    }
    updateFocusCheckboxes();
  });

  // Individual focus checkboxes
  [elements.focusSecurity, elements.focusPerformance, elements.focusStyle].forEach(checkbox => {
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        elements.focusAll.checked = false;
      }
      // If none selected, default to all
      if (!elements.focusSecurity.checked &&
          !elements.focusPerformance.checked &&
          !elements.focusStyle.checked) {
        elements.focusAll.checked = true;
      }
      updateFocusCheckboxes();
    });
  });

  // Gemini API key visibility toggle
  elements.toggleGeminiKey.addEventListener('click', () => {
    geminiKeyVisible = !geminiKeyVisible;
    elements.geminiApiKey.type = geminiKeyVisible ? 'text' : 'password';
    updateGeminiEyeIcon();
  });

  // Token visibility toggle
  elements.toggleToken.addEventListener('click', () => {
    tokenVisible = !tokenVisible;
    elements.githubToken.type = tokenVisible ? 'text' : 'password';
    updateEyeIcon();
  });

  // Validate token
  elements.validateToken.addEventListener('click', validateGitHubToken);

  // Save button
  elements.saveBtn.addEventListener('click', saveSettings);
}

/**
 * Updates focus checkboxes state
 */
function updateFocusCheckboxes(): void {
  const isAllSelected = elements.focusAll.checked;
  elements.focusSecurity.disabled = isAllSelected;
  elements.focusPerformance.disabled = isAllSelected;
  elements.focusStyle.disabled = isAllSelected;
}

/**
 * Updates eye icon for Gemini API key visibility
 */
function updateGeminiEyeIcon(): void {
  const eyeIcon = document.getElementById('gemini-eye-icon');
  if (eyeIcon) {
    if (geminiKeyVisible) {
      eyeIcon.innerHTML = `
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
        <line x1="1" y1="1" x2="23" y2="23"/>
      `;
    } else {
      eyeIcon.innerHTML = `
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
        <circle cx="12" cy="12" r="3"/>
      `;
    }
  }
}

/**
 * Updates eye icon for token visibility
 */
function updateEyeIcon(): void {
  const eyeIcon = document.getElementById('eye-icon');
  if (eyeIcon) {
    if (tokenVisible) {
      eyeIcon.innerHTML = `
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
        <line x1="1" y1="1" x2="23" y2="23"/>
      `;
    } else {
      eyeIcon.innerHTML = `
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
        <circle cx="12" cy="12" r="3"/>
      `;
    }
  }
}

/**
 * Check connection (API key presence)
 */
async function checkConnection(): Promise<void> {
  updateConnectionStatus('checking', 'Checking...');

  try {
    const response = await sendToBackground({ type: 'CHECK_CONNECTION' });
    if (response.type === 'CONNECTION_STATUS') {
      if (response.payload.connected) {
        updateConnectionStatus('connected', 'API Key Set');
      } else {
        updateConnectionStatus('disconnected', 'No API Key');
      }
    }
  } catch (error) {
    updateConnectionStatus('disconnected', 'Error');
  }
}

/**
 * Updates connection status UI
 */
function updateConnectionStatus(status: 'connected' | 'disconnected' | 'checking', text: string): void {
  elements.connectionStatus.className = `status status--${status}`;
  elements.statusText.textContent = text;
}

/**
 * Validates GitHub token
 */
async function validateGitHubToken(): Promise<void> {
  const token = elements.githubToken.value.trim();
  if (!token) {
    showTokenStatus('invalid', 'Please enter a token');
    return;
  }

  showTokenStatus('checking', 'Validating...');

  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    });

    if (response.ok) {
      const user = await response.json();
      showTokenStatus('valid', `Valid token for @${user.login}`);
    } else if (response.status === 401) {
      showTokenStatus('invalid', 'Invalid or expired token');
    } else {
      showTokenStatus('invalid', `Error: ${response.status}`);
    }
  } catch (error) {
    showTokenStatus('invalid', 'Network error');
  }
}

/**
 * Shows token validation status
 */
function showTokenStatus(status: 'valid' | 'invalid' | 'checking', message: string): void {
  elements.tokenStatus.className = `token-status token-status--${status}`;
  elements.tokenStatus.textContent = message;
}

/**
 * Collects current form values into settings object
 */
function collectFormValues(): Partial<ExtensionSettings> {
  const focusAreas: ExtensionSettings['focusAreas'] = [];

  if (elements.focusAll.checked) {
    focusAreas.push('all');
  } else {
    if (elements.focusSecurity.checked) focusAreas.push('security');
    if (elements.focusPerformance.checked) focusAreas.push('performance');
    if (elements.focusStyle.checked) focusAreas.push('style');
  }

  return {
    geminiApiKey: elements.geminiApiKey.value.trim() || undefined,
    strictnessLevel: elements.strictness.value as ExtensionSettings['strictnessLevel'],
    focusAreas,
    autoReviewOnLoad: elements.autoReview.checked,
    autoFinalizeReview: elements.autoFinalize.checked,
    githubToken: elements.githubToken.value.trim() || undefined,
    darkMode: elements.theme.value as ExtensionSettings['darkMode'],
  };
}

/**
 * Saves settings
 */
async function saveSettings(): Promise<void> {
  const settings = collectFormValues();

  try {
    elements.saveBtn.textContent = 'Saving...';
    elements.saveBtn.setAttribute('disabled', 'true');

    const response = await sendToBackground({
      type: 'SAVE_SETTINGS',
      payload: settings,
    });

    if (response.type === 'SETTINGS_RESULT') {
      currentSettings = response.payload;
      showSaveStatus('Settings saved!');
      await checkConnection();
    }
  } catch (error) {
    console.error('Failed to save settings:', error);
    showSaveStatus('Failed to save');
  } finally {
    elements.saveBtn.textContent = 'Save Settings';
    elements.saveBtn.removeAttribute('disabled');
  }
}

/**
 * Shows save status message
 */
function showSaveStatus(message: string): void {
  elements.saveStatus.textContent = message;
  elements.saveStatus.classList.add('save-status--visible');

  setTimeout(() => {
    elements.saveStatus.classList.remove('save-status--visible');
  }, 2000);
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', init);
