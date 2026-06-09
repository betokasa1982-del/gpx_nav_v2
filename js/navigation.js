/**
 * navigation.js — All route logic. Pure functions + Navigation object.
 * No DOM access. No side effects. Returns data; app.js decides what to do.
 */

import { State } from './state.js';
import { haversine, brng, angleDiff, fmtTime } from './gps.js';

// ── Constants ──────────────────────────────────────────────────────────────
const SMOOTH      = 5;    // points to average for bearing in buildManeuvers
const MIN_TURN    = 28;   // degrees — minimum turn to count as maneuver
const MIN_SEP_KM  = 0.04; // 40m minimum separation between maneuvers
const AHEAD       = 500;  // route index window ahead — wide for long straights
const BACK        = 3;    // minimal back window — prevents bidirectional confusion

// ── Precompute ─────────────────────────────────────────────────────────────

/** Build cumulative distance array (km) parallel to routePts */
export function buildCumDist(pts) {
  const d = [0];
  for (let i = 1; i < pts.length; i++) {
    d.push(d[i - 1] + haversine(pts[i-1].lat, pts[i-1].lon, pts[i].lat, pts[i].lon));
  }
  return d;
}

/** Build turn-by-turn maneuver list from route points */
export function buildManeuvers(pts) {
  if (pts.length < SMOOTH * 2 + 2) return [];
  const cumDist = buildCumDist(pts);
  const result  = [];
  let lastDist  = 0;

  for (let i = SMOOTH; i < pts.length - SMOOTH; i++) {
    const bBefore = brng(pts[i-SMOOTH].lat, pts[i-SMOOTH].lon, pts[i].lat, pts[i].lon);
    const bAfter  = brng(pts[i].lat, pts[i].lon, pts[i+SMOOTH].lat, pts[i+SMOOTH].lon);
    const turn    = angleDiff(bBefore, bAfter);
    const cd      = cumDist[i];

    if (Math.abs(turn) < MIN_TURN)            continue;
    if (cd - lastDist < MIN_SEP_KM)           continue;

    lastDist = cd;
    result.push({
      idx:          i,
      lat:          pts[i].lat,
      lon:          pts[i].lon,
      distFromStart: cd,
      type:  turn > 0 ? 'right' : 'left',
      icon:  _turnIcon(turn),
      label: _turnLabel(turn),
      cls:   turn > 0 ? 'right' : 'left',
    });
  }
  return result;
}

// ── Route matching ─────────────────────────────────────────────────────────

/**
 * Find the route point nearest to the vehicle.
 * Uses a windowed search (AHEAD/BACK from last known position) to prevent
 * backward jumps on bidirectional roads. Applies direction penalty.
 */
export function nearestRoutePoint(lat, lng, speed, heading) {
  const pts      = State.get('nav.routePts');
  const cumDist  = State.get('nav.routeCumDist');
  const lastIdx  = State.get('nav.lastRouteIdx');
  if (!pts.length) return { nearIdx: 0, distFromStart: 0 };

  const from = Math.max(0, lastIdx - BACK);
  const to   = Math.min(pts.length - 1, lastIdx + AHEAD);

  let bestIdx   = from;
  let bestScore = Infinity;

  for (let i = from; i <= to; i++) {
    const dist  = haversine(lat, lng, pts[i].lat, pts[i].lon) * 1000; // metres

    // Direction penalty: routes going in opposite heading score worse
    let dirPenalty = 0;
    if (heading != null && i < pts.length - 1) {
      const routeDir = brng(pts[i].lat, pts[i].lon, pts[i+1].lat, pts[i+1].lon);
      const diff     = Math.abs(angleDiff(heading, routeDir));
      dirPenalty     = (diff / 180) * 60; // max 60 m penalty for opposite direction
    }

    const score = dist + dirPenalty;
    if (score < bestScore) { bestScore = score; bestIdx = i; }
  }

  // Never regress beyond BACK limit
  const newIdx = Math.max(from, bestIdx);
  State.set('nav.lastRouteIdx', newIdx);
  return { nearIdx: newIdx, distFromStart: cumDist[newIdx] };
}

/** Find route index closest to the NEXT upcoming stop (forward-only search) */
export function findNextStopRouteIdx(fromIdx) {
  const pts   = State.get('nav.routePts');
  const stops = State.get('nav.stops');
  const ns    = stops.find(s => s.state !== 'done');

  if (!ns || !pts.length) return pts.length - 1;

  let bestIdx  = fromIdx;
  let bestDist = haversine(pts[fromIdx].lat, pts[fromIdx].lon, ns.lat, ns.lng);
  const end    = Math.min(pts.length, fromIdx + 600);

  for (let i = fromIdx + 1; i < end; i++) {
    const d = haversine(pts[i].lat, pts[i].lon, ns.lat, ns.lng);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }

  if (bestDist > 0.5) {
    // Sanity check: next stop is > 500m from nearest route point
    console.warn('[Nav] findNextStopRouteIdx: stop may be off-route, dist=', bestDist.toFixed(2), 'km');
  }
  return bestIdx;
}

// ── Instruction ────────────────────────────────────────────────────────────

/**
 * Return the next instruction to show in the HUD.
 * Priority: stops > turns > destination.
 */
