<template>
  <div class="popup" :class="{ 'dark-theme': isDarkTheme }">
    <header class="header">
      <div class="header__logo">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
          <path
            d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
        </svg>
        <h1>PR AI Review</h1>
      </div>
      <div id="connection-status" class="status" :class="connectionStatusClass">
        <span class="status__dot"></span>
        <span class="status__text">{{ connectionStatusText }}</span>
      </div>
    </header>

    <main class="main">
      <section class="section">
        <h2 class="section__title">AI Providers</h2>
        <p class="section__description">
          Configure one or more AI providers for code reviews. Enable multiple providers for consensus-based suggestions
          with confidence scoring.
        </p>

        <div class="form-group">
          <label class="label">Active Providers</label>
          <div class="checkbox-group">
            <label class="checkbox">
              <input type="checkbox" :checked="settings.enabledProviders.includes('gemini')"
                @change="toggleProvider('gemini')">
              <span class="checkbox__label">Gemini</span>
            </label>
            <label class="checkbox">
              <input type="checkbox" :checked="settings.enabledProviders.includes('claude')"
                @change="toggleProvider('claude')">
              <span class="checkbox__label">Claude</span>
            </label>
          </div>
        </div>

        <div class="form-group">
          <label class="label" for="gemini-api-key">Gemini API Key</label>
          <p class="section__description" style="margin-bottom: 8px;">
            Get your API key from <a href="https://aistudio.google.com/apikey" target="_blank">Google AI Studio</a>.
          </p>
          <div class="input-group">
            <input :type="showGeminiKey ? 'text' : 'password'" v-model="settings.geminiApiKey" id="gemini-api-key"
              class="input" placeholder="AIza...">
            <button @click="showGeminiKey = !showGeminiKey" class="btn btn--icon" title="Show/Hide API key">
              <EyeIcon :visible="showGeminiKey" />
            </button>
          </div>
        </div>

        <div class="form-group">
          <label class="label" for="claude-api-key">Claude API Key</label>
          <p class="section__description" style="margin-bottom: 8px;">
            Get your API key from <a href="https://console.anthropic.com/settings/keys" target="_blank">Anthropic
              Console</a>.
          </p>
          <div class="input-group">
            <input :type="showClaudeKey ? 'text' : 'password'" v-model="settings.claudeApiKey" id="claude-api-key"
              class="input" placeholder="sk-ant-...">
            <button @click="showClaudeKey = !showClaudeKey" class="btn btn--icon" title="Show/Hide API key">
              <EyeIcon :visible="showClaudeKey" />
            </button>
          </div>
        </div>
      </section>

      <section class="section">
        <h2 class="section__title">Review Settings</h2>

        <div class="form-group">
          <label class="label" for="strictness">Review Strictness</label>
          <select id="strictness" class="select" v-model="settings.strictnessLevel">
            <option value="quick">Quick - Focus on critical issues only</option>
            <option value="balanced">Balanced - Standard code review</option>
            <option value="thorough">Thorough - Comprehensive analysis</option>
          </select>
        </div>

        <div class="form-group">
          <label class="label">Context Settings</label>
          <div class="checkbox-group" style="display: flex; flex-direction: column; gap: 8px;">
            <label class="checkbox">
              <input type="checkbox" v-model="settings.includeRepoSummary">
              <span class="checkbox__label">Include repo summary (README)</span>
            </label>
            <label class="checkbox">
              <input type="checkbox" v-model="settings.skipDiscussedIssues">
              <span class="checkbox__label">Skip discussed issues</span>
            </label>
          </div>
        </div>

        <div class="form-group">
          <label class="toggle">
            <input type="checkbox" v-model="settings.autoComment">
            <span class="toggle__slider"></span>
            <span class="toggle__label">Auto-comment after review</span>
          </label>
          <p class="section__description" style="margin-top: 4px; font-size: 11px;">
            Automatically add all suggestions as draft comments when review completes.
          </p>
        </div>
      </section>

      <section class="section">
        <h2 class="section__title">GitHub Token</h2>
        <p class="section__description">
          Required for private repositories. Token needs <code>repo</code> scope.
        </p>
        <div class="form-group">
          <div class="input-group">
            <input :type="showToken ? 'text' : 'password'" v-model="settings.githubToken" class="input"
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx">
            <button @click="showToken = !showToken" class="btn btn--icon" title="Show/Hide token">
              <EyeIcon :visible="showToken" />
            </button>
          </div>
          <button @click="validateGitHubToken" class="btn btn--secondary btn--small" :disabled="isValidating">
            {{ isValidating ? 'Validating...' : 'Validate Token' }}
          </button>
          <div v-if="tokenStatus.message" class="token-status" :class="`token-status--${tokenStatus.type}`">
            {{ tokenStatus.message }}
          </div>
        </div>
      </section>

      <section class="section">
        <h2 class="section__title">Appearance</h2>
        <div class="form-group">
          <label class="label" for="theme">Theme</label>
          <select id="theme" class="select" v-model="settings.darkMode">
            <option value="auto">Auto (match GitHub)</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </section>
    </main>

    <footer class="footer">
      <button @click="saveSettings" class="btn btn--primary" :disabled="isSaving">
        {{ isSaving ? 'Saving...' : 'Save Settings' }}
      </button>
      <span class="save-status" :class="{ 'save-status--visible': saveStatusMessage }">
        {{ saveStatusMessage }}
      </span>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, reactive } from 'vue';
