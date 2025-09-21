import { sdk as importedSdk } from 'https://esm.sh/@farcaster/miniapp-sdk';

function normaliseCapabilities(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.toLowerCase() : ''))
      .filter(Boolean);
  }
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([key, val]) => {
      if (!val) return [];
      return typeof key === 'string' ? [key.toLowerCase()] : [];
    });
  }
  return [];
}

function detectBackCapability(capabilities) {
  const caps = normaliseCapabilities(capabilities);
  if (!caps.length) return true;
  return caps.some((item) =>
    item === 'back' ||
    item === 'navigation.back' ||
    item === 'backnavigation' ||
    item === 'sdk.back' ||
    item === 'backbutton'
  );
}

function ensureBaseHistoryState() {
  try {
    const state = window.history.state;
    if (!state || state.__r3ntBack !== true) {
      window.history.replaceState({ __r3ntBack: true, depth: 0 }, '', window.location.href);
    }
  } catch (err) {
    console.warn('Unable to seed history state', err);
  }
}

export function createBackController({ sdk = importedSdk, button, isDeep } = {}) {
  const stack = [];
  let externalDepthCheck = typeof isDeep === 'function' ? isDeep : null;
  let hostSupportsBack = true;
  let initialized = false;

  ensureBaseHistoryState();

  const update = () => {
    const active = stack.length > 0 || Boolean(externalDepthCheck?.());
    if (button) {
      if (active) {
        button.removeAttribute('hidden');
      } else {
        button.setAttribute('hidden', '');
      }
    }
    if (hostSupportsBack && sdk?.back) {
      try {
        if (active) {
          sdk.back.show?.();
        } else {
          sdk.back.hide?.();
        }
      } catch (err) {
        console.warn('Failed toggling host back affordance', err);
      }
    }
    return active;
  };

  const evaluateCapabilities = async () => {
    if (!sdk?.back) {
      update();
      return;
    }
    if (!initialized) {
      initialized = true;
      try {
        await sdk.back.enableWebNavigation?.();
      } catch (err) {
        console.warn('enableWebNavigation failed', err);
      }
    }
    try {
      const capabilities = await sdk.getCapabilities?.();
      hostSupportsBack = detectBackCapability(capabilities);
    } catch {
      hostSupportsBack = true;
    }
    update();
  };

  evaluateCapabilities().catch((err) => console.warn('Back capability detection failed', err));

  const callHandler = (entry) => {
    if (entry?.onPop) {
      try {
        entry.onPop();
      } catch (err) {
        console.error('Back stack handler error', err);
      }
    }
  };

  const push = (entry = {}) => {
    const record = { onPop: typeof entry.onPop === 'function' ? entry.onPop : null };
    stack.push(record);
    try {
      window.history.pushState({ __r3ntBack: true, depth: stack.length }, '', window.location.href);
    } catch (err) {
      console.warn('pushState failed', err);
    }
    update();
    return record;
  };

  const reset = ({ skipHandlers = false } = {}) => {
    if (!stack.length) {
      update();
      return;
    }
    const handlers = skipHandlers ? [] : [...stack].reverse();
    stack.length = 0;
    if (!skipHandlers) {
      for (const entry of handlers) {
        callHandler(entry);
      }
    }
    try {
      window.history.replaceState({ __r3ntBack: true, depth: 0 }, '', window.location.href);
    } catch (err) {
      console.warn('replaceState failed during reset', err);
    }
    update();
  };

  const pop = ({ skipHistory = false } = {}) => {
    if (!stack.length) {
      if (!skipHistory) {
        try {
          window.history.back();
        } catch (err) {
          console.warn('history.back failed without stack', err);
        }
      }
      return false;
    }
    const entry = stack.pop();
    callHandler(entry);
    if (!skipHistory) {
      try {
        window.history.back();
      } catch (err) {
        console.warn('history.back failed', err);
        update();
      }
    } else {
      update();
    }
    return true;
  };

  window.addEventListener('popstate', (event) => {
    const state = event.state;
    if (state && state.__r3ntBack === true) {
      const depth = Number(state.depth) || 0;
      if (depth < stack.length) {
        while (stack.length > depth) {
          const entry = stack.pop();
          callHandler(entry);
        }
      }
      update();
    } else if (stack.length) {
      while (stack.length) {
        const entry = stack.pop();
        callHandler(entry);
      }
      update();
    }
  });

  if (sdk?.back) {
    sdk.back.onBack = () => pop({ skipHistory: false });
  }

  if (typeof sdk?.on === 'function') {
    sdk.on('backNavigationTriggered', () => {
      setTimeout(update, 0);
    });
  }

  if (button) {
    button.addEventListener('click', async () => {
      if (!sdk?.back) {
        pop({ skipHistory: false });
        return;
      }
      try {
        if (typeof sdk.back.trigger === 'function') {
          await sdk.back.trigger();
          return;
        }
      } catch (err) {
        console.warn('sdk.back.trigger failed', err);
      }
      pop({ skipHistory: false });
    });
  }

  return {
    push,
    back: () => pop({ skipHistory: false }),
    pop,
    reset,
    depth: () => stack.length,
    update,
    setExternalStateGetter(fn) {
      externalDepthCheck = typeof fn === 'function' ? fn : null;
      update();
    },
  };
}

export default createBackController;
