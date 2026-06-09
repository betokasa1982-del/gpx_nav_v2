/**
 * voice.js — Speech synthesis with queue, deduplication and fallback.
 * Never crashes when API is unavailable. Caller just calls Voice.speak().
 */

import { State } from './state.js';

const COOLDOWN_MS   = 10000;  // don't repeat same semantic key within 10s
const MAX_QUEUE     = 4;      // drop oldest if queue overflows

const _available = typeof window !== 'undefined' && 'speechSynthesis' in window;
let _queue   = [];
let _active  = false;
let _history = {};            // key → timestamp of last speak

export const Voice = {

  /** Speak a message. priority='high' cancels current + clears queue. */
  speak(text, priority = 'normal') {
    if (!_available) return;
    if (!State.get('ui.voiceOn')) return;
    if (!text) return;

    const key = _semanticKey(text);

    // Deduplication: skip if same key spoken recently
    if (_history[key] && Date.now() - _history[key] < COOLDOWN_MS) return;

    if (priority === 'high') {
      window.speechSynthesis.cancel();
      _queue = [];
      _active = false;
    }

    // Queue overflow protection
    if (_queue.length >= MAX_QUEUE) _queue.shift();
    _queue.push({ text, key });
    _flush();
  },

  /** Cancel everything currently speaking */
  cancel() {
    if (!_available) return;
    window.speechSynthesis.cancel();
    _queue  = [];
    _active = false;
  },

  setEnabled(on) {
    State.set('ui.voiceOn', on);
    if (!on) this.cancel();
  },

  isEnabled() {
    return State.get('ui.voiceOn');
  },

  isAvailable() {
    return _available;
  },

  /** Called by Navigation — announces maneuver at correct distance brackets */
  maybeSpeak(instruction, distM) {
    if (!instruction) return;
    const { type, label, dist } = instruction;

    // Stop arrival
    if (type === 'stop' && distM < 20) {
      this.speak(`${label}`, 'high');
      return;
    }

    // Distance brackets for turn instructions
    const key = `${label}_${Math.round(distM / 50) * 50}`;
    if (State.get('ui.lastVoiceKey') === key) return;

    if (distM <= 500 && distM > 180) {
      State.set('ui.lastVoiceKey', key);
      this.speak(`In ${Math.round(distM / 50) * 50} meters, ${label}`);
    } else if (distM <= 180 && distM > 40) {
      State.set('ui.lastVoiceKey', key);
      this.speak(`In ${Math.round(distM)} meters, ${label}`);
    } else if (distM <= 40 && distM > 0) {
      State.set('ui.lastVoiceKey', key + '_now');
      this.speak(`${label} now`, 'high');
    }
  },
};

// ── Internal ───────────────────────────────────────────────────────────────
function _flush() {
  if (_active || !_queue.length || !_available) return;
  const { text, key } = _queue.shift();

  _active = true;
  _history[key] = Date.now();

  const u  = new SpeechSynthesisUtterance(text);
  u.lang   = 'en-US';
  u.rate   = 1.05;
  u.volume = 1.0;

  u.onend   = () => { _active = false; _flush(); };
  u.onerror = () => { _active = false; _flush(); };

  // Chrome Android bug: synthesis can get stuck — watchdog
  const watchdog = setTimeout(() => {
    if (_active) { window.speechSynthesis.cancel(); _active = false; _flush(); }
  }, Math.max(5000, text.length * 80));
  u.onend = () => { clearTimeout(watchdog); _active = false; _flush(); };

  window.speechSynthesis.speak(u);
}

/** Normalize text to a stable deduplication key:
 *  - lowercase
 *  - numbers replaced with #
 *  - extra spaces removed
 */
function _semanticKey(text) {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}
