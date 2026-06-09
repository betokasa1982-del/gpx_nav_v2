/**
 * app.js — Bootstrap and integration layer.
 * Wires all modules together. Owns lifecycle (startNav, stopNav, startRec, stopRec).
 * This is the ONLY file that imports from multiple modules simultaneously.
 */

import { State }      from './state.js';
import {
  saveRecording, loadAllRecordings, loadRecording,
  deleteRecording, saveSettings, loadSettings,
  migrateFromLocalStorage, exportAllJSON, importJSON,
  validateRecording, generateId,
} from './storage.js';
import { GPS, haversine, fmtTime, fmtDist } from './gps.js';
import {
  buildCumDist, buildManeuvers, nearestRoutePoint,
  findNextStopRouteIdx, getNextManeuver, checkArrivals, parseGPX,
} from './navigation.js';
import { Recording } from './recording.js';
import { Voice }     from './voice.js';
import { MapModule } from './map.js';
import { UI }        from './ui.js';

// ── Bootstrap ──────────────────────────────────────────────────────────────
async function init() {
  // 1. Init map
  MapModule.init('map');

  // 2. Load persistent data
  const migrated = await migrateFromLocalStorage();
  if (migrated > 0) console.log(`[App] Migrated ${migrated} recs`);

  const [recs, settings] = await Promise.all([
    loadAllRecordings(),
    loadSettings(),
  ]);

  // 3. Restore settings
  if (settings) State.merge('settings', settings);

  // 4. Restore recordings list
  State.set('savedRecs', recs);
  recs.forEach((rec, idx) => {
    UI.renderRecCard(rec, idx,
      id => _loadRec(id),
      id => _deleteRec(id),
      id => _exportGPX(id),
    );
  });
  if (recs.length === 0) _showEl('rec-empty', '');

  // 5. Wire GPS callbacks
  GPS.onPosition = _handleGPSUpdate;
  GPS.onError    = (msg) => { UI.showAlert('error', msg); UI.setGPSStatus('error', msg); };
  GPS.onStatus   = (status, msg) => UI.setGPSStatus(status, msg);

  // 6. Wire Recording callbacks
  Recording.onStatus     = (status, ...args) => {
    const stops = State.get('rec.stops');
    UI.updateRecIndicator(status,
      status === 'moving'  ? stops.length : args[0],
      status === 'moving'  ? stops.filter(s => s.photo).length : args[1]
    );
  };
  Recording.onStopPrompt = (idx, num) => {
    _updateRecStopMarker(idx);
    UI.showStopPrompt(num);
  };
  Recording.onPhotoSaved = (idx) => {
    _updateRecStopMarker(idx);
    Voice.speak('Photo saved');
  };

  // 7. Wire UI callbacks
  UI.onStopDone = (stopId) => _manualDoneStop(stopId);

  // 8. WakeLock restore on visibility
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && State.get('mode') !== 'idle') {
      _acquireWakeLock();
    }
  });

  // 9. UI init
  UI.init();
  UI.applySheet();
  UI.setGPSStatus('idle', 'GPS idle');
  console.log('[App] Ready — SW', navigator.serviceWorker ? 'available' : 'N/A');
}

