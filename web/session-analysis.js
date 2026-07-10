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

  // Punt van zeil op basis van true wind angle (0–180)
  function twaCategory(twa) {
    if (twa < 60) return 'aan-de-wind';
    if (twa < 120) return 'halve-wind';
    if (twa < 160) return 'ruime-wind';
    return 'voor-de-wind';
  }

  function makeLeg(points, startIdx, endIdx, windDeg) {
    const headings = [];
    let dist = 0, maxSpd = null, spdSum = 0, spdN = 0;
    for (let i = startIdx; i <= endIdx; i++) {
      if (points[i].heading_deg != null) headings.push(points[i].heading_deg);
      if (i > startIdx) dist += haversineM(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
      const s = points[i].speed_kn;
      if (s != null) { spdSum += s; spdN++; if (maxSpd == null || s > maxSpd) maxSpd = s; }
    }
    const avgHeading = circularMean(headings);
    const t0 = points[startIdx].time, t1 = points[endIdx].time;
    const duration = t0 && t1 ? (new Date(t1) - new Date(t0)) / 1000 : null;
    let twa = null, category = null, tack = null;
    if (windDeg != null && avgHeading != null) {
      const d = angleDiff(windDeg, avgHeading);
      twa = Math.abs(d);
      category = twaCategory(twa);
      tack = d >= 0 ? 'bakboord' : 'stuurboord';
    }
    return {
      startIdx, endIdx,
      avg_heading_deg: avgHeading != null ? Math.round(avgHeading) : null,
      twa_deg: twa != null ? Math.round(twa) : null,
      category, tack,
      distance_m: Math.round(dist),
      duration_s: duration != null ? Math.round(duration) : null,
      avg_speed_kn: spdN ? Math.round((spdSum / spdN) * 10) / 10 : null,
      max_speed_kn: maxSpd,
    };
  }

  // Knip de track in rakken: nieuw rak zodra de koers ≥ 3 punten achtereen
  // meer dan 40° van het lopende rakgemiddelde afwijkt.
  // Rakken korter dan 30 s (of zonder tijd: < 10 punten) gaan op in hun buurman.
  function segmentLegs(points, windDeg) {
    if (points.length < 2) return [];
    const boundaries = [0];
    let mean = null, deviated = 0;
    const SUSTAIN = 3;
    for (let i = 0; i < points.length; i++) {
      const h = points[i].heading_deg;
      if (h == null) continue;
      if (mean == null) { mean = h; continue; }
      if (Math.abs(angleDiff(mean, h)) > 40) {
        deviated++;
        if (deviated >= SUSTAIN) {
          boundaries.push(i - SUSTAIN + 1);
          mean = h;
          deviated = 0;
        }
      } else {
        deviated = 0;
        mean = (mean + angleDiff(mean, h) * 0.1 + 360) % 360; // langzaam meebewegend gemiddelde
      }
    }

    // Bouw legs uit de grenzen
    let legs = [];
    for (let b = 0; b < boundaries.length; b++) {
      const start = boundaries[b];
      const end = b + 1 < boundaries.length ? boundaries[b + 1] - 1 : points.length - 1;
      if (end > start) legs.push(makeLeg(points, start, end, windDeg));
    }

    // Korte rakken samenvoegen met de buurman waarvan de koers het dichtst ligt
    const tooShort = (leg) => leg.duration_s != null
      ? leg.duration_s < 30
      : (leg.endIdx - leg.startIdx) < 10;
    let merged = true;
    while (merged && legs.length > 1) {
      merged = false;
      for (let i = 0; i < legs.length; i++) {
        if (!tooShort(legs[i])) continue;
        const prev = i > 0 ? legs[i - 1] : null;
        const next = i < legs.length - 1 ? legs[i + 1] : null;
        const dPrev = prev ? Math.abs(angleDiff(prev.avg_heading_deg, legs[i].avg_heading_deg)) : Infinity;
        const dNext = next ? Math.abs(angleDiff(next.avg_heading_deg, legs[i].avg_heading_deg)) : Infinity;
        if (dPrev <= dNext && prev) {
          legs.splice(i - 1, 2, makeLeg(points, prev.startIdx, legs[i].endIdx, windDeg));
        } else if (next) {
          legs.splice(i, 2, makeLeg(points, legs[i].startIdx, next.endIdx, windDeg));
        } else break;
        merged = true;
        break;
      }
    }

    // Naburige rakken met (vrijwel) dezelfde koers samenvoegen (< 30° verschil)
    merged = true;
    while (merged && legs.length > 1) {
      merged = false;
      for (let i = 1; i < legs.length; i++) {
        if (Math.abs(angleDiff(legs[i - 1].avg_heading_deg, legs[i].avg_heading_deg)) < 30) {
          legs.splice(i - 1, 2, makeLeg(points, legs[i - 1].startIdx, legs[i].endIdx, windDeg));
          merged = true;
          break;
        }
      }
    }
    return legs;
  }

  // Ligt target op de korte boog van from naar to?
  function arcContains(from, to, target) {
    const span = angleDiff(from, to);
    const t = angleDiff(from, target);
    return span >= 0 ? (t >= 0 && t <= span) : (t <= 0 && t >= span);
  }

  // Gemiddelde snelheid in de secondes [fromS, toS] rond index idx (negatief = ervoor)
  function avgSpeedAround(points, idx, fromS, toS) {
    if (!points[idx].time) return null;
    const t0 = new Date(points[idx].time).getTime();
    let sum = 0, n = 0;
    for (const pt of points) {
      if (!pt.time || pt.speed_kn == null) continue;
      const dt = (new Date(pt.time).getTime() - t0) / 1000;
      if (dt >= fromS && dt <= toS) { sum += pt.speed_kn; n++; }
    }
    return n ? sum / n : null;
  }

  // Manoeuvres op rakgrenzen: koerswissel ≥ 60° die de windrichting kruist
  // (overstag) of de wind+180 (gijp).
  function detectManeuvers(points, legs, windDeg) {
    if (windDeg == null) return [];
    const out = [];
    for (let k = 1; k < legs.length; k++) {
      const a = legs[k - 1], b = legs[k];
      if (a.avg_heading_deg == null || b.avg_heading_deg == null) continue;
      if (Math.abs(angleDiff(a.avg_heading_deg, b.avg_heading_deg)) < 60) continue;
      let type = null;
      if (arcContains(a.avg_heading_deg, b.avg_heading_deg, windDeg)) type = 'overstag';
      else if (arcContains(a.avg_heading_deg, b.avg_heading_deg, (windDeg + 180) % 360)) type = 'gijp';
      if (!type) continue;

      const idx = b.startIdx;
      const before = avgSpeedAround(points, idx, -30, -5); // snelheid vóór de bocht
      // minimum snelheid binnen ±15 s van de bocht
      let minSpd = null;
      if (points[idx].time) {
        const t0 = new Date(points[idx].time).getTime();
        for (const pt of points) {
          if (!pt.time || pt.speed_kn == null) continue;
          const dt = Math.abs((new Date(pt.time).getTime() - t0) / 1000);
          if (dt <= 15 && (minSpd == null || pt.speed_kn < minSpd)) minSpd = pt.speed_kn;
        }
      }
      const loss = before != null && minSpd != null ? Math.max(0, before - minSpd) : null;

      // hersteltijd: eerste moment ná de bocht dat de snelheid ≥ 90% van 'before' is
      let recovery = null;
      if (before != null && points[idx].time) {
        const t0 = new Date(points[idx].time).getTime();
        for (let i = idx; i < points.length; i++) {
          const pt = points[i];
          if (!pt.time || pt.speed_kn == null) continue;
          const dt = (new Date(pt.time).getTime() - t0) / 1000;
          if (dt > 120) break;
          if (pt.speed_kn >= before * 0.9) { recovery = Math.round(dt); break; }
        }
      }

      out.push({
        idx, type,
        time: points[idx].time || null,
        lat: points[idx].lat, lon: points[idx].lon,
        speed_loss_kn: loss != null ? Math.round(loss * 10) / 10 : null,
        recovery_s: recovery,
      });
    }
    return out;
  }

  function buildReport(points, legs, maneuvers) {
    // Beste 10 seconden: rollend venster op tijd
    let best = null;
    for (let i = 0; i < points.length; i++) {
      if (!points[i].time) continue;
      const t0 = new Date(points[i].time).getTime();
      let sum = 0, n = 0, j = i;
      while (j < points.length && points[j].time &&
             (new Date(points[j].time).getTime() - t0) / 1000 <= 10) {
        if (points[j].speed_kn != null) { sum += points[j].speed_kn; n++; }
        j++;
      }
      if (n >= 3) {
        const avg = sum / n;
        if (!best || avg > best.avg_speed_kn) {
          best = { start_idx: i, end_idx: j - 1, avg_speed_kn: Math.round(avg * 10) / 10 };
        }
      }
    }

    // Langste rak op afstand
    let longestIdx = null;
    for (let i = 0; i < legs.length; i++) {
      if (longestIdx == null || legs[i].distance_m > legs[longestIdx].distance_m) longestIdx = i;
    }

    // Opkruishoek: circulair gemiddelde koers per boeg van de aan-de-windse rakken
    const upP = legs.filter(l => l.category === 'aan-de-wind' && l.tack === 'bakboord');
    const upS = legs.filter(l => l.category === 'aan-de-wind' && l.tack === 'stuurboord');
    let beatAngle = null;
    if (upP.length && upS.length) {
      const hP = circularMean(upP.map(l => l.avg_heading_deg), upP.map(l => l.distance_m));
      const hS = circularMean(upS.map(l => l.avg_heading_deg), upS.map(l => l.distance_m));
      beatAngle = Math.round(Math.abs(angleDiff(hP, hS)));
    }

    const tacks = maneuvers.filter(m => m.type === 'overstag').length;
    const gybes = maneuvers.filter(m => m.type === 'gijp').length;
    const losses = maneuvers.map(m => m.speed_loss_kn).filter(v => v != null);
    const avgLoss = losses.length
      ? Math.round((losses.reduce((a, b) => a + b, 0) / losses.length) * 10) / 10 : null;

    const dist = {};
    for (const leg of legs) {
      if (!leg.category) continue;
      if (!dist[leg.category]) dist[leg.category] = { time_s: 0, distance_m: 0 };
      dist[leg.category].time_s += leg.duration_s || 0;
      dist[leg.category].distance_m += leg.distance_m || 0;
    }

    return {
      best_10s: best,
      longest_leg_idx: longestIdx,
      beat_angle_deg: beatAngle,
      maneuvers: { tacks, gybes, avg_loss_kn: avgLoss },
      twa_distribution: dist,
    };
  }

  // Orchestrator: hele analyse in één aanroep.
  function analyzeSession(rawPoints, opts) {
    const o = opts || {};
    const points = computeHeadings(rawPoints, o.headingWindow || 5);
    const estimated = estimateWind(points);
    const usedDeg = o.windOverrideDeg != null ? o.windOverrideDeg : estimated.direction_deg;
    const legs = segmentLegs(points, usedDeg);
    const maneuvers = detectManeuvers(points, legs, usedDeg);
    const report = buildReport(points, legs, maneuvers);
    return { points, wind: { estimated, used_deg: usedDeg }, legs, maneuvers, report };
  }

  // ── Parcours-motor ─────────────────────────────────────────────────────

  // Bouw een parcours uit race-boeien (vorm van GET /api/races/:id/marks).
  // Minder dan 2 geldige boeien → null (geen parcours).
  function courseFromMarks(rawMarks) {
    const marks = (rawMarks || [])
      .filter(m => m && typeof m.lat === 'number' && typeof m.lon === 'number' &&
                   isFinite(m.lat) && isFinite(m.lon))
      .slice()
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    if (marks.length < 2) return null;

    const legs = [];
    const cum = [0];
    for (let i = 1; i < marks.length; i++) {
      const d = haversineM(marks[i - 1].lat, marks[i - 1].lon, marks[i].lat, marks[i].lon);
      legs.push({ fromIdx: i - 1, toIdx: i, distance_m: d });
      cum.push(cum[i - 1] + d);
    }
    return { marks, legs, cum_distance_m: cum, total_distance_m: cum[cum.length - 1] };
  }

  // Velocity made good richting een doel: snelheid × cos(koers − peiling).
  // Negatief wanneer de boot van het doel af vaart.
  function computeVMG(speedKn, headingDeg, lat, lon, targetLat, targetLon) {
    if (speedKn == null || headingDeg == null) return null;
    const brg = bearing(lat, lon, targetLat, targetLon);
    return speedKn * Math.cos(toRad(angleDiff(brg, headingDeg)));
  }

  // Voortgang in meters langs het parcours + boeirondingen.
  // Ronding = binnen ROUNDING_RADIUS_M van de eerstvolgende boei (alleen in
  // parcoursvolgorde). Voortgang is monotoon niet-dalend geklemd.
  var ROUNDING_RADIUS_M = 60;

  function computeProgress(points, course) {
    const progress = [];
    const roundings = [];
    let next = 0;
    let clamped = null;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      // Meerdere boeien in één stap kunnen ronden (dicht bij elkaar / GPS-gat)
      while (next < course.marks.length &&
             haversineM(p.lat, p.lon, course.marks[next].lat, course.marks[next].lon) <= ROUNDING_RADIUS_M) {
        roundings.push({ markIdx: next, pointIdx: i, time: p.time || null });
        next++;
      }

      let raw;
      if (next >= course.marks.length) {
        raw = course.total_distance_m;
      } else {
        raw = course.cum_distance_m[next] -
              haversineM(p.lat, p.lon, course.marks[next].lat, course.marks[next].lon);
      }
      clamped = clamped == null ? raw : Math.max(clamped, raw);
      progress.push(clamped);
    }
    return { progress_m: progress, roundings };
  }

  return { toRad, toDeg, bearing, angleDiff, circularMean, haversineM, computeHeadings, estimateWind, twaCategory, segmentLegs, detectManeuvers, buildReport, analyzeSession, courseFromMarks, computeVMG, computeProgress };
});
