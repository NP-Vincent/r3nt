import { latLonToGeohash, geohashToLatLon } from './tools.js';

export const DEFAULT_LISTING_SORT_MODE = 'created-desc';
export const LISTING_LOCATION_FILTER_PRECISION = 5;
export const LISTING_LOCATION_FILTER_PATTERN = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
const DEFAULT_GEOHASH_PRECISION = 7;
export const LISTING_LOCATION_FILTER_RADIUS_KM = 50;

const EARTH_RADIUS_KM = 6371;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) {
    return Number.NaN;
  }
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

function resolveEntryCoords(entry) {
  if (!entry) return null;
  const lat = Number(entry.lat);
  const lon = Number(entry.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return { lat, lon };
  }
  const geohash = typeof entry.geohash === 'string' ? entry.geohash.trim() : '';
  if (!geohash) return null;
  try {
    const coords = geohashToLatLon(geohash);
    if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon)) {
      return { lat: coords.lat, lon: coords.lon };
    }
  } catch {}
  return null;
}

export function parseLatLonStrict(latStr, lonStr) {
  const lat = Number(latStr);
  const lon = Number(lonStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('Latitude/Longitude must be numbers.');
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new Error('Latitude/Longitude out of range.');
  }
  return { lat, lon };
}

function compareBigIntAsc(a, b) {
  let left;
  let right;
  try {
    left = typeof a === 'bigint' ? a : BigInt(a || 0);
  } catch {
    left = 0n;
  }
  try {
    right = typeof b === 'bigint' ? b : BigInt(b || 0);
  } catch {
    right = 0n;
  }
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareBigIntDesc(a, b) {
  let left;
  let right;
  try {
    left = typeof a === 'bigint' ? a : BigInt(a || 0);
  } catch {
    left = 0n;
  }
  try {
    right = typeof b === 'bigint' ? b : BigInt(b || 0);
  } catch {
    right = 0n;
  }
  if (left === right) return 0;
  return left > right ? -1 : 1;
}

function toNumberOr(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compareNumber(a, b) {
  const left = toNumberOr(a);
  const right = toNumberOr(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareAddress(a, b) {
  const left = typeof a === 'string' ? a.toLowerCase() : '';
  const right = typeof b === 'string' ? b.toLowerCase() : '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function normaliseSortMode(mode) {
  switch (mode) {
    case 'created-asc':
    case 'created-desc':
    case 'price-asc':
    case 'price-desc':
      return mode;
    default:
      return DEFAULT_LISTING_SORT_MODE;
  }
}

export function sortListings(listings, sortMode = DEFAULT_LISTING_SORT_MODE) {
  const arr = Array.isArray(listings) ? [...listings] : [];
  const mode = normaliseSortMode(sortMode);
  arr.sort((a, b) => {
    switch (mode) {
      case 'created-asc':
        return (
          compareBigIntAsc(a?.createdAt, b?.createdAt) ||
          compareNumber(a?.order, b?.order) ||
          compareAddress(a?.address, b?.address)
        );
      case 'price-asc':
        return (
          compareBigIntAsc(a?.baseDailyRate, b?.baseDailyRate) ||
          compareBigIntDesc(a?.createdAt, b?.createdAt) ||
          compareNumber(a?.order, b?.order)
        );
      case 'price-desc':
        return (
          compareBigIntDesc(a?.baseDailyRate, b?.baseDailyRate) ||
          compareBigIntDesc(a?.createdAt, b?.createdAt) ||
          compareNumber(a?.order, b?.order)
        );
      case 'created-desc':
      default:
        return (
          compareBigIntDesc(a?.createdAt, b?.createdAt) ||
          compareNumber(a?.order, b?.order) ||
          compareAddress(a?.address, b?.address)
        );
    }
  });
  return arr;
}

export function parseLocationFilter(rawValue, options = {}) {
  const {
    geohashPrecision = DEFAULT_GEOHASH_PRECISION,
    locationPrecision = LISTING_LOCATION_FILTER_PRECISION,
    pattern = LISTING_LOCATION_FILTER_PATTERN,
    parseLatLon = parseLatLonStrict,
    radiusKm = LISTING_LOCATION_FILTER_RADIUS_KM,
  } = options || {};

  const raw = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!raw) {
    return {
      typed: false,
      applied: false,
      invalid: false,
      prefix: '',
      derivedFrom: null,
      mode: null,
      lat: null,
      lon: null,
      radiusKm: null,
    };
  }

  const latLonMatch = raw.match(pattern);
  if (latLonMatch) {
    try {
      const { lat, lon } = parseLatLon(latLonMatch[1], latLonMatch[2]);
      const geohash = latLonToGeohash(lat, lon, geohashPrecision);
      const prefix = geohash
        .slice(0, Math.min(locationPrecision, geohash.length))
        .toLowerCase();
      const effectiveRadius = Number.isFinite(radiusKm) && radiusKm > 0 ? Number(radiusKm) : LISTING_LOCATION_FILTER_RADIUS_KM;
      return {
        typed: true,
        applied: true,
        invalid: false,
        prefix,
        derivedFrom: 'latlon',
        mode: 'radius',
        lat,
        lon,
        radiusKm: effectiveRadius,
      };
    } catch (err) {
      console.warn('Invalid latitude/longitude filter input', raw, err);
      return {
        typed: true,
        applied: false,
        invalid: true,
        prefix: '',
        derivedFrom: 'latlon',
        mode: null,
        lat: null,
        lon: null,
        radiusKm: null,
      };
    }
  }

  return {
    typed: true,
    applied: false,
    invalid: true,
    prefix: '',
    derivedFrom: null,
    mode: null,
    lat: null,
    lon: null,
    radiusKm: null,
  };
}

export function applyListingFilters(records, options = {}) {
  const {
    sortMode = DEFAULT_LISTING_SORT_MODE,
    locationFilterValue = '',
    geohashPrecision = DEFAULT_GEOHASH_PRECISION,
    locationPrecision = LISTING_LOCATION_FILTER_PRECISION,
    parseLatLon,
    radiusKm = LISTING_LOCATION_FILTER_RADIUS_KM,
  } = options || {};

  const list = Array.isArray(records) ? records : [];
  const filterInfo = parseLocationFilter(locationFilterValue, {
    geohashPrecision,
    locationPrecision,
    parseLatLon,
    radiusKm,
  });

  let filtered = list;
  if (filterInfo.mode === 'radius' && Number.isFinite(filterInfo.lat) && Number.isFinite(filterInfo.lon)) {
    const effectiveRadius = Number.isFinite(filterInfo.radiusKm) && filterInfo.radiusKm > 0
      ? Number(filterInfo.radiusKm)
      : Number(radiusKm);
    filterInfo.radiusKm = effectiveRadius;
    filtered = list.filter((entry) => {
      const coords = resolveEntryCoords(entry);
      if (!coords) return false;
      const dist = haversineDistanceKm(filterInfo.lat, filterInfo.lon, coords.lat, coords.lon);
      return Number.isFinite(dist) && dist <= effectiveRadius;
    });
  } else if (filterInfo.applied && filterInfo.prefix) {
    filterInfo.mode = 'prefix';
    const prefix = filterInfo.prefix;
    filtered = list.filter((entry) => {
      const geohash = typeof entry?.geohash === 'string' ? entry.geohash.toLowerCase() : '';
      return geohash.startsWith(prefix);
    });
  }

  const sorted = sortListings(filtered, sortMode);
  return { entries: sorted, total: list.length, filterInfo };
}