import { sendToBackground, DEFAULT_SETTINGS } from '../../../shared/messages';
import type { ExtensionSettings, ProviderName } from '../../../shared/types';
import { GITHUB_API_URL } from '../../../shared/constants';

// --- Components ---
const EyeIcon = {
  props: ['visible'],
  template: `
    <svg v-if="visible" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
    <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  `
};

// --- State ---
const settings = ref<ExtensionSettings>({ ...DEFAULT_SETTINGS });
const connectionStatus = ref<'connected' | 'disconnected' | 'checking'>('checking');
const connectionStatusText = ref('Checking...');
const showGeminiKey = ref(false);
const showClaudeKey = ref(false);
const showToken = ref(false);
const isSaving = ref(false);
const saveStatusMessage = ref('');
const isValidating = ref(false);
const tokenStatus = reactive({ type: 'valid' as 'valid' | 'invalid' | 'checking', message: '' });

// --- Computed ---
const connectionStatusClass = computed(() => `status--${connectionStatus.value}`);
const isDarkTheme = computed(() => settings.value.darkMode === 'dark'); // Simple check, real theme logic handled by CSS/browser

// --- Methods ---

function toggleProvider(provider: ProviderName) {
  const index = settings.value.enabledProviders.indexOf(provider);
  if (index === -1) {
    settings.value.enabledProviders.push(provider);
  } else {
    // Prevent disabling all providers
    if (settings.value.enabledProviders.length > 1) {
      settings.value.enabledProviders.splice(index, 1);
    } else {
      // Maybe show a toast or shake? For now just ignore
    }
  }
}

async function loadSettings() {
  try {
    const response = await sendToBackground({ type: 'GET_SETTINGS' });
    if (response.type === 'SETTINGS_RESULT') {
      settings.value = { ...DEFAULT_SETTINGS, ...response.payload, focusAreas: ['all'] };
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

async function saveSettings() {
  isSaving.value = true;
  saveStatusMessage.value = '';
  try {
    const response = await sendToBackground({
      type: 'SAVE_SETTINGS',
      payload: settings.value,
    });

    if (response.type === 'SETTINGS_RESULT') {
      settings.value = response.payload;
      saveStatusMessage.value = 'Settings saved!';
      await checkConnection();
      setTimeout(() => { saveStatusMessage.value = ''; }, 2000);
    }
  } catch (error) {
    console.error('Failed to save settings:', error);
    saveStatusMessage.value = 'Failed to save';
  } finally {
    isSaving.value = false;
  }
}

async function checkConnection() {
  connectionStatus.value = 'checking';
  connectionStatusText.value = 'Checking...';
  try {
    const response = await sendToBackground({ type: 'CHECK_CONNECTION' });
    if (response.type === 'CONNECTION_STATUS') {
      if (response.payload.connected) {
        connectionStatus.value = 'connected';
        connectionStatusText.value = 'API Key Set';
      } else {
        connectionStatus.value = 'disconnected';
        connectionStatusText.value = 'No API Key';
      }
    }
  } catch (error) {
    connectionStatus.value = 'disconnected';
    connectionStatusText.value = 'Error';
  }
}

async function validateGitHubToken() {
  const token = settings.value.githubToken?.trim();
  if (!token) {
    tokenStatus.type = 'invalid';
    tokenStatus.message = 'Please enter a token';
    return;
  }

  isValidating.value = true;
  tokenStatus.type = 'checking';
  tokenStatus.message = 'Validating...';

  try {
    const response = await fetch(`${GITHUB_API_URL}/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    });

    if (response.ok) {
      const user = await response.json();
      tokenStatus.type = 'valid';
      tokenStatus.message = `Valid token for @${user.login}`;
    } else if (response.status === 401) {
      tokenStatus.type = 'invalid';
      tokenStatus.message = 'Invalid or expired token';
    } else {
      tokenStatus.type = 'invalid';
      tokenStatus.message = `Error: ${response.status}`;
    }
  } catch (error) {
    console.error('Token validation failed:', error);
    tokenStatus.type = 'invalid';
    tokenStatus.message = 'Network error';
  } finally {
    isValidating.value = false;
  }
}

onMounted(async () => {
  await loadSettings();
  await checkConnection();
});
</script>
