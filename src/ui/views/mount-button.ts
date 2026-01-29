import { createApp, App } from 'vue';
import PRDescriptionButton from '../components/PRDescriptionButton.vue';

let activeApp: App | null = null;
let activeContainer: Element | null = null;

export function mountDescriptionButton(target: Element, isFloating = false) {
  // If we already have an app mounted, unmount it
  if (activeApp) {
    activeApp.unmount();
    activeApp = null;
    if (activeContainer && activeContainer.parentNode) {
      activeContainer.remove();
    }
  }

  // Create a container div for the Vue app
  const container = document.createElement('div');
  container.className = 'pr-ai-description-btn-wrapper';
  if (isFloating) {
    container.style.position = 'fixed';
    container.style.bottom = '20px';
    container.style.right = '20px';
    container.style.zIndex = '1000';
  } else {
    container.style.display = 'inline-block';
    container.style.marginRight = '8px';
  }

  // Insert the container
  if (isFloating) {
    document.body.appendChild(container);
  } else {
    const firstButton = target.querySelector('button, .btn');
    if (firstButton) {
      target.insertBefore(container, firstButton);
    } else {
      target.appendChild(container); // or insertBefore firstChild
    }
  }

  activeContainer = container;

  const app = createApp(PRDescriptionButton, { isFloating });
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
