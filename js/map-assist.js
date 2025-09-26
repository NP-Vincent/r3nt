import { el } from './ui/dom.js';

const GOOGLE_MAPS_SEARCH_URL = 'https://www.google.com/maps/search/?api=1';

const defaultOptions = {
  className: 'geo-map-link',
  label: 'Open in Map',
};

function buildQuery(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('Invalid coordinates supplied to createOpenMapButton');
  }
  const latNum = Number(lat);
  const lonNum = Number(lon);
  return `${latNum.toFixed(6)},${lonNum.toFixed(6)}`;
}

export function createOpenMapButton(options = {}) {
  const { lat, lon, className, label, onError } = { ...defaultOptions, ...options };

  let coords;
  try {
    coords = buildQuery(lat, lon);
  } catch (err) {
    if (typeof onError === 'function') {
      onError(err);
    }
    return null;
  }

  const query = encodeURIComponent(coords);
  const href = `${GOOGLE_MAPS_SEARCH_URL}&query=${query}`;

  const mapLink = el(
    'a',
    {
      href,
      target: '_blank',
      rel: 'noopener',
      class: className,
    },
    label,
  );

  mapLink.addEventListener('click', (event) => {
    event.preventDefault();
    const win = window.open(href, '_blank', 'noopener');
    if (win) {
      try {
        win.focus();
      } catch (_) {
        // ignore focus errors
      }
      return;
    }

    if (typeof onError === 'function') {
      onError(new Error('Map window was blocked.'));
    }
  });

  return mapLink;
}
