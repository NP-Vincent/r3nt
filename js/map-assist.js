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
 * @param {{ fallbackCoords?: { lat: number, lon: number }, highAccuracy?: boolean, timeoutMs?: number, platform?: "ios"|"android"|"other" }} [options]
 */
export function attachNavigateHandler(target, options = {}) {
  if (!target || typeof target.addEventListener !== "function") {
    throw new Error("attachNavigateHandler expects an EventTarget with addEventListener.");
  }

  const {
    fallbackCoords = DEFAULT_FALLBACK_COORDS,
    highAccuracy = true,
    timeoutMs = 8000,
    platform,
  } = options;

  const invoke = (lat, lon) => openMapsAt(lat, lon, { platform });

  const handleClick = () => {
    const coords = fallbackCoords || DEFAULT_FALLBACK_COORDS;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      invoke(coords.lat, coords.lon);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords || {};
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          invoke(latitude, longitude);
        } else {
          invoke(coords.lat, coords.lon);
        }
      },
      () => invoke(coords.lat, coords.lon),
      { enableHighAccuracy: highAccuracy, timeout: timeoutMs }
    );
  };

  target.addEventListener("click", handleClick);
  return () => target.removeEventListener("click", handleClick);
}

export { DEFAULT_FALLBACK_COORDS };
