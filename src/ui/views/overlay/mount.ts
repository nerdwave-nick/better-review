import { createApp } from 'vue';
import OverlayApp from './OverlayApp.vue';
import { store, actions } from './store';

export function mountOverlay() {
  const hostId = 'pr-ai-overlay-host';
  let host = document.getElementById(hostId);

  if (host) {
    // Already mounted
    return { store, actions };
  }

  host = document.createElement('div');
  host.id = hostId;
  host.style.position = 'fixed';
  host.style.top = '0';
  host.style.left = '0';
  host.style.width = '100%';
  host.style.height = '100%';
  host.style.zIndex = '2147483647';
  host.style.pointerEvents = 'none';

  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  // Inject Styles
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('content/styles.css');
  shadow.appendChild(link);

  const appRoot = document.createElement('div');
  appRoot.style.pointerEvents = 'none'; // Root container transparent to clicks
  appRoot.style.width = '100%';
  appRoot.style.height = '100%';
  shadow.appendChild(appRoot);

  const app = createApp(OverlayApp);
  app.mount(appRoot);

  return { store, actions };
}
