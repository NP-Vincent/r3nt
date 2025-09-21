const GEOHASH_REGION_PREFIXES = Object.freeze({
  thrr: 'Dubai',
  thr: 'Dubai',
  '9q8': 'San Francisco Bay Area',
  '9q5c': 'Los Angeles',
  dr5: 'New York City',
  dpz8: 'Toronto',
  gcpv: 'London',
  u33d: 'Berlin',
  u09t: 'Paris',
  xn77: 'Tokyo',
  wecn: 'Hong Kong',
  w21z: 'Singapore',
  '9v6k': 'Austin',
  dhwf: 'Miami',
  c2b2: 'Vancouver',
  r3gx: 'Sydney',
  '6gyf': 'São Paulo',
});

export function lookupRegionForGeohash(geohash) {
  const value = typeof geohash === 'string' ? geohash.trim().toLowerCase() : '';
  if (!value) return null;
  const maxLength = Math.min(4, value.length);
  for (let length = maxLength; length >= 3; length--) {
    const prefix = value.slice(0, length);
    if (Object.prototype.hasOwnProperty.call(GEOHASH_REGION_PREFIXES, prefix)) {
      return GEOHASH_REGION_PREFIXES[prefix];
    }
  }
  return null;
}

export { GEOHASH_REGION_PREFIXES };
