import { latLonToGeohash } from './tools.js';

export const DEFAULT_LISTING_SORT_MODE = 'created-desc';
export const LISTING_LOCATION_FILTER_PRECISION = 5;
export const LISTING_LOCATION_FILTER_PATTERN = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
const DEFAULT_GEOHASH_PRECISION = 7;

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
  } = options || {};

  const raw = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!raw) {
    return { typed: false, applied: false, invalid: false, prefix: '', derivedFrom: null };
  }

  const latLonMatch = raw.match(pattern);
  if (latLonMatch) {
    try {
      const { lat, lon } = parseLatLon(latLonMatch[1], latLonMatch[2]);
      const geohash = latLonToGeohash(lat, lon, geohashPrecision);
      const prefix = geohash
        .slice(0, Math.min(locationPrecision, geohash.length))
        .toLowerCase();
      return { typed: true, applied: true, invalid: false, prefix, derivedFrom: 'latlon' };
    } catch (err) {
      console.warn('Invalid latitude/longitude filter input', raw, err);
      return { typed: true, applied: false, invalid: true, prefix: '', derivedFrom: 'latlon' };
    }
  }

  return { typed: true, applied: false, invalid: true, prefix: '', derivedFrom: null };
}

export function applyListingFilters(records, options = {}) {
  const {
    sortMode = DEFAULT_LISTING_SORT_MODE,
    locationFilterValue = '',
    geohashPrecision = DEFAULT_GEOHASH_PRECISION,
    locationPrecision = LISTING_LOCATION_FILTER_PRECISION,
    parseLatLon,
  } = options || {};

  const list = Array.isArray(records) ? records : [];
  const filterInfo = parseLocationFilter(locationFilterValue, {
    geohashPrecision,
    locationPrecision,
    parseLatLon,
  });

  let filtered = list;
  if (filterInfo.applied && filterInfo.prefix) {
    const prefix = filterInfo.prefix;
    filtered = list.filter((entry) => {
      const geohash = typeof entry?.geohash === 'string' ? entry.geohash.toLowerCase() : '';
      return geohash.startsWith(prefix);
    });
  }

  const sorted = sortListings(filtered, sortMode);
  return { entries: sorted, total: list.length, filterInfo };
}
