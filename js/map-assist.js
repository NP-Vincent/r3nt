// map-assist.js
// Helper utilities to open Google Maps links from within the Mini App.
function normaliseCoords(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const lat = Number(value.lat ?? value.latitude);
  const lon = Number(value.lon ?? value.lng ?? value.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  return { lat, lon };
}

function buildGoogleMapsUrl(lat, lon, label) {
  const q = `${lat},${lon}`;
  const encoded = encodeURIComponent(label ? `${label} @ ${q}` : q);
  return `https://www.google.com/maps/search/?api=1&query=${encoded}`;
}

function openUrl(url, { openInNewTab = true } = {}) {
  if (typeof window === "undefined") {
    throw new Error("window is not available in this environment.");
  }
  if (openInNewTab && typeof window.open === "function") {
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (opened) {
      return;
    }
  }
  if (!window.location) {
    throw new Error("window.location is not available in this environment.");
  }
  window.location.assign(url);
}

/**
 * Attempt to open Google Maps for the provided coordinates.
 * @param {number} lat
 * @param {number} lon
 * @param {{
 *   label?: string,
 *   openInNewTab?: boolean,
 * }} [options]
 */
export function openMapsAt(lat, lon, options = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("Latitude and longitude must be finite numbers.");
  }
  const { label, openInNewTab = true } = options;
  const url = buildGoogleMapsUrl(lat, lon, label);
  openUrl(url, { openInNewTab });
}

/**
 * Attach a click handler to a button (or any EventTarget) that triggers map navigation.
 * @param {Element|EventTarget|null} target
 * @param {{
 *   coords?: { lat: number, lon: number } | null,
 *   resolveCoords?: () => ({ lat: number, lon: number } | null | undefined),
 *   label?: string,
 *   openInNewTab?: boolean,
 *   onError?: (err: unknown) => void,
 * }} [options]
 */
export function attachNavigateHandler(target, options = {}) {
  if (!target || typeof target.addEventListener !== "function") {
    throw new Error("attachNavigateHandler expects an EventTarget with addEventListener.");
  }

  const {
    coords,
    resolveCoords,
    label,
    openInNewTab,
    onError,
  } = options;

  const invoke = (lat, lon) =>
    openMapsAt(lat, lon, { label, openInNewTab });

  const normaliseDirectCoords = () => {
    if (typeof resolveCoords === "function") {
      try {
        const resolved = resolveCoords();
        const normalised = normaliseCoords(resolved);
        if (normalised) {
          return normalised;
        }
      } catch (err) {
        if (typeof onError === "function") {
          onError(err);
        } else {
          console.error("Failed to resolve coordinates for map navigation", err);
        }
      }
    }

    const provided = normaliseCoords(coords);
    if (provided) {
      return provided;
    }

    const dataset = normaliseCoords(target?.dataset);
    if (dataset) {
      return dataset;
    }

    return null;
  };

  const handleError = (err) => {
    if (typeof onError === "function") {
      try {
        onError(err);
      } catch (notifyErr) {
        console.error("Error handler for map navigation threw", notifyErr);
      }
    } else {
      console.error("Map navigation failed", err);
    }
  };

  const safeInvoke = (lat, lon) => {
    try {
      invoke(lat, lon);
    } catch (err) {
      handleError(err);
    }
  };

  const handleClick = () => {
    const targetCoords = normaliseDirectCoords();
    if (targetCoords) {
      safeInvoke(targetCoords.lat, targetCoords.lon);
      return;
    }

    handleError(new Error("Coordinates unavailable for map navigation."));
  };

  target.addEventListener("click", handleClick);
  return () => target.removeEventListener("click", handleClick);
}

export function createOpenMapButton({
  lat,
  lon,
  label = "Open in Map",
  className = "inline-button",
  disabledTitle = "Coordinates unavailable",
  mapLabel,
  openInNewTab,
  onError,
} = {}) {
  if (typeof document === "undefined") {
    return null;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (className) {
    button.className = className;
  }

  const coords = normaliseCoords({ lat, lon });
  if (coords) {
    button.dataset.lat = String(coords.lat);
    button.dataset.lon = String(coords.lon);
    attachNavigateHandler(button, {
      label: mapLabel,
      openInNewTab,
      onError,
    });
  } else {
    button.disabled = true;
    if (disabledTitle) {
      button.title = disabledTitle;
    }
  }

  return button;
}

