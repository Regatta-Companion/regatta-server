// lib/smooth.js — GPS data smoothing utilities
//
// Ruwe GPS data van een boot heeft twee problemen:
// 1. Positie-ruis (±3-5m) veroorzaakt schokkerige snelheid en zigzag koers
// 2. Snelheid wordt punt-naar-punt berekend, waardoor elke GPS-fout
//    direct zichtbaar is als onmogelijke versnelling/vertraging
//
// Oplossing: moving average (rolling window) over meerdere samples.
// Voor een zeilboot zijn fysieke snelheidsveranderingen geleidelijk —
// een window van 5-10 seconden filtert GPS-ruis weg zonder het echte
// snelheidsprofiel te vervormen.

'use strict';

/**
 * Moving average over een array van getallen.
 * Window-size: aantal punten aan elke kant (totaal window = 2*size + 1).
 * Aan de randen wordt het window asymmetrisch (kleiner).
 *
 * @param {number[]} values
 * @param {number} windowSize - punten aan elke kant (5 = ~10 sec window bij 1 Hz)
 * @returns {number[]}
 */
function movingAverage(values, windowSize) {
  if (!values || values.length === 0) return [];
  if (values.length <= windowSize * 2) return values.slice(); // te kort, niet smoothen

  const result = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const left = Math.max(0, i - windowSize);
    const right = Math.min(values.length - 1, i + windowSize);
    let sum = 0;
    for (let j = left; j <= right; j++) {
      sum += values[j];
    }
    result[i] = sum / (right - left + 1);
  }
  return result;
}

/**
 * Past smoothing toe op een array van GPX-punten.
 *
 * Wat er gebeurt:
 * - lat/lon: lichte smoothing (window=2 → ~5 punten totaal)
 *   Verwijdert hoogfrequente zigzag maar behoudt bochten.
 * - speed_kn: zwaardere smoothing (window=5 → ~11 punten totaal)
 *   Filtert onmogelijke versnellingen/vertragingen weg.
 *   Een zeilboot verandert niet van 4→8→3 kn in 3 seconden.
 *
 * Punten zonder speed_kn (eerste punt) behouden null/undefined.
 *
 * @param {Array<{lat: number, lon: number, speed_kn?: number, time?: string}>} points
 * @returns {Array} nieuwe array met gesmoothde waarden (origineel blijft intact)
 */
function smoothPoints(points) {
  if (!points || points.length < 5) return points; // te weinig punten

  const n = points.length;

  // Extract ruwe arrays
  const lats = points.map(p => p.lat);
  const lons = points.map(p => p.lon);
  const speeds = points.map(p => p.speed_kn); // kan undefined zijn

  // Smooth positie: window=2 (licht, ~5 punten totaal)
  const smoothLats = movingAverage(lats, 2);
  const smoothLons = movingAverage(lons, 2);

  // Smooth snelheid: window=5 (zwaarder, ~11 punten totaal — ca 10 sec bij 1 Hz)
  // Alleen smoothen waar speed_kn bestaat
  const speedIndices = [];
  const speedValues = [];
  for (let i = 0; i < n; i++) {
    if (speeds[i] != null && !isNaN(speeds[i])) {
      speedIndices.push(i);
      speedValues.push(speeds[i]);
    }
  }

  let smoothSpeeds = null;
  if (speedValues.length >= 5) {
    const smoothed = movingAverage(speedValues, 5);
    // Map terug naar originele indices
    smoothSpeeds = new Array(n);
    for (let k = 0; k < speedIndices.length; k++) {
      smoothSpeeds[speedIndices[k]] = Math.round(smoothed[k] * 10) / 10;
    }
  }

  // Bouw resultaat
  return points.map((p, i) => {
    const entry = {
      lat: Math.round(smoothLats[i] * 1000000) / 1000000,
      lon: Math.round(smoothLons[i] * 1000000) / 1000000,
    };
    if (p.time) entry.time = p.time;
    if (p.ele != null) entry.ele = p.ele;
    if (smoothSpeeds && smoothSpeeds[i] != null) {
      entry.speed_kn = smoothSpeeds[i];
    } else if (p.speed_kn != null) {
      entry.speed_kn = p.speed_kn;
    }
    return entry;
  });
}

module.exports = { movingAverage, smoothPoints };