// ── GPS handler — main orchestration ──────────────────────────────────────
function _handleGPSUpdate(pos) {
  const { lat, lng, speed, heading } = pos;
  const mode = State.get('mode');

  // Update shared position
  State.set('nav.currentPos',     { lat, lng });
  State.set('nav.currentHeading', heading);
  State.set('nav.currentSpeed',   speed);

  // ── Recording mode ─────────────────────────────────────────────────
  if (mode === 'rec') {
    Recording.processGPSPoint(pos);

    // Update live rec track on map
    MapModule.updateRecTrack(State.get('rec.points'));

    // Update position marker
    const settings = State.get('settings');
    MapModule.updatePosition(pos, settings.zoomLevel, settings.followPosition);
  }

  // ── Navigation mode ────────────────────────────────────────────────
  if (mode === 'nav') {
    const { nearIdx, distFromStart } = nearestRoutePoint(lat, lng, speed, heading);
    const settings  = State.get('settings');
    const segEnd    = findNextStopRouteIdx(nearIdx);
    const instr     = getNextManeuver(nearIdx, distFromStart);

    // Update map
    MapModule.updateProgress(nearIdx, segEnd);
    MapModule.updatePosition(pos, settings.zoomLevel, settings.followPosition);

    // Check stop arrivals / departures
    const { arrived, departed } = checkArrivals(lat, lng, speed, settings.arrivalRadius);

    arrived.forEach(({ stop, distM, isNearest }) => {
      _handleArrival(stop, distM, isNearest);
    });
    departed.forEach(({ stop }) => {
      _handleDeparture(stop);
    });

    // HUD
    UI.updateHUD(instr, speed, { status: State.get('sensor.gpsStatus'), msg: State.get('sensor.gpsMessage') });
    if (State.get('ui.hudPanelOpen')) UI.renderHudPanel(State.get('nav.stops'));

    // Voice guidance
    if (instr) Voice.maybeSpeak(instr, instr.dist);

    // Photo preview approaching
    const stops = State.get('nav.stops');
    const ns    = stops.filter(s => s.state !== 'done')
                       .find(s => haversine(lat, lng, s.lat, s.lng) * 1000 < 200);
    if (ns && ns.photo && State.get('ui.photoPreviewStopId') !== ns.id) {
      UI.showPhotoOverlay(ns, haversine(lat, lng, ns.lat, ns.lng) * 1000);
    }

    // Update topbar
    const totalDone = stops.filter(s => s.state === 'done').length;
    const totalDist = State.get('nav.totalDist');
    const planned   = stops.reduce((a, s) => a + (s.dur_s  || 0), 0);
    const actual    = stops.reduce((a, s) => a + (s.elapsed || 0), 0);
    UI.updateTopbar({
      dist:       totalDist - (State.get('nav.routeCumDist')[nearIdx] || 0),
      stops:      `${totalDone}/${stops.length}`,
      planned:    planned ? fmtTime(planned) : '—',
      actual:     fmtTime(actual),
      sourceFile: State.get('nav.sourceFile'),
    });
    UI.updateSummaryBar(stops);
  }
}

// ── Arrival / Departure handlers ──────────────────────────────────────────
function _handleArrival(stop, distM, isNearest) {
  stop.state = 'current';
  const settings = State.get('settings');

  UI.showAlert('arrived', `📍 ${stop.name}${stop.dur_s ? ' · ' + fmtTime(stop.dur_s) : ''}`);
  MapModule.updateStopMarkerState(stop);

  // Photo: only for the nearest stop
  if (isNearest && stop.photo) UI.showPhotoOverlay(stop, distM);
  else if (isNearest)          UI.hidePhotoOverlay();

  // Events announcement
  if (stop.events?.length) {
    const msgs = [];
    if (stop.events.includes('openDoor')) msgs.push('open doors');
    if (stop.events.includes('kneeling')) msgs.push('kneeling');
    Voice.speak(`Stop ${stop.id}: ${msgs.join(' and ')} required`, 'high');
  } else {
    Voice.speak(`Arrived at stop ${stop.id}${stop.dur_s ? ', planned ' + fmtTime(stop.dur_s) : ''}`, 'high');
  }
  State.set('ui.lastVoiceKey', '');

  if (settings.autoStartTimer) _startTimer(stop.id);

  // Open HUD panel
  if (!State.get('ui.hudPanelOpen')) UI.toggleHudPanel();
  UI.renderHudPanel(State.get('nav.stops'));
}

function _handleDeparture(stop) {
  const settings = State.get('settings');
  if (settings.autoStopTimer && stop.running) {
    _pauseTimer(stop.id);
    _markDone(stop.id);
    UI.showAlert('departed', `✓ ${stop.name} · ${fmtTime(stop.elapsed)}`);
    if (State.get('ui.photoPreviewStopId') === stop.id) UI.hidePhotoOverlay();
    UI.renderHudPanel(State.get('nav.stops'));
  }
}

// ── Timer ──────────────────────────────────────────────────────────────────
function _startTimer(stopId) {
  const stop = State.get('nav.stops').find(s => s.id === stopId);
  if (!stop || stop.running) return;
  stop.running = true;

  stop.intervalId = setInterval(() => {
    stop.elapsed++;
    _updateTimerDOM(stop);
    UI.updateSummaryBar(State.get('nav.stops'));
    if (State.get('ui.hudPanelOpen')) UI.renderHudPanel(State.get('nav.stops'));

    // Auto-complete when planned time is reached
    if (stop.dur_s > 0 && stop.elapsed >= stop.dur_s) {
      clearInterval(stop.intervalId);
      stop.running = false;
      setTimeout(() => {
        _markDone(stopId);
        UI.hidePhotoOverlay();
        UI.showAlert('arrived', `✓ Stop ${stopId} — time complete`);
        Voice.speak(`Stop ${stopId} time complete. Proceed to the next stop.`, 'high');
        if (State.get('ui.hudPanelOpen')) UI.renderHudPanel(State.get('nav.stops'));
      }, 800);
    }
  }, 1000);
}

