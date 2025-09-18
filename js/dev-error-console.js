(function () {
  if (typeof window === 'undefined') {
    return;
  }
  if (window.__DEV_ERROR_CONSOLE__) {
    return;
  }
  window.__DEV_ERROR_CONSOLE__ = true;

  const MAX_ENTRIES = 200;
  const pending = [];
  let writeEntry = null;

  const formatArg = (value) => {
    if (value instanceof Error) {
      const stack = value.stack && typeof value.stack === 'string' ? `\n${value.stack}` : '';
      const name = value.name || 'Error';
      const message = value.message || '';
      return `${name}: ${message}${stack}`.trim();
    }
    if (value === undefined) {
      return 'undefined';
    }
    if (value === null) {
      return 'null';
    }
    if (typeof value === 'object') {
      if (value && typeof value.type === 'string' && typeof value.message === 'string') {
        return `${value.type}: ${value.message}`;
      }
      try {
        return JSON.stringify(value, null, 2);
      } catch (err) {
        if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
          try {
            return value.toString();
          } catch (err2) {
            return Object.prototype.toString.call(value);
          }
        }
        return Object.prototype.toString.call(value);
      }
    }
    try {
      return String(value);
    } catch (err) {
      return '[unprintable]';
    }
  };

  const push = (type, args) => {
    if (writeEntry) {
      writeEntry(type, args);
    } else {
      pending.push({ type, args });
    }
  };

  const wrapConsole = (method, type) => {
    if (!console || typeof console[method] !== 'function') {
      return;
    }
    const original = console[method].bind(console);
    console[method] = function (...args) {
      try {
        push(type, args);
      } catch (err) {
        // ignore logging errors to avoid recursive failures
      }
      try {
        return original(...args);
      } catch (err) {
        return undefined;
      }
    };
  };

  wrapConsole('error', 'error');
  wrapConsole('warn', 'warn');
  wrapConsole('info', 'info');
  wrapConsole('log', 'log');

  window.addEventListener(
    'error',
    (event) => {
      const location = event && event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : '';
      const parts = [event && event.message ? event.message : 'Unhandled error'];
      if (location) {
        parts.push(location);
      }
      push('error', parts);
    },
    true
  );

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event ? event.reason : undefined;
    push('error', ['Unhandled rejection:', reason]);
  });

  const init = () => {
    if (!document.body || document.getElementById('dev-error-console')) {
      return;
    }

    const style = document.createElement('style');
    style.setAttribute('data-dev-error-console', '');
    style.textContent = `
      #dev-error-console { position: fixed; left: 0; right: 0; bottom: 0; z-index: 999999; color: #f8fafc; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; background: rgba(15, 23, 42, 0.94); box-shadow: 0 -4px 24px rgba(15, 23, 42, 0.45); }
      #dev-error-console * { box-sizing: border-box; }
      #dev-error-console .dev-error-console__header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid rgba(148, 163, 184, 0.35); font-size: 13px; font-weight: 600; letter-spacing: 0.02em; background: rgba(15, 23, 42, 0.92); }
      #dev-error-console .dev-error-console__title { display: inline-flex; align-items: center; gap: 6px; }
      #dev-error-console .dev-error-console__actions { display: inline-flex; align-items: center; gap: 6px; }
      #dev-error-console .dev-error-console__btn { appearance: none; border: 1px solid rgba(148, 163, 184, 0.5); background: rgba(148, 163, 184, 0.15); color: inherit; border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; transition: background 120ms ease, border-color 120ms ease; }
      #dev-error-console .dev-error-console__btn:hover { background: rgba(148, 163, 184, 0.3); border-color: rgba(148, 163, 184, 0.7); }
      #dev-error-console .dev-error-console__btn:focus { outline: 2px solid rgba(191, 219, 254, 0.8); outline-offset: 2px; }
      #dev-error-console .dev-error-console__log { max-height: 40vh; overflow-y: auto; padding: 8px 12px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
      #dev-error-console .dev-error-console__entry { margin-bottom: 6px; }
      #dev-error-console .dev-error-console__entry:last-child { margin-bottom: 0; }
      #dev-error-console .dev-error-console__entry--error { color: #fecaca; }
      #dev-error-console .dev-error-console__entry--warn { color: #fde68a; }
      #dev-error-console .dev-error-console__entry--info { color: #bfdbfe; }
      #dev-error-console .dev-error-console__entry--log { color: #e2e8f0; }
      #dev-error-console.is-collapsed { transform: translateY(calc(100% - 34px)); }
      #dev-error-console.is-collapsed .dev-error-console__log { display: none; }
    `;
    document.head.appendChild(style);

    const container = document.createElement('div');
    container.id = 'dev-error-console';
    container.setAttribute('role', 'log');
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-label', 'Development error console');

    const header = document.createElement('div');
    header.className = 'dev-error-console__header';

    const title = document.createElement('span');
    title.className = 'dev-error-console__title';
    title.textContent = 'Dev Error Console';

    const actions = document.createElement('div');
    actions.className = 'dev-error-console__actions';

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'dev-error-console__btn';
    clearBtn.textContent = 'Clear';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'dev-error-console__btn';
    toggleBtn.textContent = 'Hide';
    toggleBtn.setAttribute('aria-expanded', 'true');

    actions.appendChild(clearBtn);
    actions.appendChild(toggleBtn);
    header.appendChild(title);
    header.appendChild(actions);

    const log = document.createElement('div');
    log.className = 'dev-error-console__log';

    container.appendChild(header);
    container.appendChild(log);
    document.body.appendChild(container);

    const addEntry = (type, args) => {
      const entry = document.createElement('div');
      entry.className = `dev-error-console__entry dev-error-console__entry--${type}`;
      const timestamp = new Date().toLocaleTimeString();
      try {
        entry.textContent = `[${timestamp}] ${args.map((item) => formatArg(item)).join(' ')}`;
      } catch (err) {
        entry.textContent = `[${timestamp}] [unable to render log entry]`;
      }
      log.appendChild(entry);
      while (log.children.length > MAX_ENTRIES) {
        log.removeChild(log.firstChild);
      }
      log.scrollTop = log.scrollHeight;
    };

    clearBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      log.textContent = '';
    });

    toggleBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const collapsed = container.classList.toggle('is-collapsed');
      toggleBtn.textContent = collapsed ? 'Show' : 'Hide';
      toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });

    writeEntry = addEntry;
    if (pending.length) {
      pending.forEach((item) => addEntry(item.type, item.args));
      pending.length = 0;
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
