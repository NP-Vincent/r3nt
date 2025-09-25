const COLLAPSIBLE_CONTROL = Symbol('collapsibleControl');
let nextCollapsibleId = 0;

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    if (lowered === '1' || lowered === 'true' || lowered === 'yes') return true;
    if (lowered === '0' || lowered === 'false' || lowered === 'no') return false;
  }
  return fallback;
}

export function makeCollapsible(section, { defaultOpen } = {}) {
  if (!section) return null;
  if (section[COLLAPSIBLE_CONTROL]) {
    return section[COLLAPSIBLE_CONTROL];
  }

  const content = section.querySelector('[data-collapsible-content]');
  const toggle  = section.querySelector('[data-collapsible-toggle]');
  if (!content || !toggle) return null;

  if (!content.id) {
    nextCollapsibleId += 1;
    content.id = `collapsible-${nextCollapsibleId}`;
  }
  toggle.setAttribute('aria-controls', content.id);

  const setOpen = (open) => {
    const next = Boolean(open);
    section.dataset.open = next ? '1' : '0';
    content.hidden = !next;
    toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
  };

  const handleToggle = () => setOpen(content.hidden);
  const handleKey = (event) => {
    if (event.key === ' ' || event.key === 'Spacebar' || event.key === 'Enter') {
      event.preventDefault();
      setOpen(content.hidden);
    }
  };

  toggle.addEventListener('click', handleToggle);
  toggle.addEventListener('keydown', handleKey);

  const datasetPreference = section.dataset.open;
  const ariaPreference = toggle.getAttribute('aria-expanded');
  const initialOpen =
    toBoolean(defaultOpen, null) ??
    (datasetPreference !== undefined ? datasetPreference === '1' : null) ??
    (ariaPreference !== null ? ariaPreference === 'true' : null);

  setOpen(initialOpen ?? false);

  const control = { section, content, toggle, setOpen };
  section[COLLAPSIBLE_CONTROL] = control;
  section.dataset.collapsibleBound = '1';
  return control;
}

export function mountCollapsibles(root) {
  const target = root ?? (typeof document !== 'undefined' ? document : null);
  if (!target || typeof target.querySelectorAll !== 'function') {
    return [];
  }
  return Array.from(target.querySelectorAll('[data-collapsible]'))
    .map((section) => makeCollapsible(section))
    .filter(Boolean);
}

export function createCollapsibleSection(label, { id, classes = [] } = {}) {
  const section = document.createElement('section');
  section.className = ['card', ...classes].filter(Boolean).join(' ');
  section.dataset.collapsible = '';
  if (id) section.id = id;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'inline-button collapsible-toggle';
  toggle.dataset.collapsibleToggle = '';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.textContent = label;
  section.appendChild(toggle);

  const content = document.createElement('div');
  content.dataset.collapsibleContent = '';
  content.hidden = true;
  section.appendChild(content);

  const control = makeCollapsible(section, { defaultOpen: false }) || {};

  const setOpen = control.setOpen
    || ((open) => {
      const next = Boolean(open);
      section.dataset.open = next ? '1' : '0';
      content.hidden = !next;
      toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
    });

  return { section, content, toggle, setOpen };
}