function _pauseTimer(stopId) {
  const stop = State.get('nav.stops').find(s => s.id === stopId);
  if (!stop) return;
  clearInterval(stop.intervalId);
  stop.running = false;
}

function _markDone(stopId) {
  const stop = State.get('nav.stops').find(s => s.id === stopId);
  if (!stop) return;
  _pauseTimer(stopId);
  stop.state = 'done';
  MapModule.updateStopMarkerState(stop);
  _updateTimerDOM(stop);
}

function _manualDoneStop(stopId) {
  _markDone(stopId);
  UI.hidePhotoOverlay();
  Voice.speak(`Stop ${stopId} done.`, 'high');
  UI.renderHudPanel(State.get('nav.stops'));
}

function _updateTimerDOM(stop) {
  const el = document.getElementById(`td-${stop.id}`);
  if (el) el.textContent = fmtTime(stop.elapsed);
}

// ── Nav lifecycle ──────────────────────────────────────────────────────────
export async function startNav() {
  if (!State.get('nav.routePts').length) {
    UI.showAlert('error', 'No route loaded — open a GPX file first');
    return;
  }
  State.set('mode', 'nav');
  State.set('nav.lastRouteIdx', 0);
  State.get('nav.insideStop').clear();
  State.get('nav.stops').forEach(s => {
    s.state = 'waiting'; s.elapsed = 0; s.running = false;
    clearInterval(s.intervalId);
  });
  _showEl('btn-nav', 'none'); _showEl('btn-stop-nav', '');
  await GPS.start();
  await _acquireWakeLock();
  MapModule.resetBearing();
  UI.applySheet();
  Voice.speak('Navigation started');
}

export async function stopNav() {
  GPS.stop();
  State.set('mode', 'idle');
  State.get('nav.stops').forEach(s => clearInterval(s.intervalId));
  _showEl('btn-nav', ''); _showEl('btn-stop-nav', 'none');
  MapModule.resetBearing();
  await _releaseWakeLock();
  Voice.cancel();
  UI.setGPSStatus('idle', 'Navigation stopped');
}

// ── Rec lifecycle ──────────────────────────────────────────────────────────
export async function startRec() {
  State.resetRec();
  State.set('mode', 'rec');
  MapModule.clearLayers();
  _showEl('btn-rec', 'none'); _showEl('btn-stop-rec', '');
  await GPS.start();
  await _acquireWakeLock();
  Voice.speak('Recording started');
}

export async function stopRec() {
  GPS.stop();
  const rec = Recording.buildRecording();

  if (!validateRecording(rec)) {
    UI.showAlert('error', 'Route too short to save');
    State.set('mode', 'idle');
    _showEl('btn-rec', ''); _showEl('btn-stop-rec', 'none');
    return;
  }

  await saveRecording(rec);
  const recs = State.get('savedRecs');
  recs.push(rec);
  const idx = recs.length - 1;

  UI.renderRecCard(rec, idx,
    id => _loadRec(id),
    id => _deleteRec(id),
    id => _exportGPX(id),
  );

  State.set('mode', 'idle');
  _showEl('btn-rec', ''); _showEl('btn-stop-rec', 'none');
  await _releaseWakeLock();
  UI.switchTab('recs');
  Voice.speak('Recording saved');
}

// ── Load recording for navigation ─────────────────────────────────────────
async function _loadRec(idx) {
  const meta = State.get('savedRecs')[idx];
  if (!meta) { UI.showAlert('error', 'Recording not found'); return; }

  // Full load with photos
  let rec;
  try {
    rec = await loadRecording(meta.id);
    if (!rec) throw new Error('loadRecording returned null');
  } catch (e) {
    console.error('[App] _loadRec failed:', e);
    UI.showAlert('error', 'Error loading recording: ' + e.message);
    return;
  }

  State.resetNav();
  MapModule.clearLayers();

  // Build navigation state from recording
  const pts = rec.points.map(p => ({ lat: +p.lat, lon: +(p.lng ?? p.lon) }))
                         .filter(p => !isNaN(p.lat) && !isNaN(p.lon));
  if (pts.length < 2) { UI.showAlert('error', 'Route has too few valid points'); return; }

  const cumDist   = buildCumDist(pts);
  const maneuvers = buildManeuvers(pts);
  const totalDist = cumDist[cumDist.length - 1];

  const stops = (rec.stops || [])
    .filter(s => !isNaN(+s.lat) && !isNaN(+s.lng))
    .map((s, i) => ({
      id:        i + 1,
      name:      s.name || `Stop ${i + 1}`,
      lat:       +s.lat,
      lng:       +s.lng,
      dur_s:     s.dur_s || 0,
      elapsed:   0, running: false, intervalId: null,
      state:     'waiting',
      photo:     s.photo || null,
      events:    s.events || [],
    }));

  State.merge('nav', {
    routePts:     pts,
    routeCumDist: cumDist,
    lastRouteIdx: 0,
    maneuvers,
    stops,
    totalDist,
    sourceFile:   rec.name,
  });

  MapModule.loadRoute(pts, stops);

  // Render sheet stops list
  const sl = document.getElementById('stops-list');
  if (sl) { sl.innerHTML = ''; stops.forEach(s => _renderStopCard(s)); }

  // Topbar
  const planned = stops.reduce((a, s) => a + s.dur_s, 0);
  UI.updateTopbar({
    dist: totalDist, stops: `0/${stops.length}`,
    planned: planned ? fmtTime(planned) : '—', actual: '00:00:00',
    sourceFile: rec.name,
  });

  document.getElementById('btn-nav')?.removeAttribute('disabled');
  UI.switchTab('route');
  UI.applySheet();
}

