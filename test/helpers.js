'use strict';
// Genereert een synthetische track: 1 punt per seconde langs opgegeven koersen.
function makeTrack(segments) {
  const points = [];
  let lat = 52.0, lon = 5.0;
  let t = new Date('2026-07-01T18:00:00Z').getTime();
  const toRad = d => d * Math.PI / 180;
  for (const seg of segments) {
    for (let s = 0; s < seg.seconds; s++) {
      points.push({ lat, lon, time: new Date(t).toISOString(), speed_kn: seg.speed_kn });
      const distM = seg.speed_kn * 0.51444; // knopen → m/s, 1 s per punt
      lat += (distM * Math.cos(toRad(seg.heading_deg))) / 111320;
      lon += (distM * Math.sin(toRad(seg.heading_deg))) / (111320 * Math.cos(toRad(lat)));
      t += 1000;
    }
  }
  return points;
}
module.exports = { makeTrack };
