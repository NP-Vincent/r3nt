const DEFAULT_DELAY_MS = 60_000;
const DEFAULT_IDLE_THRESHOLD_MS = 15_000;
const SAMPLE_INTERVAL_MS = 1_000;

let hasPromptedAddMiniApp = false;
let activeController = null;

const engagementEvents = [
  { target: window, name: 'pointerdown', options: { passive: true } },
  { target: window, name: 'touchstart', options: { passive: true } },
  { target: window, name: 'keydown', options: false },
  { target: window, name: 'scroll', options: { passive: true } },
];

function attachEngagementListeners(handler) {
  engagementEvents.forEach(({ target, name, options }) => {
    target.addEventListener(name, handler, options);
  });
}

function detachEngagementListeners(handler) {
  engagementEvents.forEach(({ target, name, options }) => {
    target.removeEventListener(name, handler, options);
  });
}

export function initializeAddToCollectionPrompt({
  sdk,
  delayMs = DEFAULT_DELAY_MS,
  idleThresholdMs = DEFAULT_IDLE_THRESHOLD_MS,
} = {}) {
  if (hasPromptedAddMiniApp) {
    return () => {};
  }
  if (!sdk || typeof sdk.actions?.addMiniApp !== 'function') {
    return () => {};
  }
  if (activeController) {
    return activeController.dispose;
  }

  let disposed = false;
  let engagedMs = 0;
  let lastInteractionAt = 0;
  let intervalId = 0;

  const maybeTriggerPrompt = async () => {
    if (disposed || hasPromptedAddMiniApp) {
      return;
    }
    if (engagedMs < delayMs) {
      return;
    }
    hasPromptedAddMiniApp = true;
    cleanup();
    try {
      await sdk.actions.addMiniApp();
    } catch (error) {
      console.warn('[r3nt] addMiniApp prompt could not be shown', error);
    }
  };

  const sampleEngagement = () => {
    if (disposed || hasPromptedAddMiniApp || !lastInteractionAt) {
      return;
    }
    const now = Date.now();
    const sinceLastInteraction = now - lastInteractionAt;
    if (sinceLastInteraction <= idleThresholdMs) {
      engagedMs = Math.min(engagedMs + SAMPLE_INTERVAL_MS, delayMs);
      maybeTriggerPrompt();
    }
  };

  const markInteraction = () => {
    if (disposed || hasPromptedAddMiniApp) {
      return;
    }
    lastInteractionAt = Date.now();
    if (!intervalId) {
      intervalId = window.setInterval(sampleEngagement, SAMPLE_INTERVAL_MS);
    }
  };

  const handleVisibilityChange = () => {
    if (disposed || hasPromptedAddMiniApp) {
      return;
    }
    if (document.visibilityState === 'hidden') {
      lastInteractionAt = 0;
    } else if (document.visibilityState === 'visible') {
      markInteraction();
    }
  };

  const cleanup = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    detachEngagementListeners(markInteraction);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    if (intervalId) {
      window.clearInterval(intervalId);
      intervalId = 0;
    }
    activeController = null;
  };

  attachEngagementListeners(markInteraction);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  activeController = { dispose: cleanup };
  return cleanup;
}
