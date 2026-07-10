// lib/decimate.js — puntenreeks uitdunnen met behoud van eerste en laatste punt
'use strict';

function decimatePoints(points, maxPoints) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points;
  const out = [];
  const step = (points.length - 1) / (maxPoints - 1);
  for (let k = 0; k < maxPoints; k++) {
    out.push(points[Math.round(k * step)]);
  }
  // Afronding kan duplicaten geven; laatste punt is gegarandeerd door k = maxPoints-1
  return out.filter((p, i) => i === 0 || p !== out[i - 1]);
}

module.exports = { decimatePoints };
