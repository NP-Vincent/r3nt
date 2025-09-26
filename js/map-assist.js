// map-assist.js
// Helper utilities to open native mapping apps from within the Mini App.
// Based on recommended platform-specific behaviour for iOS, Android and web.

const DEFAULT_FALLBACK_COORDS = Object.freeze({ lat: 25.1972, lon: 55.2744 });

/**
 * Detect the user's mobile platform from the provided user agent string.
 * @param {string} [userAgent]
 * @returns {"ios"|"android"|"other"}
 */
export function detectPlatform(userAgent = (typeof navigator !== "undefined" ? navigator.userAgent : "")) {
  if (typeof userAgent !== "string") return "other";
  if (/iPad|iPhone|iPod/i.test(userAgent)) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return "other";
}

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

/**
 * Build the best mapping URL for the active platform.
 * @param {number} lat
 * @param {number} lon
 * @param {"ios"|"android"|"other"} [platform]
 */
function buildNavigation(lat, lon, platform = detectPlatform()) {
  const q = `${lat},${lon}`;
  if (platform === "ios") {
    return { primary: `https://maps.apple.com/?q=${q}&ll=${q}&z=16` };
  }
  if (platform === "android") {
    return {
      primary: `geo:${q}?q=${q}`,
      fallback: `https://maps.google.com/?q=${q}`,
    };
  }
  return { primary: `https://maps.google.com/?q=${q}` };
}

/**
 * Attempt to open the mapping application for the provided coordinates.
 * Falls back to Google Maps on web/desktop.
 * @param {number} lat
 * @param {number} lon
 * @param {{ platform?: "ios"|"android"|"other", timeoutMs?: number }} [options]
 */
export function openMapsAt(lat, lon, options = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("Latitude and longitude must be finite numbers.");
  }
  const { platform = detectPlatform(), timeoutMs = 400 } = options;

  if (typeof window === "undefined" || !window.location) {
    throw new Error("window.location is not available in this environment.");
  }

  const { primary, fallback } = buildNavigation(lat, lon, platform);

  if (platform === "android" && fallback) {
    const timer = window.setTimeout(() => {
      window.location.assign(fallback);
    }, timeoutMs);
    // Attempt to open the native maps application first.
    try {
      window.location.assign(primary);
    } finally {
      // If navigation succeeds the timer will never fire; no need to clear.
      void timer;
    }
    return;
  }

  window.location.assign(primary);
}

/**
 * Attach a click handler to a button (or any EventTarget) that triggers map navigation.
 * @param {Element|EventTarget|null} target
 * @param {{
 *   coords?: { lat: number, lon: number } | null,
 *   resolveCoords?: () => ({ lat: number, lon: number } | null | undefined),
 *   fallbackCoords?: { lat: number, lon: number },
 *   highAccuracy?: boolean,
 *   timeoutMs?: number,
 *   platform?: "ios"|"android"|"other",
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
    fallbackCoords = DEFAULT_FALLBACK_COORDS,
    highAccuracy = true,
    timeoutMs = 8000,
    platform,
    onError,
  } = options;

  const invoke = (lat, lon) => openMapsAt(lat, lon, { platform });

  const fallback = normaliseCoords(fallbackCoords) || DEFAULT_FALLBACK_COORDS;

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

    if (typeof navigator === "undefined" || !navigator.geolocation) {
      safeInvoke(fallback.lat, fallback.lon);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords || {};
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          safeInvoke(Number(latitude), Number(longitude));
        } else {
          safeInvoke(fallback.lat, fallback.lon);
        }
      },
      (err) => {
        handleError(err);
        safeInvoke(fallback.lat, fallback.lon);
      },
      { enableHighAccuracy: highAccuracy, timeout: timeoutMs }
    );
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
  platform,
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
    attachNavigateHandler(button, { platform, onError });
  } else {
    button.disabled = true;
    if (disabledTitle) {
      button.title = disabledTitle;
    }
  }

  return button;
}

export { DEFAULT_FALLBACK_COORDS };
