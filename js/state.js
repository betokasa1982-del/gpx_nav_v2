/**
 * state.js — Central state. Single source of truth.
 * No module other than app.js should mutate state directly.
 * All reads go through State.get(), all writes through State.set().
 */

const _initialNav = () => ({
  routePts:      [],       // [{lat,lon}]
  routeCumDist:  [],       // km cumulative at each routePt
  lastRouteIdx:  0,        // windowed search anchor
  maneuvers:     [],       // [{idx,lat,lon,distFromStart,type,icon,label,cls}]
  stops:         [],       // [{id,name,lat,lng,dur_s,elapsed,running,state,photo,events}]
  insideStop:    new Set(),
  totalDist:     0,        // km
  currentPos:    null,     // {lat,lng}
  currentHeading:null,     // degrees 0-360
  currentSpeed:  null,     // km/h (smoothed)
  sourceFile:    '',       // filename loaded
});

const _initialRec = () => ({
  points:        [],       // [{lat,lng,t}]
  stops:         [],       // [{lat,lng,t,dur_s,startT,photo,events}]
  stopCandidate: null,     // {lat,lng,t,marked}
  stopMarkers:   [],       // Leaflet marker references [{marker,idx,entry}]
  pendingStopIdx:-1,
  pendingEvents: [],       // ['openDoor','kneeling']
});

const _initialSensor = () => ({
  lastGPSPos:    null,     // {lat,lng,t}
  speedBuffer:   [],       // last 5 speed readings for smoothing
  headingBuffer: [],       // last 4 heading readings
  wakeLock:      null,
  watchId:       null,
  gpsStatus:     'idle',   // 'idle'|'waiting'|'active'|'error'
  gpsMessage:    '',
});

const _initialUI = () => ({
  hudPanelOpen:  false,
  voiceOn:       true,
  lastVoiceKey:  '',
  mapTile:       'day',    // 'day'|'night'
  shState:       'mid',    // 'mid'|'expanded'|'hidden'
  activeTab:     'route',  // 'route'|'gps'|'stops'|'recs'
  photoAutoCloseTimer: null,
  photoPreviewStopId:  null,
});

// ── The actual state object ────────────────────────────────────────────────
const _state = {
  mode:      'idle',         // 'idle'|'nav'|'rec'
  nav:       _initialNav(),
  rec:       _initialRec(),
  sensor:    _initialSensor(),
  ui:        _initialUI(),
  savedRecs: [],             // loaded from IndexedDB on startup
  settings:  {               // user-configurable, persisted
    arrivalRadius:   80,
    autoStartTimer:  true,
    autoStopTimer:   true,
    followPosition:  true,
    zoomLevel:       17,
    recStopSpeed:    5,
    recStopMinDur:   5,
  },
};

// ── Public API ─────────────────────────────────────────────────────────────
export const State = {

  // Deep read by dot-path: State.get('nav.currentPos')
  get(path) {
    return path.split('.').reduce((o, k) => (o != null ? o[k] : undefined), _state);
  },

  // Shallow set by dot-path: State.set('ui.voiceOn', false)
  set(path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const obj  = keys.reduce((o, k) => o[k], _state);
    if (obj != null) obj[last] = value;
  },

  // Full sub-object replacement
  merge(path, patch) {
    const keys = path.split('.');
    const last = keys.pop();
    const obj  = keys.reduce((o, k) => o[k], _state);
    if (obj != null) obj[last] = { ...obj[last], ...patch };
  },

  // Reset navigation context completely (before loading a new route)
  resetNav() {
    _state.nav = _initialNav();
    _state.sensor.lastGPSPos    = null;
    _state.sensor.speedBuffer   = [];
    _state.sensor.headingBuffer = [];
  },

  // Reset recording context (before starting a new recording)
  resetRec() {
    _state.rec = _initialRec();
  },

  // Full snapshot (for debug / export)
  snapshot() {
    return JSON.parse(JSON.stringify({
      mode:     _state.mode,
      nav:      { ..._state.nav, insideStop: [..._state.nav.insideStop] },
      rec:      _state.rec,
      sensor:   _state.sensor,
      ui:       _state.ui,
      settings: _state.settings,
    }));
  },
};
