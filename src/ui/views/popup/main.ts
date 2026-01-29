import { createApp } from 'vue';
import App from './App.vue';
import '../../styles/popup.css';

// Create a container if it doesn't exist
let container = document.getElementById('app');
if (!container) {
  // If we are testing locally or things are weird, create one.
  // In the real popup.html, this should exist.
  container = document.createElement('div');
  container.id = 'app';
  document.body.prepend(container);
}

const app = createApp(App);
app.mount('#app');
