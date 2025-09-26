// map-assist.js
// Helper utilities to open app the Mini App.
// inside renderListings(...), after computing `preciseCoords = `${record.lat.toFixed(6)},${record.lon.toFixed(6)}``
geoLine.append(
  el('a', {
    href: `https://www.google.com/maps/search/?api=1&query=${preciseCoords}`,
    target: '_blank',
    rel: 'noopener',
    class: 'geo-map-link',
  }, 'Open map'),
);
