(function () {
  if (typeof window === 'undefined') {
    return;
  }

  const STORAGE_KEY = 'r3nt:devConsoleEnabled';
  const MANAGER_KEY = '__R3NT_DEV_CONSOLE_MANAGER__';

  function normalizeBoolean(value) {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const lowered = value.toLowerCase();
      if (lowered === 'true') return true;
      if (lowered === 'false') return false;
    }
    return null;
  }

  const settings = window.__R3NT_DEV_SETTINGS__ || {};
  const overrideSetting = normalizeBoolean(settings.devConsoleOverride);
  const OVERRIDE = overrideSetting === null ? null : overrideSetting;
  const defaultSetting = normalizeBoolean(settings.devConsoleDefault);
  const DEFAULT_ENABLED = defaultSetting === null ? false : defaultSetting;
  const traceSetting = normalizeBoolean(settings.showTrace);
  const SHOW_TRACE = traceSetting === null ? true : traceSetting;

  if (window[MANAGER_KEY]) {
    return;
  }

  const state = {
    root: null,
    logList: null,
    toggleBtn: null,
    clearBtn: null,
    copyBtn: null,
    counter: null,
    collapsed: false,
    entryCount: 0,
    entries: [],
    queue: [],
    attached: false,
    copyResetTimer: null,
    originalError: null,
    originalWarn: null,
    originalInfo: null,
    originalDebug: null,
    domReadyListener: null,
  };

  function readStored() {
    if (OVERRIDE !== null) {
      return OVERRIDE;
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === '1') {
        return true;
      }
      if (raw === '0') {
        return false;
      }
      if (raw === null) {
        return DEFAULT_ENABLED;
      }
      return raw === '1';
    } catch (err) {
      return DEFAULT_ENABLED;
    }
  }

  function writeStored(enabled) {
    if (OVERRIDE !== null) {
      return;
    }
    try {
      if (enabled) {
        window.localStorage.setItem(STORAGE_KEY, '1');
      } else {
        window.localStorage.setItem(STORAGE_KEY, '0');
      }
    } catch (err) {
      // ignore storage errors
    }
  }

  function updateCounter() {
    if (state.counter) {
      state.counter.textContent = `(${state.entryCount})`;
    }
  }

  function setCollapsed(next) {
    state.collapsed = Boolean(next);
    if (state.logList) {
      state.logList.style.display = state.collapsed ? 'none' : 'block';
    }
    if (state.toggleBtn) {
      state.toggleBtn.textContent = state.collapsed ? 'Show' : 'Hide';
    }
    if (state.root) {
      state.root.style.opacity = state.collapsed ? '0.75' : '1';
    }
  }

  function entryToText(entry) {
    const timeLabel = entry.time.toLocaleTimeString();
    const messageText = entry.args.map(formatValue).join(' ');
    if (messageText) {
      return `[${timeLabel}] ${entry.type}\n${messageText}`;
    }
    return `[${timeLabel}] ${entry.type}`;
  }

  function resetCopyButton(text) {
    if (!state.copyBtn) {
      return;
    }
    if (state.copyResetTimer) {
      clearTimeout(state.copyResetTimer);
      state.copyResetTimer = null;
    }
    state.copyBtn.textContent = text;
    state.copyResetTimer = setTimeout(() => {
      if (state.copyBtn) {
        state.copyBtn.textContent = 'Copy';
      }
      state.copyResetTimer = null;
    }, 1500);
  }

  function legacyCopy(text) {
    if (!document.body) {
      return false;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position:absolute;left:-9999px;top:auto;width:1px;height:1px;opacity:0';
    document.body.appendChild(textarea);
    textarea.select();
    if (typeof textarea.setSelectionRange === 'function') {
      textarea.setSelectionRange(0, text.length);
    }
    let success = false;
    try {
      success = document.execCommand('copy');
    } catch (err) {
      success = false;
    }
    document.body.removeChild(textarea);
    return success;
  }

  async function copyEntriesToClipboard() {
    const text = state.entries.map(entryToText).join('\n\n');
    if (!text) {
      resetCopyButton('No logs');
      return;
    }
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        resetCopyButton('Copied!');
        return;
      }
    } catch (err) {
      // fall back to legacy path
    }
    if (legacyCopy(text)) {
      resetCopyButton('Copied!');
      return;
    }
    resetCopyButton('Copy failed');
  }

  function ensureAttached() {
    if (!state.root || state.attached) {
      return;
    }
    if (document.body) {
      document.body.appendChild(state.root);
      state.attached = true;
      if (state.queue.length) {
        const queued = state.queue.splice(0, state.queue.length);
        queued.forEach(writeEntry);
      }
    } else if (!state.domReadyListener) {
      state.domReadyListener = () => {
        state.domReadyListener = null;
        ensureAttached();
      };
      document.addEventListener('DOMContentLoaded', state.domReadyListener, { once: true });
    }
  }

  function formatValue(value) {
    if (value instanceof Error) {
      return value.stack || `${value.name || 'Error'}: ${value.message}`;
    }
    const type = typeof value;
    if (type === 'string') {
      return value;
    }
    if (type === 'number' || type === 'boolean' || value === null) {
      return String(value);
    }
    if (type === 'undefined') {
      return 'undefined';
    }
    if (type === 'bigint') {
      return value.toString();
    }
    if (type === 'function') {
      return value.toString();
    }
    try {
      const seen = new WeakSet();
      return JSON.stringify(
        value,
        function (key, val) {
          if (val instanceof Error) {
            return val.stack || `${val.name || 'Error'}: ${val.message}`;
          }
          if (typeof val === 'object' && val !== null) {
            if (seen.has(val)) {
              return '[Circular]';
            }
            seen.add(val);
          }
          return val;
        },
        2
      );
    } catch (err) {
      try {
        return String(value);
      } catch (stringErr) {
        return '[Unserializable value]';
      }
    }
  }

  function writeEntry(entry) {
    if (!state.logList) {
      return;
    }
    const entryEl = document.createElement('div');
    entryEl.style.cssText = 'padding:6px 0;border-bottom:1px solid rgba(71,85,105,0.35)';

    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:10px;color:#cbd5f5;margin-bottom:3px;letter-spacing:0.05em;text-transform:uppercase';
    const timeLabel = entry.time.toLocaleTimeString();
    meta.textContent = `[${timeLabel}] ${entry.type}`;

    const message = document.createElement('pre');
    message.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word;color:#f8fafc;font-size:12px';
    message.textContent = entry.args.map(formatValue).join(' ');

    entryEl.appendChild(meta);
    entryEl.appendChild(message);

    state.logList.appendChild(entryEl);
    state.logList.scrollTop = state.logList.scrollHeight;
  }

  function shouldDisplay(type) {
    if (SHOW_TRACE) {
      return true;
    }
    return type !== 'console.info' && type !== 'console.debug' && type !== 'trace';
  }

  function addEntry(type, argsLike) {
    if (!shouldDisplay(type)) {
      return;
    }
    const args = Array.prototype.slice.call(argsLike ?? []);
    const payload = { type, args, time: new Date() };
    state.entries.push(payload);
    state.entryCount += 1;
    updateCounter();
    if (!state.attached || !state.logList) {
      state.queue.push(payload);
      ensureAttached();
      return;
    }
    writeEntry(payload);
  }

  const handlers = {
    toggle: () => {
      setCollapsed(!state.collapsed);
    },
    clear: () => {
      state.entryCount = 0;
      state.entries = [];
      state.queue = [];
      updateCounter();
      if (state.logList) {
        state.logList.innerHTML = '';
      }
      if (state.copyResetTimer) {
        clearTimeout(state.copyResetTimer);
        state.copyResetTimer = null;
      }
      if (state.copyBtn) {
        state.copyBtn.textContent = 'Copy';
      }
    },
    copy: () => {
      copyEntriesToClipboard();
    },
    windowError: (event) => {
      const details = [];
      if (event.message) {
        details.push(event.message);
      }
      if (event.filename) {
        const location = `${event.filename}${event.lineno ? `:${event.lineno}` : ''}${event.colno ? `:${event.colno}` : ''}`;
        details.push(location);
      }
      if (event.error) {
        details.push(event.error);
      }
      addEntry('window.error', details);
    },
    unhandledRejection: (event) => {
      const reason = event.reason !== undefined ? [event.reason] : ['Unknown rejection'];
      addEntry('unhandledrejection', reason);
    },
    consoleError: (...args) => {
      addEntry('console.error', args);
      if (typeof state.originalError === 'function') {
        state.originalError.apply(console, args);
      }
    },
    consoleWarn: (...args) => {
      addEntry('console.warn', args);
      if (typeof state.originalWarn === 'function') {
        state.originalWarn.apply(console, args);
      }
    },
    consoleInfo: (...args) => {
      addEntry('console.info', args);
      if (typeof state.originalInfo === 'function') {
        state.originalInfo.apply(console, args);
      }
    },
    consoleDebug: (...args) => {
      addEntry('console.debug', args);
      if (typeof state.originalDebug === 'function') {
        state.originalDebug.apply(console, args);
      }
    },
  };

  function styleButton(btn) {
    btn.style.cssText = [
      'background:rgba(148,163,184,0.18)',
      'color:#f8fafc',
      'border:1px solid rgba(148,163,184,0.45)',
      'border-radius:6px',
      'padding:2px 8px',
      'font-size:11px',
      'line-height:1.4',
      'cursor:pointer',
    ].join(';');
  }

  function buildConsoleDom() {
    const root = document.createElement('div');
    root.id = 'dev-error-console';
    root.style.cssText = [
      'position:fixed',
      'left:0',
      'right:0',
      'bottom:0',
      'z-index:2147483647',
      'display:flex',
      'flex-direction:column',
      'gap:6px',
      'max-height:40vh',
      'background:rgba(15,23,42,0.96)',
      'color:#f8fafc',
      'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace',
      'padding:8px 12px 10px',
      'border-top:2px solid #f97316',
      'box-shadow:0 -6px 18px rgba(15,23,42,0.35)',
      'pointer-events:auto',
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:12px;min-height:20px';

    const titleWrap = document.createElement('div');
    titleWrap.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#fbbf24';

    const title = document.createElement('span');
    title.textContent = 'Dev Error Console';

    const counter = document.createElement('span');
    counter.textContent = '(0)';
    counter.style.cssText = 'color:#f1f5f9;font-weight:600;text-transform:none';

    titleWrap.appendChild(title);
    titleWrap.appendChild(counter);

    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;align-items:center;gap:8px;margin-left:auto';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.textContent = 'Hide';
    styleButton(toggleBtn);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = 'Clear';
    styleButton(clearBtn);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy';
    styleButton(copyBtn);

    controls.appendChild(toggleBtn);
    controls.appendChild(clearBtn);
    controls.appendChild(copyBtn);

    header.appendChild(titleWrap);
    header.appendChild(controls);

    const logList = document.createElement('div');
    logList.style.cssText = 'overflow-y:auto;overflow-x:hidden;flex:1 1 auto;padding-right:4px;border-top:1px solid rgba(148,163,184,0.22)';

    root.appendChild(header);
    root.appendChild(logList);

    state.root = root;
    state.logList = logList;
    state.toggleBtn = toggleBtn;
    state.clearBtn = clearBtn;
    state.copyBtn = copyBtn;
    state.counter = counter;

    toggleBtn.addEventListener('click', handlers.toggle);
    clearBtn.addEventListener('click', handlers.clear);
    copyBtn.addEventListener('click', handlers.copy);

    setCollapsed(false);
    updateCounter();
  }

  function mountConsole() {
    if (state.root) {
      return;
    }
    state.entries = [];
    state.queue = [];
    state.entryCount = 0;
    state.collapsed = false;
    buildConsoleDom();
    ensureAttached();
    window.addEventListener('error', handlers.windowError);
    window.addEventListener('unhandledrejection', handlers.unhandledRejection);
    state.originalError = typeof console.error === 'function' ? console.error : null;
    console.error = function (...args) {
      handlers.consoleError(...args);
    };
    state.originalWarn = typeof console.warn === 'function' ? console.warn : null;
    console.warn = function (...args) {
      handlers.consoleWarn(...args);
    };
    state.originalInfo = typeof console.info === 'function' ? console.info : null;
    console.info = function (...args) {
      handlers.consoleInfo(...args);
    };
    state.originalDebug = typeof console.debug === 'function' ? console.debug : null;
    console.debug = function (...args) {
      handlers.consoleDebug(...args);
    };
    window.__DEV_ERROR_CONSOLE__ = true;
  }

  function teardownDom() {
    if (state.toggleBtn) {
      state.toggleBtn.removeEventListener('click', handlers.toggle);
    }
    if (state.clearBtn) {
      state.clearBtn.removeEventListener('click', handlers.clear);
    }
    if (state.copyBtn) {
      state.copyBtn.removeEventListener('click', handlers.copy);
    }
    if (state.root && state.root.parentNode) {
      state.root.parentNode.removeChild(state.root);
    }
    state.root = null;
    state.logList = null;
    state.toggleBtn = null;
    state.clearBtn = null;
    state.copyBtn = null;
    state.counter = null;
    state.attached = false;
    if (state.domReadyListener) {
      document.removeEventListener('DOMContentLoaded', state.domReadyListener);
      state.domReadyListener = null;
    }
  }

  function unmountConsole() {
    if (!state.root && !state.attached) {
      window.__DEV_ERROR_CONSOLE__ = false;
      return;
    }
    teardownDom();
    if (state.copyResetTimer) {
      clearTimeout(state.copyResetTimer);
      state.copyResetTimer = null;
    }
    state.entries = [];
    state.queue = [];
    state.entryCount = 0;
    state.collapsed = false;
    window.removeEventListener('error', handlers.windowError);
    window.removeEventListener('unhandledrejection', handlers.unhandledRejection);
    if (state.originalError !== null) {
      console.error = state.originalError;
      state.originalError = null;
    }
    if (state.originalWarn !== null) {
      console.warn = state.originalWarn;
      state.originalWarn = null;
    }
    if (state.originalInfo !== null) {
      console.info = state.originalInfo;
      state.originalInfo = null;
    }
    if (state.originalDebug !== null) {
      console.debug = state.originalDebug;
      state.originalDebug = null;
    }
    window.__DEV_ERROR_CONSOLE__ = false;
  }

  function enable() {
    writeStored(true);
    mountConsole();
  }

  function disable() {
    writeStored(false);
    unmountConsole();
  }

  function setEnabled(value) {
    if (OVERRIDE !== null) {
      if (OVERRIDE) {
        enable();
      } else {
        disable();
      }
      return OVERRIDE;
    }
    if (value) {
      enable();
    } else {
      disable();
    }
    return value;
  }

  function isEnabled() {
    return readStored();
  }

  function isActive() {
    return Boolean(state.root);
  }

  const manager = { enable, disable, setEnabled, isEnabled, isActive };
  window.r3ntDevConsole = manager;
  window[MANAGER_KEY] = manager;
  window.__R3NT_TRACE_LOG__ = function (...args) {
    addEntry('trace', args);
  };

  if (isEnabled()) {
    enable();
  } else {
    window.__DEV_ERROR_CONSOLE__ = false;
  }
})();
