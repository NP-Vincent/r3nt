import { sdk } from 'https://esm.sh/@farcaster/miniapp-sdk';
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

  mapLink.addEventListener('click', async (event) => {
    event.preventDefault();

    if (sdk?.actions?.openUrl) {
      try {
        await sdk.actions.openUrl(href);
        return;
      } catch (err) {
        if (typeof onError === 'function') {
          onError(err);
        }
        // fall through to window.open fallback
      }
    }

    let win;
    try {
      win = window.open(href, '_blank', 'noopener,noreferrer');
    } catch (err) {
      if (typeof onError === 'function') {
        onError(err);
      }
      return;
    }

    if (!win) {
      return;
    }

    win.opener = null;
    try {
      win.focus();
    } catch (_) {
      // ignore focus errors
    }
  });

  return mapLink;
}
