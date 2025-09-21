const GEOHASH_REGION_PREFIXES = Object.freeze({
  '9q8': 'San Francisco Bay Area',
  '9q5c': 'Los Angeles',
  dr5: 'New York City',
  dpz8: 'Toronto',
  gcpv: 'London',
  u33d: 'Berlin',
  u09t: 'Paris',
  '9v6k': 'Austin',
  dhwf: 'Miami',
  c2b2: 'Vancouver',
  '6gyf': 'São Paulo',
  
  // UAE
  thrr: 'Dubai',
  thxf: 'Ras Al Khaimah',
  thes: 'Abu Dhabi',
  ther: 'Al Ain - Abu Dhabi',
  thrt: 'Hatta - Dubai',
  thqq: 'Sharjah',
  thqs: 'Kalba - Sharjah',
  thqp: 'Fujairah',
  thqr: 'Ajman',
  thqj: 'Umm Al Quwain',

  // Asia
  w4kp: 'Phuket',
  w4v0: 'Bangkok',
  w21z: 'Singapore', // already in your list
  w2fb: 'Kuala Lumpur',
  tc5:  'Sri Lanka',
  wd8:  'Maldives',
  qzzh: 'Bali',
  xn77: 'Tokyo',
  wecn: 'Hong Kong',
  r3gx: 'Sydney',

  // Indian Ocean
  mbz:  'Seychelles'

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
