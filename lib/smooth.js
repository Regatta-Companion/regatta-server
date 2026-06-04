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
//
// BELANGRIJK: smoothing stopt bij GPS-gaten (>5 sec). Als een boot
// 10 seconden geen data heeft, liggen de punten ~50m uit elkaar.
// Een moving average over dat gat zou de punten naar elkaar toe
// trekken, waardoor de snelheid vóór/na het gat onnatuurlijk wordt
// (eerst te snel, dan te langzaam). Door de keten te onderbreken
// bij gaten blijft de snelheid per segment realistisch.

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
  if (values.length <= windowSize * 2) return values.slice();

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
 * Berekent de mediana van een gesorteerde array.
 */
function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Splitst een array van punten in continue segmenten.
 * Een "gat" is wanneer het tijdsinterval > maxGapSec seconden is.
 * Punten zonder tijd worden als één segment behandeld.
 *
 * @returns {Array<{start: number, end: number}>} - index ranges [start, end) per segment
 */
function findSegments(points, maxGapSec) {
  if (points.length === 0) return [];

  const segments = [];
  let segStart = 0;

  for (let i = 1; i < points.length; i++) {
    const prevTime = points[i - 1].time;
    const currTime = points[i].time;

    if (prevTime && currTime) {
      const gap = (new Date(currTime) - new Date(prevTime)) / 1000;
      if (gap > maxGapSec) {
        // Gat gevonden — sluit huidig segment af
        segments.push({ start: segStart, end: i });
        segStart = i;
      }
    }
  }

  // Laatste segment
  segments.push({ start: segStart, end: points.length });
  return segments;
}

/**
 * Past moving average toe op genummerde waarden binnen één segment.
 * Retourneert een sparse array (alleen indices binnen het segment hebben waarden).
 */
function smoothSegment(values, indices, windowSize) {
  const m = indices.length;
  if (m === 0) return [];

  const result = new Array(indices[indices.length - 1] + 1);

  // Te kort segment: kopieer ruwe waarden
  if (m <= windowSize * 2) {
    for (let k = 0; k < m; k++) {
      result[indices[k]] = values[k];
    }
    return result;
  }

  for (let k = 0; k < m; k++) {
    const left = Math.max(0, k - windowSize);
    const right = Math.min(m - 1, k + windowSize);
    let sum = 0;
    for (let j = left; j <= right; j++) {
      sum += values[j];
    }
    result[indices[k]] = sum / (right - left + 1);
  }

  return result;
}

/**
 * Past smoothing toe op een array van GPX-punten.
 *
 * Wat er gebeurt:
 * - Eerst worden GPS-gaten gedetecteerd (interval > 5 sec).
 * - Binnen elk continu segment:
 *   - lat/lon: lichte smoothing (window=2 → ~5 punten totaal)
 *   - speed_kn: zwaardere smoothing (window=5 → ~11 punten totaal)
 * - Over segmentgrenzen heen wordt NIET gesmoothed — dit voorkomt
 *   dat punten ~50m uit elkaar naar elkaar toe worden getrokken.
 *
 * @param {Array<{lat: number, lon: number, speed_kn?: number, time?: string}>} points
 * @returns {Array} nieuwe array met gesmoothde waarden (origineel blijft intact)
 */
function smoothPoints(points) {
  if (!points || points.length < 5) return points;

  const n = points.length;

  // Detecteer tijdsgaten — bepaal dynamisch de maxGap op basis van de data
  const intervals = [];
  for (let i = 1; i < n; i++) {
    if (points[i - 1].time && points[i].time) {
      const dt = (new Date(points[i].time) - new Date(points[i - 1].time)) / 1000;
      if (dt > 0) intervals.push(dt);
    }
  }

  // Gebruik 3× het mediane interval als grens, met minimum van 5 sec
  const sorted = intervals.slice().sort((a, b) => a - b);
  const medInterval = sorted.length > 0 ? median(sorted) : 1;
  const maxGapSec = Math.max(5, medInterval * 3);

  const segments = findSegments(points, maxGapSec);

  // Bouw gesmoothde arrays op (sparse, alleen gevuld binnen segmenten)
  const smoothLats = new Array(n);
  const smoothLons = new Array(n);
  const smoothSpeeds = new Array(n);

  for (const seg of segments) {
    const segPoints = points.slice(seg.start, seg.end);
    const m = segPoints.length;

    // --- Positie-smoothing (window=2) ---
    if (m >= 3) {
      const segLats = segPoints.map(p => p.lat);
      const segLons = segPoints.map(p => p.lon);
      const smLats = movingAverage(segLats, Math.min(2, Math.floor((m - 1) / 2)));
      const smLons = movingAverage(segLons, Math.min(2, Math.floor((m - 1) / 2)));
      for (let k = 0; k < m; k++) {
        smoothLats[seg.start + k] = Math.round(smLats[k] * 1000000) / 1000000;
        smoothLons[seg.start + k] = Math.round(smLons[k] * 1000000) / 1000000;
      }
    } else {
      // Segment te kort: kopieer ruwe posities
      for (let k = 0; k < m; k++) {
        smoothLats[seg.start + k] = segPoints[k].lat;
        smoothLons[seg.start + k] = segPoints[k].lon;
      }
    }

    // --- Snelheids-smoothing (window=5) ---
    const speedIndices = [];
    const speedValues = [];
    for (let k = 0; k < m; k++) {
      const spd = segPoints[k].speed_kn;
      if (spd != null && !isNaN(spd)) {
        speedIndices.push(k);
        speedValues.push(spd);
      }
    }
    if (speedValues.length >= 5) {
      const w = Math.min(5, Math.floor((speedValues.length - 1) / 2));
      const smoothed = movingAverage(speedValues, w);
      for (let k = 0; k < speedIndices.length; k++) {
        const globalIdx = seg.start + speedIndices[k];
        smoothSpeeds[globalIdx] = Math.round(smoothed[k] * 10) / 10;
      }
    } else {
      // Weinig snelheidspunten in segment: kopieer ruw
      for (let k = 0; k < m; k++) {
        const spd = segPoints[k].speed_kn;
        if (spd != null && !isNaN(spd)) {
          smoothSpeeds[seg.start + k] = spd;
        }
      }
    }
  }

  // Bouw resultaat: gebruik gesmoothde waarden waar beschikbaar, anders ruw
  return points.map((p, i) => {
    const entry = {
      lat: smoothLats[i] != null ? smoothLats[i] : p.lat,
      lon: smoothLons[i] != null ? smoothLons[i] : p.lon,
    };
    if (p.time) entry.time = p.time;
    if (p.ele != null) entry.ele = p.ele;
    if (smoothSpeeds[i] != null) {
      entry.speed_kn = smoothSpeeds[i];
    } else if (p.speed_kn != null) {
      entry.speed_kn = p.speed_kn;
    }
    return entry;
  });
}

module.exports = { movingAverage, smoothPoints };
