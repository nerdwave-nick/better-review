<template>
  <button class="pr-ai-description-btn btn btn-sm" :class="{
    'pr-ai-description-btn--loading': store.descriptionButtonState === 'loading',
    'pr-ai-description-btn--error': store.descriptionButtonState === 'error',
    'pr-ai-description-btn--floating': isFloating
  }" :disabled="store.descriptionButtonState === 'loading'" @click.prevent="handleClick"
    :title="store.descriptionButtonState === 'loading' ? 'Generating...' : 'Generate PR description using AI'">
    <span v-if="store.descriptionButtonState === 'loading'" class="pr-ai-spinner">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10" stroke-dasharray="50" stroke-linecap="round" />
      </svg>
    </span>
    <span v-else v-html="ICONS.SPARKLES"></span>

    <span v-if="store.descriptionButtonState === 'loading'">Generating...</span>
    <span v-else>AI Description</span>
  </button>
</template>

<script setup lang="ts">
import { store, actions } from '../views/overlay/store';
import { ICONS } from '../icons';

const props = defineProps<{
  isFloating?: boolean;
}>();

const handleClick = () => {
  actions.generateDescription();
};
</script>

<style scoped>
.pr-ai-spinner {
  display: inline-flex;
  align-items: center;
  margin-right: 4px;
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
</style>
