/**
 * recording.js — All recording logic.
 * Builds recPoints and recStops. Detects stops by speed threshold.
 * Integrates with events (Open Door, Kneeling) and photo capture.
 */

import { State } from './state.js';
import { haversine } from './gps.js';
import { generateId } from './storage.js';

// ── Public API ─────────────────────────────────────────────────────────────
export const Recording = {

  /** Called on every GPS position while isRec=true */
  processGPSPoint(pos) {
    const { lat, lng, t, speed } = pos;
    const settings = State.get('settings');

    // Append track point
    const pts = State.get('rec.points');
    pts.push({ lat, lng, t });

    // Stop candidate detection
    const candidate = State.get('rec.stopCandidate');
    const spd       = speed ?? 0;

    if (spd <= settings.recStopSpeed) {
      if (!candidate) {
        State.set('rec.stopCandidate', { lat, lng, t: Date.now(), marked: false });
        // Emit status for UI
        if (this.onStatus) this.onStatus('slowing', 0, settings.recStopMinDur);
      } else {
        const elapsed = (Date.now() - candidate.t) / 1000;
        if (this.onStatus) this.onStatus('stopped', elapsed, settings.recStopMinDur);

        if (elapsed >= settings.recStopMinDur && !candidate.marked) {
          candidate.marked = true;
          this._registerStop(lat, lng, candidate.t);
        }
      }
    } else {
      // Vehicle moved — close any open stop
      if (candidate) {
        if (candidate.marked) {
          const stops  = State.get('rec.stops');
          const last   = stops[stops.length - 1];
          if (last && !last.dur_s) {
            last.dur_s = Math.round((Date.now() - last.startT) / 1000);
          }
        }
        State.set('rec.stopCandidate', null);
      }
      const stops = State.get('rec.stops');
      const count = stops.length;
      const photos = stops.filter(s => s.photo).length;
      if (this.onStatus) this.onStatus('moving', count, photos);
    }
  },

  /** Build the final Recording object from the current rec state */
  buildRecording() {
    const settings = State.get('settings');
    const points   = State.get('rec.points');
    const stops    = State.get('rec.stops');

    // Close any still-open stop
    const candidate = State.get('rec.stopCandidate');
    if (candidate?.marked && stops.length > 0) {
      const last = stops[stops.length - 1];
      if (!last.dur_s) {
        last.dur_s = Math.round((Date.now() - last.startT) / 1000);
      }
    }

    const dist = _calcDist(points);
    const id   = generateId();
    const now  = new Date();

    return {
      _v:    1,
      id,
      name:  `Route ${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'})}`,
      date:  now.toISOString(),
      dist,
      points: points.map(p => ({ lat: p.lat, lng: p.lng, t: p.t })),
      stops:  stops.map((s, i) => ({
        id:     i + 1,
        lat:    s.lat,
        lng:    s.lng,
        t:      s.t,
        dur_s:  s.dur_s || 0,
        photo:  s.photo || null,
        events: s.events || [],
      })),
    };
  },

  /** Attach a photo (base64 data URL) to the pending stop */
  attachPhoto(dataURL) {
    const idx = State.get('rec.pendingStopIdx');
    const stops = State.get('rec.stops');
    if (idx >= 0 && idx < stops.length) {
      stops[idx].photo = dataURL;
      if (this.onPhotoSaved) this.onPhotoSaved(idx, stops[idx]);
    }
    this._closePendingStop();
  },

  /** Attach events to the pending stop */
  attachEvents(events) {
    const idx = State.get('rec.pendingStopIdx');
    const stops = State.get('rec.stops');
    if (idx >= 0 && idx < stops.length) {
      stops[idx].events = [...events];
    }
  },

  /** Confirm stop prompt (events set, photo optional) */
  confirmStop() {
    this._closePendingStop();
  },

  /** Build GPX XML string from a recording */
  buildGPX(rec) {
    const esc = s => s?.toString().replace(/&/g,'&amp;').replace(/</g,'&lt;') || '';
    const t   = (rec.date instanceof Date ? rec.date : new Date(rec.date)).toISOString();
    let xml   = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPX Navigator Pro"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
<metadata><name>${esc(rec.name)}</name><time>${t}</time></metadata>
`;
    // Waypoints (stops)
    (rec.stops || []).forEach((s, i) => {
      const events = (s.events || []).join(', ');
      xml += `<wpt lat="${s.lat.toFixed(7)}" lon="${s.lng.toFixed(7)}">
  <name>${esc(s.name || `Stop ${i+1}`)}</name>
  <desc>Duration: ${s.dur_s || 0}s${events ? ' · ' + events : ''}</desc>
  <duracao_s>${s.dur_s || 0}</duracao_s>
${s.events?.includes('openDoor') ? '  <openDoor>1</openDoor>\n' : ''}${s.events?.includes('kneeling') ? '  <kneeling>1</kneeling>\n' : ''}</wpt>
`;
    });
    // Track
    xml += `<trk><name>${esc(rec.name)}</name><trkseg>\n`;
    (rec.points || []).forEach(p => {
      xml += `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}"><time>${new Date(p.t).toISOString()}</time></trkpt>\n`;
    });
    xml += `</trkseg></trk>\n</gpx>`;
    return xml;
  },

  /** Compress an image File to JPEG, max side = maxSide px, quality 0.72 */
  async compressPhoto(file, maxSide = 800) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.round(img.width  * scale);
        const h = Math.round(img.height * scale);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.72));
      };
      img.onerror = reject;
      img.src = url;
    });
  },

  // Callbacks (set by app.js)
  onStatus:     null,   // (status, ...args) => void
  onStopPrompt: null,   // (stopIdx, stopNum) => void  — show cam-prompt
  onPhotoSaved: null,   // (idx, stop) => void

  // ── Internal ─────────────────────────────────────────────────────────
  _registerStop(lat, lng, startT) {
    const stops = State.get('rec.stops');
    const idx   = stops.length;
    stops.push({ lat, lng, t: Date.now(), dur_s: 0, startT, photo: null, events: [] });
    State.set('rec.pendingStopIdx', idx);
    State.set('rec.pendingEvents', []);
    if (this.onStopPrompt) this.onStopPrompt(idx, idx + 1);
  },

  _closePendingStop() {
    State.set('rec.pendingStopIdx', -1);
    State.set('rec.pendingEvents', []);
  },
};

// ── Utilities ──────────────────────────────────────────────────────────────
function _calcDist(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    d += haversine(pts[i-1].lat, pts[i-1].lng, pts[i].lat, pts[i].lng);
  }
  return +d.toFixed(3);
}
