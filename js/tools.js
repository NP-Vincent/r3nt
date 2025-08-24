// tools.js
// Utilities for handling Farcaster cast hashes (URL/hex <-> bytes32)

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
    const m = s.match(/\/0x[0-9a-fA-F]+/);
    if (!m) throw new Error('No cast hash found in URL.');
    return m[0].slice(1); // remove leading '/'
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
 * Convert a stored bytes32 cast hash back into a canonical Warpcast URL.
 * Assumes the original Farcaster hash was 20 bytes left-padded to 32 bytes.
 * @param {string} castHash32 0x + 64 hex
 * @returns {string} Warpcast URL: https://warpcast.com/~/casts/0x...
 */
export function bytes32ToCastUrl(castHash32) {
  const h = String(castHash32 || '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) {
    throw new Error('Expected 32-byte hex for cast.');
  }
  const cast20 = '0x' + h.slice(-40);
  return `https://warpcast.com/~/casts/${cast20}`;
}
