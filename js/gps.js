/**
 * gps.js — GPS sensor management.
 * Handles watchPosition, permission, speed/heading smoothing, fallback calc.
 * Emits positions via onPosition callback. Caller handles all state changes.
 */

import { State } from './state.js';

// ── Configuration ──────────────────────────────────────────────────────────
const SPEED_BUF_SIZE   = 5;     // readings for speed averaging
const HEADING_BUF_SIZE = 4;     // readings for heading circular-mean
const MAX_SPEED_KMH    = 200;   // reject GPS spikes above this
const MAX_GAP_SEC      = 15;    // reject calc if gap > 15s between points

// ── Public callbacks (set by app.js) ──────────────────────────────────────
export const GPS = {
  onPosition: null,   // (pos: GpsPosition) => void
  onError:    null,   // (message: string, code: number) => void
  onStatus:   null,   // (status: 'idle'|'waiting'|'active'|'error', msg: string) => void

  // ── Start/Stop ────────────────────────────────────────────────────────
  async start() {
    if (State.get('sensor.watchId') !== null) return; // already running

    const permission = await this.requestPermission();
    if (permission === 'denied') {
      this._emitError('GPS permission denied', 1);
      return;
    }

    this._emitStatus('waiting', 'Acquiring GPS...');
    this._clearBuffers();

    const watchId = navigator.geolocation.watchPosition(
      (pos) => this._handleRaw(pos),
      (err) => this._handleError(err),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
    );
    State.set('sensor.watchId', watchId);
  },

  stop() {
    const id = State.get('sensor.watchId');
    if (id !== null) {
      navigator.geolocation.clearWatch(id);
      State.set('sensor.watchId', null);
    }
    this._clearBuffers();
    this._emitStatus('idle', 'GPS stopped');
  },

  isRunning() {
    return State.get('sensor.watchId') !== null;
  },

  // ── Permission ────────────────────────────────────────────────────────
  async requestPermission() {
    if (!('geolocation' in navigator)) return 'unavailable';
    if (navigator.permissions) {
      try {
        const result = await navigator.permissions.query({ name: 'geolocation' });
        if (result.state === 'denied') return 'denied';
      } catch { /* permissions API not available on all browsers */ }
    }
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        () => resolve('granted'),
        (e) => resolve(e.code === 1 ? 'denied' : 'unavailable'),
        { timeout: 5000, maximumAge: 60000 }
      );
    });
  },

  // ── Raw position handler ──────────────────────────────────────────────
  _handleRaw(pos) {
    const { latitude: lat, longitude: lng, accuracy, altitude,
            speed, heading } = pos.coords;
    const t = pos.timestamp;

    // Speed: prefer GPS value, fallback to calculated
    const calcSpeed  = this._calcSpeedFromPoints(lat, lng, t);
    const rawSpeed   = speed != null ? speed * 3.6 : calcSpeed;
    const smoothSpeed = this._smoothSpeed(rawSpeed);

    // Heading
    const smoothHeading = this._smoothHeading(heading);

    // Update last GPS position
    State.set('sensor.lastGPSPos', { lat, lng, t });
    this._emitStatus('active', `Accuracy: ${accuracy?.toFixed(0) ?? '?'} m`);

    const gpsPos = {
      lat, lng, t,
      speed:    smoothSpeed,    // km/h, smoothed, never null
      rawSpeed: rawSpeed,       // km/h, before smoothing (may be null)
      heading:  smoothHeading,  // degrees, smoothed (may be null)
      accuracy,
      altitude,
    };

    State.merge('sensor', {
      speedBuffer:   [...State.get('sensor.speedBuffer').slice(-SPEED_BUF_SIZE)],
      headingBuffer: [...State.get('sensor.headingBuffer').slice(-HEADING_BUF_SIZE)],
    });

    if (this.onPosition) this.onPosition(gpsPos);
  },

  _handleError(err) {
    const msgs = {
      1: 'GPS permission denied — check browser settings',
      2: 'GPS position unavailable',
      3: 'GPS timeout — check signal',
    };
    this._emitError(msgs[err.code] || 'GPS error', err.code);
  },

  // ── Speed calculation fallback ────────────────────────────────────────
  _calcSpeedFromPoints(lat, lng, t) {
    const last = State.get('sensor.lastGPSPos');
    if (!last) return null;
    const dtSec = (t - last.t) / 1000;
    if (dtSec <= 0 || dtSec > MAX_GAP_SEC) return null;
    const dtHr  = dtSec / 3600;
    const dist  = haversine(last.lat, last.lng, lat, lng); // km
    const speed = dist / dtHr;
    return speed > MAX_SPEED_KMH ? null : speed;
  },

  // ── Speed smoothing (simple moving average) ───────────────────────────
  _smoothSpeed(raw) {
    const buf = State.get('sensor.speedBuffer');
    if (raw == null) {
      // Decay: return last known or 0
      return buf.length ? buf[buf.length - 1] : 0;
    }
    const clamped = Math.min(raw, MAX_SPEED_KMH);
    const next = [...buf, clamped].slice(-SPEED_BUF_SIZE);
    State.set('sensor.speedBuffer', next);
    return next.reduce((a, b) => a + b, 0) / next.length;
  },

  // ── Heading smoothing (circular mean to handle 359°→1° wrap) ─────────
  _smoothHeading(raw) {
    if (raw == null || isNaN(raw)) return State.get('nav.currentHeading');
    const buf  = [...State.get('sensor.headingBuffer'), raw].slice(-HEADING_BUF_SIZE);
    State.set('sensor.headingBuffer', buf);
    const sin  = buf.reduce((a, h) => a + Math.sin(h * Math.PI / 180), 0);
    const cos  = buf.reduce((a, h) => a + Math.cos(h * Math.PI / 180), 0);
    return ((Math.atan2(sin, cos) * 180 / Math.PI) + 360) % 360;
  },

  _clearBuffers() {
    State.set('sensor.speedBuffer', []);
    State.set('sensor.headingBuffer', []);
    State.set('sensor.lastGPSPos', null);
  },

  _emitStatus(status, msg) {
    State.merge('sensor', { gpsStatus: status, gpsMessage: msg });
    if (this.onStatus) this.onStatus(status, msg);
  },

  _emitError(msg, code) {
    this._emitStatus('error', msg);
    if (this.onError) this.onError(msg, code);
  },
};

