// map-assist.js
// Helper utilities to open native mapping apps from within the Mini App.
// Based on recommended platform-specific behaviour for iOS, Android and web.

const DEFAULT_FALLBACK_COORDS = Object.freeze({ lat: 25.1972, lon: 55.2744 });

const MAP_PROVIDERS = Object.freeze({
  apple: "apple",
  google: "google",
});

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

function buildAppleMapsUrl(lat, lon, label) {
  const q = `${lat},${lon}`;
  const encodedLabel = label ? encodeURIComponent(label) : encodeURIComponent(q);
  return `https://maps.apple.com/?ll=${encodeURIComponent(q)}&q=${encodedLabel}`;
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

function chooseProvider(preferred) {
  const defaultPreference = preferred ?? (detectPlatform() === "ios" ? MAP_PROVIDERS.apple : MAP_PROVIDERS.google);

  if (typeof window === "undefined" || typeof window.confirm !== "function") {
    return defaultPreference;
  }

  if (defaultPreference === MAP_PROVIDERS.apple) {
    const useApple = window.confirm("Open location in Apple Maps? Press Cancel for Google Maps.");
    return useApple ? MAP_PROVIDERS.apple : MAP_PROVIDERS.google;
  }

  const useGoogle = window.confirm("Open location in Google Maps? Press Cancel for Apple Maps.");
  return useGoogle ? MAP_PROVIDERS.google : MAP_PROVIDERS.apple;
}

/**
 * Attempt to open the mapping application for the provided coordinates.
 * Presents the user with a choice of Apple Maps or Google Maps links.
 * @param {number} lat
 * @param {number} lon
 * @param {{
 *   provider?: "apple"|"google",
 *   preferredProvider?: "apple"|"google",
 *   label?: string,
 *   openInNewTab?: boolean,
 * }} [options]
 */
export function openMapsAt(lat, lon, options = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("Latitude and longitude must be finite numbers.");
  }
  const { provider, preferredProvider, label, openInNewTab = true } = options;

  const requestedProvider = provider ?? chooseProvider(preferredProvider);
  const mapUrls = {
    [MAP_PROVIDERS.apple]: buildAppleMapsUrl(lat, lon, label),
    [MAP_PROVIDERS.google]: buildGoogleMapsUrl(lat, lon, label),
  };

  const selectedProvider = Object.values(MAP_PROVIDERS).includes(requestedProvider)
    ? requestedProvider
    : chooseProvider(preferredProvider);
  const url = mapUrls[selectedProvider];
  openUrl(url, { openInNewTab });
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
 *   provider?: "apple"|"google",
 *   preferredProvider?: "apple"|"google",
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
    fallbackCoords = DEFAULT_FALLBACK_COORDS,
    highAccuracy = true,
    timeoutMs = 8000,
    provider,
    preferredProvider,
    label,
    openInNewTab,
    onError,
  } = options;

  const invoke = (lat, lon) =>
    openMapsAt(lat, lon, { provider, preferredProvider, label, openInNewTab });

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
  provider,
  preferredProvider,
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
      provider,
      preferredProvider,
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

export { DEFAULT_FALLBACK_COORDS };
