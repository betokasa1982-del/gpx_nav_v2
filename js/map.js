/**
 * map.js — All Leaflet map logic.
 * Layers, markers, position tracking, heading-up rotation.
 * Assumes L (Leaflet) is available as a global (loaded via CDN in index.html).
 */

import { State } from './state.js';
import { haversine } from './gps.js';

const TILES = {
  day:   'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  night: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>';

// ── Module state (Leaflet objects — not in State.js, not serialisable) ─────
let _map        = null;
let _tileLayer  = null;
let _posMarker  = null;
let _accCircle  = null;
let _rotSupported = null; // tri-state: null=untested, true, false

const _layers = {
  route:   null,   // full route dim
  ahead:   null,   // segment to next stop — bright
  remain:  null,   // after next stop — dashed dim
  done:    null,   // traversed — grey
  rec:     null,   // live recording track
};
const _stopMarkers = {};  // id → L.Marker

// ── Init ───────────────────────────────────────────────────────────────────
export const MapModule = {

  init(containerId) {
    _map = L.map(containerId, {
      center:      [0, 0],
      zoom:        3,
      zoomControl: false,
      tap:         true,
    });

    L.control.zoom({ position: 'bottomleft' }).addTo(_map);

    _tileLayer = L.tileLayer(TILES.day, {
      attribution: TILE_ATTR,
      subdomains:  'abcd',
      maxZoom:     20,
    }).addTo(_map);

    // Re-apply bearing after every Leaflet move/zoom (Leaflet rewrites transform)
    _map.on('move zoom', () => {
      const h = State.get('nav.currentHeading');
      if (h != null && State.get('mode') !== 'idle') {
        requestAnimationFrame(() => this._applyBearing(-h));
      }
    });

    return _map;
  },

  // ── Tile style ────────────────────────────────────────────────────────
  setTile(mode) {
    if (!_map || !TILES[mode]) return;
    _map.removeLayer(_tileLayer);
    _tileLayer = L.tileLayer(TILES[mode], {
      attribution: TILE_ATTR, subdomains: 'abcd', maxZoom: 20,
    }).addTo(_map);
    // Bring route layers to front
    Object.values(_layers).forEach(l => l?.bringToFront?.());
    Object.values(_stopMarkers).forEach(m => m?.bringToFront?.());
    State.set('ui.mapTile', mode);
  },

  // ── Position marker ───────────────────────────────────────────────────
  updatePosition(pos, zoom, follow) {
    if (!_map) return;
    const { lat, lng, accuracy, heading } = pos;

    // Create or move position marker
    if (!_posMarker) {
      const icon = L.divIcon({
        html: `<div style="width:22px;height:22px;border-radius:50%;
          background:var(--accent,#f0a500);border:3px solid #fff;
          box-shadow:0 0 10px rgba(240,165,0,.8)"></div>`,
        className: '',
        iconAnchor: [11, 11],
      });
      _posMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(_map);
    } else {
      _posMarker.setLatLng([lat, lng]);
    }

    // Accuracy circle
    if (accuracy && accuracy < 200) {
      if (!_accCircle) {
        _accCircle = L.circle([lat, lng], { radius: accuracy, color: 'var(--accent,#f0a500)', fillOpacity: 0.06, weight: 1 }).addTo(_map);
      } else {
        _accCircle.setLatLng([lat, lng]);
        _accCircle.setRadius(accuracy);
      }
    }

    // Map heading-up rotation
    const h = State.get('nav.currentHeading');
    if (h != null) this._applyBearing(-h);
    else            this._applyBearing(0);

    // Follow position
    if (follow && zoom) {
      if (h != null && State.get('mode') !== 'idle') {
        // Offset centre slightly behind vehicle to show more road ahead
        const hr   = h * Math.PI / 180;
        const offM = 40;
        const dLat = Math.cos(hr + Math.PI) * offM / 111320;
        const dLng = Math.sin(hr + Math.PI) * offM / (111320 * Math.cos(lat * Math.PI / 180));
        _map.setView([lat + dLat, lng + dLng], zoom, { animate: true, duration: 0.4 });
      } else {
        _map.setView([lat, lng], zoom, { animate: true, duration: 0.5 });
      }
    }
  },

  // ── Route layers ──────────────────────────────────────────────────────
  loadRoute(pts, stops) {
    this.clearLayers();
    if (pts.length < 2) return;
    const ll = pts.map(p => [p.lat, p.lon]);

    _layers.route  = L.polyline(ll, { color: 'rgba(240,165,0,.12)', weight: 5 }).addTo(_map);
    _layers.ahead  = L.polyline(ll, { color: '#f0a500', weight: 5 }).addTo(_map);
    _layers.remain = L.polyline([], { color: 'rgba(240,165,0,.3)', weight: 3, dashArray: '7 5' }).addTo(_map);
    _layers.done   = L.polyline([], { color: '#555', weight: 4 }).addTo(_map);

    this._addStopMarkers(stops);

    try {
      const b = _layers.route.getBounds();
      if (b && b.isValid()) _map.fitBounds(b, { padding: [22, 22] });
    } catch { _map.setView([pts[0].lat, pts[0].lon], 15); }
  },

  /** Update progress layers. segEnd = route index of next stop. */
  updateProgress(nearIdx, segEnd) {
    const pts = State.get('nav.routePts');
    if (!pts.length || !_layers.done) return;

    _layers.done.setLatLngs(
      nearIdx > 0 ? pts.slice(0, nearIdx + 1).map(p => [p.lat, p.lon]) : []
    );
    _layers.ahead.setLatLngs(
      pts.slice(nearIdx, segEnd + 1).map(p => [p.lat, p.lon])
    );
    _layers.remain.setLatLngs(
      segEnd < pts.length - 1 ? pts.slice(segEnd).map(p => [p.lat, p.lon]) : []
    );
  },

  updateRecTrack(points) {
    if (!_map) return;
    const ll = points.map(p => [p.lat, p.lng]);
    if (!_layers.rec) {
      _layers.rec = L.polyline(ll, { color: '#58a6ff', weight: 3 }).addTo(_map);
    } else {
      _layers.rec.setLatLngs(ll);
    }
  },

  clearLayers() {
    Object.keys(_layers).forEach(k => {
      if (_layers[k]) { try { _map.removeLayer(_layers[k]); } catch {} }
      _layers[k] = null;
    });
    Object.values(_stopMarkers).forEach(m => { try { _map.removeLayer(m); } catch {} });
    for (const k in _stopMarkers) delete _stopMarkers[k];
  },

  resetBearing() { this._applyBearing(0); },

  focusStop(stop, zoom = 17) {
    if (!_map || !stop) return;
    _map.setView([stop.lat, stop.lng], zoom, { animate: true });
  },

  getMap() { return _map; },

  // ── Stop markers ──────────────────────────────────────────────────────
  _addStopMarkers(stops) {
    (stops || []).forEach(s => {
      const icon = _makeStopIcon(s);
      const m    = L.marker([s.lat, s.lng], { icon, zIndexOffset: 900 }).addTo(_map);
      _stopMarkers[s.id] = m;
    });
  },

  updateStopMarkerState(stop) {
    const m = _stopMarkers[stop.id];
    if (!m) return;
    m.setIcon(_makeStopIcon(stop));
  },

  // ── Heading-up CSS rotation ───────────────────────────────────────────
  /** Test once whether DOMMatrix parsing works for this browser */
  _testRotationSupport() {
    if (!_map) return false;
    try {
      const pane = _map.getContainer().querySelector('.leaflet-map-pane');
      if (!pane) return false;
      const mx = new DOMMatrix(window.getComputedStyle(pane).transform);
      return !isNaN(mx.m41);
    } catch { return false; }
  },

  /**
   * Apply bearing to .leaflet-map-pane using DOMMatrix (robust, no regex).
   * Falls back to north-up silently if not supported.
   */
  _applyBearing(deg) {
    if (!_map) return;
    if (_rotSupported === null) _rotSupported = this._testRotationSupport();
    if (!_rotSupported) return; // graceful north-up fallback

    try {
      const pane = _map.getContainer().querySelector('.leaflet-map-pane');
      if (!pane) return;
      const sz   = _map.getSize();
      const mx   = new DOMMatrix(window.getComputedStyle(pane).transform);
      const tx   = mx.m41, ty = mx.m42;
      const ox   = sz.x / 2 - tx;
      const oy   = sz.y / 2 - ty;

      pane.style.transformOrigin = `${ox}px ${oy}px`;
      pane.style.transform       = `translate(${tx}px,${ty}px) rotate(${deg}deg)`;
    } catch (e) {
      _rotSupported = false; // disable after first failure
    }
  },
};

// ── Stop icon factory ──────────────────────────────────────────────────────
function _makeStopIcon(s) {
  const colors  = { waiting: '#f0a500', current: '#3fb950', done: '#666' };
  const bg      = colors[s.state] || colors.waiting;
  const label   = s.state === 'done' ? '✓' : s.id;
  const badges  = (s.events || []).map(e => e === 'openDoor' ? '🚪' : e === 'kneeling' ? '♿' : '').join('');
  const camera  = s.photo ? '📷' : '';

  return L.divIcon({
    html: `<div style="display:flex;flex-direction:column;align-items:center;gap:1px">
      <div style="background:${bg};color:${s.state==='done'?'#fff':'#000'};font-size:11px;
        font-weight:700;font-family:monospace;padding:2px 7px;border-radius:10px;
        white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.55)">
        ${label}${camera}${badges}
      </div>
      <div style="width:10px;height:10px;background:${bg};border:2px solid #fff;
        border-radius:50%;box-shadow:0 0 5px ${bg}"></div>
    </div>`,
    className:  '',
    iconAnchor: [20, 28],
  });
}