// ── Geo utilities (used by GPS and navigation) ─────────────────────────────
export function haversine(la1, lo1, la2, lo2) {
  const R = 6371, r = Math.PI / 180;
  const dL = (la2 - la1) * r, dN = (lo2 - lo1) * r;
  const a  = Math.sin(dL/2)**2 + Math.cos(la1*r) * Math.cos(la2*r) * Math.sin(dN/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); // km
}

export function brng(la1, lo1, la2, lo2) {
  const r   = Math.PI / 180, dN = (lo2 - lo1) * r;
  return Math.atan2(
    Math.sin(dN) * Math.cos(la2 * r),
    Math.cos(la1 * r) * Math.sin(la2 * r) - Math.sin(la1 * r) * Math.cos(la2 * r) * Math.cos(dN)
  ) * 180 / Math.PI;
}

export function angleDiff(a, b) {
  let d = b - a;
  while (d > 180)  d -= 360;
  while (d < -180) d += 360;
  return d;
}

export function fmtTime(s) {
  if (!s || isNaN(s)) return '00:00:00';
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = s % 60;
  return [h, m, sc].map(v => String(v).padStart(2, '0')).join(':');
}

export function fmtDist(m) {
  if (m < 20)   return 'here';
  if (m < 1000) return Math.round(m / 10) * 10 + ' m';
  return (m / 1000).toFixed(1) + ' km';
}
