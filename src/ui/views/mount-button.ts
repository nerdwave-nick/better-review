import { createApp, App } from 'vue';
import PRDescriptionButton from '../components/PRDescriptionButton.vue';

let activeApp: App | null = null;
let activeContainer: Element | null = null;

export function mountDescriptionButton(target: Element, nearTextarea = false) {
  // Check if already mounted and still in DOM
  if (activeApp && activeContainer?.isConnected) {
    return { app: activeApp, container: activeContainer };
  }

  // Clean up any stale references
  if (activeApp) {
    activeApp.unmount();
    activeApp = null;
  }
  if (activeContainer) {
    activeContainer.remove();
    activeContainer = null;
  }

  // Create a container div for the Vue app
  const container = document.createElement('div');
  container.className = 'pr-ai-description-btn-wrapper';

  if (nearTextarea) {
    // Position button floating inside the textarea (bottom-right)
    container.style.position = 'absolute';
    container.style.bottom = '12px';
    container.style.right = '12px';
    container.style.zIndex = '5';
    // Ensure it doesn't block interactions underneath if it were transparent, but it's a button so it should block.
    
    // Find the wrapper of the textarea to position relative to it
    // Usually textarea is inside a write-content or similar wrapper
    const parent = target.parentElement;
    if (parent) {
      const computedStyle = window.getComputedStyle(parent);
      if (computedStyle.position === 'static') {
        parent.style.position = 'relative';
      }
      parent.appendChild(container);
    } else {
       // Fallback
       if (target.parentNode) {
         target.parentNode.insertBefore(container, target);
       }
    }
  } else {
    container.style.display = 'inline-block';
    container.style.marginRight = '8px';
    const firstButton = target.querySelector('button, .btn');
    if (firstButton) {
      target.insertBefore(container, firstButton);
    } else {
      target.appendChild(container);
    }
  }

  activeContainer = container;

  const app = createApp(PRDescriptionButton);
  app.mount(container);
  activeApp = app;

  return { app, container };
}

export function unmountDescriptionButton() {
  if (activeApp) {
    activeApp.unmount();
    activeApp = null;
  }
  if (activeContainer) {
    activeContainer.remove();
    activeContainer = null;
  }
}
