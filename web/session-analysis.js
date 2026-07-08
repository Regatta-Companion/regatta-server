// session-analysis.js — DOM-vrije analyse van een zeiltrack.
// Draait in de browser (window.SessionAnalysis) én onder node:test (module.exports).
(function (global, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.SessionAnalysis = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function toRad(d) { return d * Math.PI / 180; }
  function toDeg(r) { return r * 180 / Math.PI; }

  // Kompaskoers (0–360) van punt 1 naar punt 2
  function bearing(lat1, lon1, lat2, lon2) {
    const f1 = toRad(lat1), f2 = toRad(lat2), dl = toRad(lon2 - lon1);
    const y = Math.sin(dl) * Math.cos(f2);
    const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  // Kleinste hoekverschil b − a, in (−180, 180]
  function angleDiff(a, b) {
    let d = (b - a) % 360;
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    return d;
  }

  // Circulair (gewogen) gemiddelde van koersen; null bij lege input
  function circularMean(angles, weights) {
    let x = 0, y = 0;
    for (let i = 0; i < angles.length; i++) {
      const w = weights ? weights[i] : 1;
      x += w * Math.cos(toRad(angles[i]));
      y += w * Math.sin(toRad(angles[i]));
    }
    if (x === 0 && y === 0) return null;
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Koers per punt, circulair gladgestreken over windowSize punten.
  // Punten zonder verplaatsing erven de vorige ruwe koers.
  function computeHeadings(points, windowSize) {
    const win = windowSize || 5;
    const raw = new Array(points.length).fill(null);
    for (let i = 1; i < points.length; i++) {
      const p = points[i - 1], q = points[i];
      if (p.lat === q.lat && p.lon === q.lon) { raw[i] = raw[i - 1]; continue; }
      raw[i] = bearing(p.lat, p.lon, q.lat, q.lon);
    }
    raw[0] = raw.length > 1 ? raw[1] : null;
    const half = Math.floor(win / 2);
    return points.map((pt, i) => {
      const angles = [];
      for (let j = Math.max(0, i - half); j <= Math.min(points.length - 1, i + half); j++) {
        if (raw[j] != null) angles.push(raw[j]);
      }
      const heading = angles.length ? circularMean(angles) : null;
      return Object.assign({}, pt, { heading_deg: heading });
    });
  }

  return { toRad, toDeg, bearing, angleDiff, circularMean, haversineM, computeHeadings };
});
