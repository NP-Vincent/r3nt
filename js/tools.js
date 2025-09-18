// tools.js
// Shared utility functions (geolocation + Farcaster cast hashes)

// ------------------------------------------------------------
// Geohash utilities (WGS84)
// ------------------------------------------------------------

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"; // geohash alphabet
const MAP = (() => {
  const m = Object.create(null);
  for (let i = 0; i < BASE32.length; i++) m[BASE32[i]] = i;
  return m;
})();

/** Validate numeric lat/lon */
export function assertLatLon(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("Latitude/Longitude must be numbers.");
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new Error("Latitude/Longitude out of range.");
  }
}

/** Encode latitude/longitude to geohash (precision 1..18 typical) */
export function latLonToGeohash(lat, lon, precision = 7) {
  assertLatLon(lat, lon);
  if (!Number.isInteger(precision) || precision < 1 || precision > 18) {
    throw new Error("Precision must be an integer between 1 and 18.");
  }

  let latMin = -90,  latMax = 90;
  let lonMin = -180, lonMax = 180;
  let hash = "";
  let bit = 0, idx = 0, even = true;

  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) { idx = (idx << 1) | 1; lonMin = mid; }
      else            { idx = (idx << 1) | 0; lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { idx = (idx << 1) | 1; latMin = mid; }
      else            { idx = (idx << 1) | 0; latMax = mid; }
    }
    even = !even;

    if (++bit === 5) {
      hash += BASE32[idx];
      bit = 0; idx = 0;
    }
  }
  return hash;
}

/** Decode geohash to bounding box { latMin, latMax, lonMin, lonMax } */
export function geohashToBounds(gh) {
  if (typeof gh !== "string" || gh.length === 0) {
    throw new Error("Geohash must be a non-empty string.");
  }
  let latMin = -90,  latMax = 90;
  let lonMin = -180, lonMax = 180;
  let even = true;

  for (const ch of gh.toLowerCase()) {
    const cd = MAP[ch];
    if (cd === undefined) throw new Error(`Invalid geohash character: "${ch}"`);
    for (let mask = 16; mask > 0; mask >>= 1) {
      if (even) {
        const mid = (lonMin + lonMax) / 2;
        if (cd & mask) lonMin = mid; else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (cd & mask) latMin = mid; else latMax = mid;
      }
      even = !even;
    }
  }
  return { latMin, latMax, lonMin, lonMax };
}

/** Decode geohash to the cell center { lat, lon } */
export function geohashToLatLon(gh) {
  const b = geohashToBounds(gh);
  return { lat: (b.latMin + b.latMax) / 2, lon: (b.lonMin + b.lonMax) / 2 };
}

/** Convenience: meters-per-cell at a given geohash length (approximate) */
export function approxCellSizeMeters(precision) {
  const table = {
    1: { height: 5009400, width: 4992600 },
    2: { height: 1252300, width: 624100 },
    3: { height: 156500,  width: 156000 },
    4: { height: 39100,   width: 19500 },
    5: { height: 4890,    width: 4890 },
    6: { height: 1220,    width: 610 },
    7: { height: 153,     width: 153 },
    8: { height: 38,      width: 19 },
    9: { height: 4.8,     width: 4.8 },
    10:{ height: 1.2,     width: 0.6 },
    11:{ height: 0.15,    width: 0.15 },
    12:{ height: 0.04,    width: 0.02 },
  };
  return table[precision] || null;
}

// ------------------------------------------------------------
// Farcaster cast hash utilities
// ------------------------------------------------------------

/**
 * True if the string is a 0x-prefixed 20-byte (40 hex) or 32-byte (64 hex) value.
 * @param {string} hex
 */
export function isHex20or32(hex) {
  return /^0x[0-9a-fA-F]{40}$/.test(hex || '') || /^0x[0-9a-fA-F]{64}$/.test(hex || '');
}

/**
 * Extract the 0x-prefixed cast hash from either:
 *  - a Warpcast URL like "https://warpcast.com/~/casts/0x5895..."
 *  - a raw 0x-prefixed hex string
 * Throws if nothing valid is found.
 * @param {string} input
 * @returns {string} 0x-hex
 */