// ── Stop card in sheet ─────────────────────────────────────────────────────
function _renderStopCard(s) {
  const list = document.getElementById('stops-list');
  if (!list) return;
  const card = document.createElement('div');
  card.className = `stop-card state-${s.state}`;
  card.id        = `sc-${s.id}`;
  const badges   = (s.events || []).map(e =>
    `<span class="stop-event-badge">${e === 'openDoor' ? '🚪 Door' : e === 'kneeling' ? '♿ Knee' : ''}</span>`
  ).join('');
  card.innerHTML = `
    <div class="sc-head">
      <div class="sc-num ${s.state}" id="scnum-${s.id}">${s.id}</div>
      <div class="sc-name">${s.name}${s.photo ? ' 📷' : ''}${badges}</div>
      <span class="sc-badge ${s.state}" id="scst-${s.id}">${{waiting:'Waiting',current:'⏱ At stop',done:'✓ Done'}[s.state]||''}</span>
    </div>
    <div class="sc-times">
      <div class="sc-time-col">
        <div class="sc-time-label">PLANNED</div>
        <div class="sc-time-val">${s.dur_s ? fmtTime(s.dur_s) : '—'}</div>
      </div>
      <div class="sc-time-col real">
        <div class="sc-time-label">ACTUAL</div>
        <div class="sc-time-val" id="td-${s.id}">00:00:00</div>
      </div>
    </div>
    ${s.photo ? `<img class="sc-photo" src="${s.photo}" alt="stop photo" style="width:100%;border-radius:8px;margin-top:6px">` : ''}`;
  list.appendChild(card);
}

// ── Rec stop marker on map ─────────────────────────────────────────────────
function _updateRecStopMarker(idx) {
  const stops = State.get('rec.stops');
  const s = stops[idx];
  if (!s) return;
  const markers = State.get('rec.stopMarkers');
  const hasPhoto = !!(s.photo);
  const icon = /* build icon */ null; // simplified — map.js _makeStopIcon
  // We use a simple approach: just add a circle marker
  const map = MapModule.getMap();
  if (!map) return;
  const m = L.circleMarker([s.lat, s.lng], {
    radius: 8, color: '#f0a500', fillColor: hasPhoto ? '#3fb950' : '#f0a500',
    fillOpacity: 0.9, weight: 2,
  }).addTo(map).bindTooltip(`Stop ${idx + 1}${hasPhoto ? ' 📷' : ''}`);
  markers.push({ marker: m, idx });
}

// ── File handling ──────────────────────────────────────────────────────────
export async function handleFile(input) {
  const file = input.files[0];
  if (!file) return;

  if (file.name.toLowerCase().endsWith('.gpx')) {
    const xml  = await file.text();
    const data = parseGPX(xml, file.name);
    if (data.pts.length < 2) {
      UI.showAlert('error', 'GPX has no valid track'); return;
    }
    State.resetNav();
    MapModule.clearLayers();

    const cumDist = data.cumDist;
    State.merge('nav', {
      routePts:     data.pts,
      routeCumDist: cumDist,
      lastRouteIdx: 0,
      maneuvers:    buildManeuvers(data.pts),
      stops:        data.stops,
      totalDist:    data.dist,
      sourceFile:   data.name,
    });

    MapModule.loadRoute(data.pts, data.stops);

    const sl = document.getElementById('stops-list');
    if (sl) { sl.innerHTML = ''; data.stops.forEach(s => _renderStopCard(s)); }

    const planned = data.stops.reduce((a, s) => a + s.dur_s, 0);
    UI.updateTopbar({
      dist: data.dist, stops: `0/${data.stops.length}`,
      planned: planned ? fmtTime(planned) : '—', actual: '00:00:00',
      sourceFile: data.name,
    });
    document.getElementById('btn-nav')?.removeAttribute('disabled');
    UI.switchTab('route');
    UI.applySheet();
    Voice.speak(`Route loaded. ${data.pts.length} points, ${data.stops.length} stops.`);

  } else if (file.name.toLowerCase().endsWith('.json')) {
    const count = await importJSON(file);
    UI.showAlert('arrived', `Imported ${count} recording${count !== 1 ? 's' : ''}`);
    const recs  = await loadAllRecordings();
    State.set('savedRecs', recs);
    recs.forEach((r, i) => UI.renderRecCard(r, i, id => _loadRec(id), id => _deleteRec(id), id => _exportGPX(id)));
  }
  input.value = '';
}

