export function makeCollapsible(section) {
  const content = section.querySelector('[data-collapsible-content]');
  const toggle  = section.querySelector('[data-collapsible-toggle]');
  if (!content || !toggle) return;
  const setOpen = (open) => {
    section.dataset.open = open ? '1' : '0';
    content.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setOpen(content.hidden));
  // default: collapsed on load for long pages
  setOpen(false);
}

export function createCollapsibleSection(label, { id, classes = [] } = {}) {
  const section = document.createElement('section');
  section.className = ['card', ...classes].filter(Boolean).join(' ');
  section.dataset.collapsible = '';
  if (id) section.id = id;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'inline-button';
  toggle.dataset.collapsibleToggle = '';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.textContent = label;
  section.appendChild(toggle);

  const content = document.createElement('div');
  content.dataset.collapsibleContent = '';
  content.hidden = true;
  section.appendChild(content);

  makeCollapsible(section);

  const setOpen = (open) => {
    section.dataset.open = open ? '1' : '0';
    content.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  return { section, content, toggle, setOpen };
}