export function extractCastHexFromInput(input) {
  const s = String(input || '').trim();

  // (a) URL path match
  if (/^https?:\/\//i.test(s)) {
    try {
      const url = new URL(s);
      const castHashParam = url.searchParams.get('castHash');
      if (castHashParam) {
        const param = castHashParam.trim();
        if (/^0x[0-9a-fA-F]+$/.test(param)) {
          return param;
        }
      }
      const pathMatch = url.pathname.match(/\/0x[0-9a-fA-F]+/);
      if (pathMatch) return pathMatch[0].slice(1);
    } catch (err) {
      // Fallback to raw regex match on the original string if URL parsing fails
    }

    const m = s.match(/\/0x[0-9a-fA-F]+/);
    if (m) return m[0].slice(1); // remove leading '/'
    throw new Error('No cast hash found in URL.');
  }

  // (b) Raw hex
  if (/^0x[0-9a-fA-F]+$/.test(s)) return s;

  throw new Error('Enter a Warpcast URL or a 0x-prefixed cast hash.');
}

/**
 * Convert a 20-byte Farcaster hash to bytes32 by left-padding with zeros.
 * If already 32 bytes, returns as-is. Validates length.
 * @param {string} hex20or32
 * @returns {string} bytes32 hex (0x + 64 hex)
 */
export function toBytes32FromCastHash(hex20or32) {
  const h = String(hex20or32 || '').toLowerCase();
  if (!isHex20or32(h)) {
    throw new Error('Cast hash must be 0x + 40 or 64 hex characters.');
  }
  // Already 32 bytes
  if (/^0x[0-9a-fA-F]{64}$/.test(h)) return h;

  // 20-byte -> pad 12 bytes (24 hex chars) of zeros on the left
  // Each "00" represents one byte, so repeat 24 hex chars to add 12 bytes
  return '0x' + '0'.repeat(24) + h.slice(2);
}

/**
 * High-level: normalize a Warpcast URL or raw 0x-hex into bytes32 for contracts.
 * @param {string} inputUrlOrHex
 * @returns {string} bytes32 hex (0x + 64 hex)
 */
export function normalizeCastInputToBytes32(inputUrlOrHex) {
  const hex = extractCastHexFromInput(inputUrlOrHex);
  return toBytes32FromCastHash(hex);
}

/**
 * Convert a stored bytes32 cast hash back into a 20-byte Farcaster cast hash.
 * @param {string} castHash32 0x + 64 hex
 * @returns {string} 0x + 40 hex cast hash
 */
export function bytes32ToCastHash(castHash32) {
  const h = String(castHash32 || '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) {
    throw new Error('Expected 32-byte hex for cast.');
  }
  return '0x' + h.slice(-40);
}

/**
 * Convert a stored bytes32 cast hash back into a canonical Warpcast URL.
 * Assumes the original Farcaster hash was 20 bytes left-padded to 32 bytes.
 * @param {string} castHash32 0x + 64 hex
 * @returns {string} Warpcast URL: https://warpcast.com/~/casts/0x...
 */
export function bytes32ToCastUrl(castHash32) {
  return `https://warpcast.com/~/casts/${bytes32ToCastHash(castHash32)}`;
}

/**
 * Build a Farcaster URL that points to the landlord's cast. If we know the
 * author's fid we can deep-link through the `/~/profiles/{fid}` route so the
 * client loads the cast in the correct profile context; otherwise we fall back
 * to the global casts path.
 * @param {bigint|number|string|null} fid
 * @param {string} castHash32 bytes32 hex from the contract
 * @returns {string} URL suitable for "View full details on Farcaster"
 */
export function buildFarcasterCastUrl(fid, castHash32) {
  const castHash20 = bytes32ToCastHash(castHash32);
  let fidStr = null;
  try {
    if (fid !== undefined && fid !== null) {
      const big = typeof fid === 'bigint' ? fid : BigInt(fid);
      if (big > 0n) fidStr = big.toString();
    }
  } catch {
    fidStr = null;
  }
  if (fidStr) {
    return `https://warpcast.com/~/profiles/${fidStr}?castHash=${castHash20}`;
  }
  return `https://warpcast.com/~/casts/${castHash20}`;
}
