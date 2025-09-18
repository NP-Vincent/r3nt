(function () {
  if (typeof window === 'undefined') {
    return;
  }
  if (window.__DEV_ERROR_CONSOLE__) {
    return;
  }
  window.__DEV_ERROR_CONSOLE__ = true;

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
    'pointer-events:auto'
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

  function styleButton(btn) {
    btn.style.cssText = [
      'background:rgba(148,163,184,0.18)',
      'color:#f8fafc',
      'border:1px solid rgba(148,163,184,0.45)',
      'border-radius:6px',
      'padding:2px 8px',
      'font-size:11px',
      'line-height:1.4',
      'cursor:pointer'
    ].join(';');
  }

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.textContent = 'Hide';
  styleButton(toggleBtn);

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'Clear';
  styleButton(clearBtn);

  controls.appendChild(toggleBtn);
  controls.appendChild(clearBtn);

  header.appendChild(titleWrap);
  header.appendChild(controls);

  const logList = document.createElement('div');
  logList.style.cssText = 'overflow-y:auto;overflow-x:hidden;flex:1 1 auto;padding-right:4px;border-top:1px solid rgba(148,163,184,0.22)';

  root.appendChild(header);
  root.appendChild(logList);

  let collapsed = false;
  let entryCount = 0;
  const queue = [];
  let attached = false;

  function updateCounter() {
    counter.textContent = `(${entryCount})`;
  }

  function setCollapsed(next) {
    collapsed = Boolean(next);
    logList.style.display = collapsed ? 'none' : 'block';
    toggleBtn.textContent = collapsed ? 'Show' : 'Hide';
    root.style.opacity = collapsed ? '0.75' : '1';
  }

  toggleBtn.addEventListener('click', () => {
    setCollapsed(!collapsed);
  });

  clearBtn.addEventListener('click', () => {
    entryCount = 0;
    logList.innerHTML = '';
    updateCounter();
  });

  function ensureAttached() {
    if (attached) {
      return;
    }
    if (document.body) {
      document.body.appendChild(root);
      attached = true;
      if (queue.length) {
        queue.splice(0, queue.length).forEach(writeEntry);
      }
    } else {
      document.addEventListener('DOMContentLoaded', ensureAttached, { once: true });
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
      return JSON.stringify(value, function (key, val) {
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
      }, 2);
    } catch (err) {
      try {
        return String(value);
      } catch {
        return '[Unserializable value]';
      }
    }
  }

  function writeEntry(entry) {
    const { type, args, time } = entry;
    const entryEl = document.createElement('div');
    entryEl.style.cssText = 'padding:6px 0;border-bottom:1px solid rgba(71,85,105,0.35)';

    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:10px;color:#cbd5f5;margin-bottom:3px;letter-spacing:0.05em;text-transform:uppercase';
    const timeLabel = time.toLocaleTimeString();
    meta.textContent = `[${timeLabel}] ${type}`;

    const message = document.createElement('pre');
    message.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word;color:#f8fafc;font-size:12px';
    message.textContent = args.map(formatValue).join(' ');

    entryEl.appendChild(meta);
    entryEl.appendChild(message);

    logList.appendChild(entryEl);
    logList.scrollTop = logList.scrollHeight;
  }

  function addEntry(type, argsLike) {
    const args = Array.prototype.slice.call(argsLike ?? []);
    const payload = { type, args, time: new Date() };
    entryCount += 1;
    updateCounter();
    if (!attached) {
      queue.push(payload);
      ensureAttached();
      return;
    }
    writeEntry(payload);
  }

  window.addEventListener('error', (event) => {
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
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason !== undefined ? [event.reason] : ['Unknown rejection'];
    addEntry('unhandledrejection', reason);
  });

  const originalError = console.error ? console.error.bind(console) : null;
  console.error = function (...args) {
    addEntry('console.error', args);
    if (originalError) {
      originalError(...args);
    }
  };

  const originalWarn = console.warn ? console.warn.bind(console) : null;
  console.warn = function (...args) {
    addEntry('console.warn', args);
    if (originalWarn) {
      originalWarn(...args);
    }
  };

  ensureAttached();
})();