// ── Camera + events ───────────────────────────────────────────────────────
export function toggleStopEvent(evt) {
  const events = State.get('rec.pendingEvents');
  const idx    = events.indexOf(evt);
  if (idx >= 0) events.splice(idx, 1); else events.push(evt);
  Recording.attachEvents(events);
  document.getElementById('evt-door')?.classList.toggle('active', events.includes('openDoor'));
  document.getElementById('evt-knee')?.classList.toggle('active', events.includes('kneeling'));
}

export function openCamera() {
  const input = document.getElementById('cam-input');
  input?.click();
}

export async function handleCameraFile(input) {
  const file = input.files[0];
  if (!file) return;
  try {
    const b64 = await Recording.compressPhoto(file, 800);
    Recording.attachPhoto(b64);
    UI.hideStopPrompt();
    Voice.speak('Photo saved');
  } catch (e) {
    UI.showAlert('error', 'Photo error: ' + e.message);
  }
  input.value = '';
}

export function confirmStop() {
  Recording.confirmStop();
  UI.hideStopPrompt();
}

// ── Delete / Export GPX ───────────────────────────────────────────────────
async function _deleteRec(idx) {
  const recs = State.get('savedRecs');
  const rec  = recs[idx];
  if (!rec || !confirm(`Delete "${rec.name}"?`)) return;
  await deleteRecording(rec.id);
  recs[idx] = null;
  UI.clearRecCard(idx);
}

function _exportGPX(idx) {
  const recs = State.get('savedRecs');
  const rec  = recs[idx];
  if (!rec) return;
  const xml  = Recording.buildGPX(rec);
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([xml], { type: 'application/gpx+xml' }));
  a.download = (rec.name || 'route').replace(/[^a-z0-9]/gi, '_') + '.gpx';
  a.click();
}

// ── Wake Lock ─────────────────────────────────────────────────────────────
async function _acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    const wl = await navigator.wakeLock.request('screen');
    wl.addEventListener('release', () => {
      if (document.visibilityState === 'visible' && State.get('mode') !== 'idle') {
        _acquireWakeLock();
      }
    });
    State.set('sensor.wakeLock', wl);
  } catch (e) { console.warn('[App] WakeLock:', e.message); }
}

async function _releaseWakeLock() {
  const wl = State.get('sensor.wakeLock');
  if (wl) { try { await wl.release(); } catch {} State.set('sensor.wakeLock', null); }
}

// ── Misc helpers ──────────────────────────────────────────────────────────
function _showEl(id, display) {
  const e = document.getElementById(id);
  if (e) e.style.display = display;
}

// ── Expose to HTML onclick handlers ───────────────────────────────────────
// (ES modules don't auto-export to global scope)
window.App = {
  startNav, stopNav, startRec: () => startRec(), stopRec: () => stopRec(),
  handleFile,
  openCamera, handleCameraFile, confirmStop, toggleStopEvent,
  exportAllJSON,
  toggleMapStyle: () => {
    const next = State.get('ui.mapTile') === 'day' ? 'night' : 'day';
    MapModule.setTile(next);
    const btn = document.getElementById('map-style-btn');
    if (btn) btn.textContent = next === 'day' ? '🌙' : '☀️';
  },
  toggleHudPanel:  () => { UI.toggleHudPanel(); UI.renderHudPanel(State.get('nav.stops')); },
  focusStop:       (id) => { const s = State.get('nav.stops').find(s => s.id === id); MapModule.focusStop(s); },
  switchTab:       (n) => UI.switchTab(n),
  toggleVoice:     () => Voice.setEnabled(!Voice.isEnabled()),
};

// ── Start ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
