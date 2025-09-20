const subscribers = new Set();
let counter = 0;

function clampTimeout(value) {
  if (value === null || value === undefined) {
    return 6000;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return 0;
  }
  if (num > 120000) {
    return 120000;
  }
  return Math.floor(num);
}

function normaliseVariant(input) {
  const value = typeof input === 'string' ? input.toLowerCase() : 'info';
  if (value === 'success' || value === 'error' || value === 'warning') {
    return value;
  }
  return 'info';
}

function normaliseRole(input) {
  if (typeof input !== 'string' || !input.trim()) {
    return 'all';
  }
  return input.trim().toLowerCase();
}

export function notify(options = {}) {
  const message = typeof options.message === 'string' ? options.message.trim() : '';
  if (!message) {
    return;
  }
  const entry = {
    id: `note-${Date.now()}-${counter++}`,
    message,
    variant: normaliseVariant(options.variant),
    role: normaliseRole(options.role),
    createdAt: new Date(),
    meta: options.meta || null,
    timeout: clampTimeout(options.timeout),
  };
  for (const subscriber of subscribers) {
    try {
      subscriber(entry);
    } catch (err) {
      console.error('Notification subscriber error', err);
    }
  }
}

export function subscribe(listener) {
  if (typeof listener !== 'function') {
    return () => {};
  }
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export function mountNotificationCenter(container, opts = {}) {
  if (!container) {
    return () => {};
  }
  const role = normaliseRole(opts.role || 'all');
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 4;
  const notifications = [];

  container.classList.add('notification-tray');

  const remove = (id) => {
    const idx = notifications.findIndex((entry) => entry.id === id);
    if (idx >= 0) {
      notifications.splice(idx, 1);
      render();
    }
  };

  const render = () => {
    container.innerHTML = '';
    for (const entry of notifications) {
      const card = document.createElement('div');
      card.className = `notification notification-${entry.variant}`;

      const text = document.createElement('div');
      text.className = 'notification-message';
      text.textContent = entry.message;
      card.appendChild(text);

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'notification-close';
      closeBtn.setAttribute('aria-label', 'Dismiss notification');
      closeBtn.textContent = '×';
      closeBtn.onclick = () => remove(entry.id);
      card.appendChild(closeBtn);

      container.appendChild(card);
    }
  };

  const unsubscribe = subscribe((entry) => {
    if (role !== 'all' && entry.role !== 'all' && entry.role !== role) {
      return;
    }
    notifications.push(entry);
    if (notifications.length > limit) {
      notifications.splice(0, notifications.length - limit);
    }
    render();
    if (entry.timeout > 0) {
      setTimeout(() => remove(entry.id), entry.timeout);
    }
  });

  return () => {
    unsubscribe();
    notifications.splice(0, notifications.length);
    container.innerHTML = '';
  };
}

export function formatNotificationTime(date) {
  if (!(date instanceof Date)) {
    return '';
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