export function getNextManeuver(curIdx, distFromStart) {
  const pts       = State.get('nav.routePts');
  const maneuvers = State.get('nav.maneuvers');
  const stops     = State.get('nav.stops');
  const curPos    = State.get('nav.currentPos');
  if (!curPos) return null;

  const radius = 80; // TODO: read from settings in app.js

  // Find nearest non-done stop within 4x radius
  const ns = stops
    .filter(s => s.state !== 'done')
    .find(s => haversine(curPos.lat, curPos.lng, s.lat, s.lng) * 1000 < radius * 4);

  // Upcoming turns
  const upcoming = maneuvers.filter(
    m => m.idx > curIdx && m.distFromStart > distFromStart
  );
  const nm = upcoming[0] || null;

  if (ns) {
    const stopDist = haversine(curPos.lat, curPos.lng, ns.lat, ns.lng) * 1000;
    const manDist  = nm
      ? haversine(curPos.lat, curPos.lng, nm.lat, nm.lon) * 1000
      : Infinity;

    if (stopDist < manDist) {
      // AT the stop — show live timer
      if (stopDist <= radius && ns.state === 'current') {
        const elapsed  = fmtTime(ns.elapsed);
        const planned  = ns.dur_s ? ` / ${fmtTime(ns.dur_s)}` : '';
        return {
          dist:   0,
          icon:   '⏸',
          label:  ns.running ? `⏱ ${elapsed}${planned}` : 'At stop — tap Done',
          detail: `${ns.name} · tap ✓ Done to continue`,
          cls:    'stop',
          type:   'stop',
        };
      }
      // Approaching stop
      return {
        dist:   stopDist,
        icon:   '⏸',
        label:  'Make a stop',
        detail: ns.name + (ns.dur_s ? ` · Planned: ${fmtTime(ns.dur_s)}` : ''),
        cls:    'stop',
        type:   'stop',
      };
    }
  }

  if (!nm) {
    return { dist: 0, icon: '🏁', label: 'Destination reached', detail: '', cls: 'arrive', type: 'arrive' };
  }

  const distToTurn = haversine(curPos.lat, curPos.lng, nm.lat, nm.lon) * 1000;
  return {
    dist:   distToTurn,
    icon:   nm.icon,
    label:  nm.label,
    detail: upcoming[1] ? `Then: ${upcoming[1].label}` : '',
    cls:    nm.cls,
    type:   nm.type,
  };
}

// ── Arrival / Departure ────────────────────────────────────────────────────

/**
 * Check which stops were arrived at or departed from.
 * Returns {arrived: [stop], departed: [stop]} — caller handles state changes.
 * Speed-aware: expands radius when vehicle is slowing down.
 */
export function checkArrivals(lat, lng, speed, baseRadius) {
  const stops    = State.get('nav.stops');
  const inside   = State.get('nav.insideStop');
  const arrived  = [];
  const departed = [];

  // Speed-aware radius expansion
  const radius = (speed != null && speed < 20)
    ? baseRadius * 1.8
    : baseRadius;

  // Find nearest non-done stop for correct photo (prevents forEach last-wins bug)
  let nearestStop = null, nearestDist = Infinity;
  stops.forEach(s => {
    if (s.state === 'done') return;
    const d = haversine(lat, lng, s.lat, s.lng) * 1000;
    if (d < nearestDist) { nearestDist = d; nearestStop = s; }
  });

  stops.forEach(s => {
    if (s.state === 'done') return;
    const distM = haversine(lat, lng, s.lat, s.lng) * 1000;

    if (distM <= radius && !inside.has(s.id)) {
      inside.add(s.id);
      arrived.push({ stop: s, distM, isNearest: s.id === nearestStop?.id });
    } else if (distM > radius * 1.2 && inside.has(s.id)) {
      inside.delete(s.id);
      departed.push({ stop: s, distM });
    }
  });

  return { arrived, departed };
}

// ── GPX Parser ─────────────────────────────────────────────────────────────

/** Parse GPX XML → {routePts, stops, name, dist} */
export function parseGPX(xml, filename) {
  const doc    = new DOMParser().parseFromString(xml, 'application/xml');
  const trkpts = doc.querySelectorAll('trkpt');

  const pts = [];
  trkpts.forEach(p => {
    const lat = +p.getAttribute('lat'), lon = +p.getAttribute('lon');
    if (!isNaN(lat) && !isNaN(lon)) pts.push({ lat, lon });
  });

  const wpts = doc.querySelectorAll('wpt');
  const stops = [];
  wpts.forEach((w, i) => {
    const lat  = +w.getAttribute('lat'), lon = +w.getAttribute('lon');
    const name = w.querySelector('name')?.textContent || `Stop ${i + 1}`;
    const dur  = w.querySelector('duracao_s') || w.querySelector('desc');
    const events = [];
    if (w.querySelector('openDoor')) events.push('openDoor');
    if (w.querySelector('kneeling')) events.push('kneeling');
    if (!isNaN(lat) && !isNaN(lon)) {
      stops.push({
        id: i + 1,
        name,
        lat, lng: lon,
        dur_s:   dur ? +dur.textContent : 0,
        elapsed: 0, running: false, intervalId: null,
        state:   'waiting',
        photo:   null,
        events,
      });
    }
  });

  const meta  = doc.querySelector('metadata name');
  const name  = meta?.textContent
    || filename?.replace(/\.gpx$/i, '').replace(/_/g, ' ')
    || 'Route';

  const cumDist = buildCumDist(pts);
  const dist    = cumDist[cumDist.length - 1] || 0;

  return { pts, stops, name, dist, cumDist };
}

// ── Helpers ────────────────────────────────────────────────────────────────
function _turnIcon(deg) {
  const a = Math.abs(deg);
  if (a < 35)  return deg > 0 ? '↗' : '↖';
  if (a < 100) return deg > 0 ? '→' : '←';
  if (a < 150) return deg > 0 ? '↪' : '↩';
  return '↺';
}

function _turnLabel(deg) {
  const a = Math.abs(deg);
  const dir = deg > 0 ? 'right' : 'left';
  if (a < 35)  return `Slight ${dir}`;
  if (a < 100) return `Turn ${dir}`;
  if (a < 150) return `Sharp ${dir}`;
  return 'U-turn';
}
