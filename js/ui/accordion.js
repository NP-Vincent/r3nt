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
