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

  // Schat de windrichting (waar hij vandaan komt) uit kruisrakken:
  // twee dominante koerspieken 70–110° uit elkaar; wind = bissectrice.
  function estimateWind(points) {
    const bins = new Array(36).fill(0);
    let totalW = 0;
    for (let i = 1; i < points.length; i++) {
      const pt = points[i];
      if (pt.heading_deg == null || (pt.speed_kn || 0) <= 2) continue;
      let w = 1;
      if (pt.time && points[i - 1].time) {
        const dt = (new Date(pt.time) - new Date(points[i - 1].time)) / 1000;
        if (dt <= 0 || dt > 60) continue; // GPS-gat
        w = dt;
      }
      bins[Math.floor(pt.heading_deg / 10) % 36] += w;
      totalW += w;
    }
    if (totalW === 0) return { direction_deg: null, confidence: 'none' };

    // Lokale pieken in het histogram, zwaarste eerst
    const peaks = [];
    for (let b = 0; b < 36; b++) {
      const w = bins[b];
      if (w > 0 && w >= bins[(b + 35) % 36] && w >= bins[(b + 1) % 36]) {
        peaks.push({ deg: b * 10 + 5, w });
      }
    }
    peaks.sort((a, b) => b.w - a.w);

    // Zwaarste piekenpaar dat 70–110° uit elkaar ligt (bakboord/stuurboord aan de wind)
    let best = null;
    const top = Math.min(peaks.length, 6);
    for (let i = 0; i < top; i++) {
      for (let j = i + 1; j < top; j++) {
        const sep = Math.abs(angleDiff(peaks[i].deg, peaks[j].deg));
        if (sep >= 70 && sep <= 110) {
          const w = peaks[i].w + peaks[j].w;
          if (!best || w > best.w) best = { a: peaks[i].deg, b: peaks[j].deg, w };
        }
      }
    }
    if (!best) return { direction_deg: null, confidence: 'none' };

    // Bissectrice aan de scherpe kant = richting waar de wind vandaan komt
    const wind = circularMean([best.a, best.b]);
    const confidence = best.w / totalW >= 0.25 ? 'high' : 'low';
    return { direction_deg: Math.round(wind), confidence };
  }

  return { toRad, toDeg, bearing, angleDiff, circularMean, haversineM, computeHeadings, estimateWind };
});
