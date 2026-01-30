<template>
  <button class="pr-ai-desc-btn" :class="{
    'pr-ai-desc-btn--loading': store.descriptionButtonState === 'loading',
    'pr-ai-desc-btn--error': store.descriptionButtonState === 'error'
  }" :disabled="store.descriptionButtonState === 'loading'" @click.prevent="handleClick"
    :title="store.descriptionButtonState === 'loading' ? 'Generating...' : 'Generate PR description using AI'">
    <span v-if="store.descriptionButtonState === 'loading'" class="pr-ai-spinner">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10" stroke-dasharray="50" stroke-linecap="round" />
      </svg>
    </span>
    <span v-else v-html="ICONS.REFRESH_CW"></span>
    <span class="pr-ai-desc-btn__text">{{ store.descriptionButtonState === 'loading' ? '...' : 'AI' }}</span>
  </button>
</template>

<script setup lang="ts">
import { store, actions } from '../views/overlay/store';
import { ICONS } from '../icons';

const handleClick = () => {
  actions.generateDescription();
};
</script>

<style scoped>
.pr-ai-desc-btn {
  display: inline-flex !important;
  align-items: center !important;
  gap: 6px !important;
  padding: 6px 10px !important;
  font-size: 12px !important;
  font-weight: 600 !important;
  line-height: 20px !important;
  color: #fff !important;
  background: linear-gradient(180deg, #238636, #1f7f32) !important;
  border: 1px solid rgba(255, 255, 255, 0.1) !important;
  border-radius: 24px !important;
  cursor: pointer !important;
  transition: all 0.2s cubic-bezier(0.3, 0, 0.5, 1) !important;
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(255, 255, 255, 0.1) !important;
  z-index: 10 !important;
  height: 32px !important;
  text-decoration: none !important;
}

.pr-ai-desc-btn:hover:not(:disabled) {
  transform: translateY(-1px) !important;
  box-shadow: 0 6px 12px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(255, 255, 255, 0.2) !important;
  background: linear-gradient(180deg, #2ea043, #238636) !important;
}

.pr-ai-desc-btn:active:not(:disabled) {
  transform: translateY(0) !important;
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(255, 255, 255, 0.1) !important;
}

.pr-ai-desc-btn:disabled {
  cursor: wait !important;
  opacity: 0.8 !important;
}

.pr-ai-desc-btn--loading {
  background: linear-gradient(180deg, #238636, #1f7f32) !important;
}

.pr-ai-desc-btn--error {
  background: #da3633 !important;
  border-color: #da3633 !important;
}

.pr-ai-desc-btn__text {
  white-space: nowrap !important;
  color: #fff !important;
}

.pr-ai-spinner {
  display: inline-flex !important;
  align-items: center !important;
}

.pr-ai-spinner svg {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* Deep style for the sparkles icon */
.pr-ai-desc-btn :deep(svg) {
  width: 14px;
  height: 14px;
  display: block;
}
</style>
