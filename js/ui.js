/**
 * ui.js — All DOM access, rendering and visual feedback.
 * No business logic. Receives data, updates DOM.
 */

import { State } from './state.js';
import { fmtTime, fmtDist } from './gps.js';

// ── Cached element getter ──────────────────────────────────────────────────
const _cache = {};
function el(id) {
  if (!_cache[id]) _cache[id] = document.getElementById(id);
  return _cache[id];
}
function setText(id, v)  { const e = el(id); if (e) e.textContent   = v; }
function setDisp(id, v)  { const e = el(id); if (e) e.style.display = v; }

// ── Photo overlay auto-close timer ────────────────────────────────────────
let _photoCloseTimer = null;

// ── Public API ─────────────────────────────────────────────────────────────
export const UI = {

  // ── Init ─────────────────────────────────────────────────────────────
  init() {
    // Sheet drag-to-dismiss
    let y0 = 0;
    const sheet = el('sheet');
    if (sheet) {
      sheet.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; }, { passive: true });
      sheet.addEventListener('touchmove',  e => {
        const dy = e.touches[0].clientY - y0;
        if (dy > 60)       { State.set('ui.shState', 'mid');      this.applySheet(); }
        else if (dy < -60) { State.set('ui.shState', 'expanded'); this.applySheet(); }
      }, { passive: true });
    }
  },

  // ── Topbar stats ──────────────────────────────────────────────────────
  updateTopbar(navStats) {
    const { dist, stops, planned, actual, sourceFile } = navStats || {};
    setText('h-dist',   dist    != null ? (dist >= 1 ? dist.toFixed(1) + ' km' : (dist * 1000).toFixed(0) + ' m') : '—');
    setText('h-stops',  stops   ?? '0/0');
    setText('h-prog',   planned ?? '—');
    setText('h-real',   actual  ?? '00:00:00');
    setText('h-file',   sourceFile || '');
  },

  // ── Summary bar ───────────────────────────────────────────────────────
  updateSummaryBar(stops) {
    const n     = stops.length;
    const done  = stops.filter(s => s.state === 'done').length;
    const prog  = stops.reduce((a, s) => a + (s.dur_s  || 0), 0);
    const real  = stops.reduce((a, s) => a + (s.elapsed || 0), 0);
    const delta = real - prog;
    const pct   = prog ? Math.min((real / prog) * 100, 100) : 0;

    setText('sb-done',  `${done}/${n}`);
    setText('sb-prog',  prog ? fmtTime(prog) : '—');
    setText('sb-rlbl',  `Actual: ${fmtTime(real)}`);
    const fill = el('sb-fill');
    if (fill) {
      fill.style.width      = pct + '%';
      fill.style.background = pct < 90 ? 'var(--green)' : pct < 100 ? 'var(--accent)' : 'var(--red)';
    }
    if (prog && real > 0) {
      const dv = el('sb-delta'), lv = el('sb-dlbl');
      if (dv) {
        dv.className   = `sb-val ${delta <= 0 ? 'ok' : delta < 120 ? 'warn' : 'over'}`;
        dv.textContent = delta <= 0 ? `−${fmtTime(-delta)}` : `+${fmtTime(delta)}`;
      }
      if (lv) {
        lv.textContent   = delta <= 0 ? 'ahead' : 'delay';
        lv.style.color   = delta <= 0 ? 'var(--green)' : delta < 120 ? 'var(--accent)' : 'var(--red)';
      }
    }
  },

  // ── HUD instruction bar ───────────────────────────────────────────────
  updateHUD(instruction, speedKmh, gpsStatus) {
    if (!instruction) return;
    const { dist, icon, label, detail, cls } = instruction;

    // Icon
    const iconEl = el('hud-icon');
    if (iconEl) iconEl.textContent = icon || '—';
    const lblEl = el('hud-icon-lbl');
    if (lblEl) lblEl.textContent = cls?.toUpperCase() || '';

    // Distance
    const distEl = el('hud-dist');
    if (distEl) {
      distEl.textContent = dist != null ? fmtDist(dist) : '—';
      distEl.className   = `hud-instr-dist ${dist < 50 ? 'close' : dist < 200 ? 'medium' : 'far'}`;
    }

    // Action label
    setText('hud-action', label || '');
    setText('hud-detail', detail || '');

    // Speed
    setText('hud-spd', speedKmh != null ? Math.round(speedKmh) : '—');

    // GPS status dot
    this.setGPSStatus(gpsStatus?.status, gpsStatus?.msg);
  },

  // ── HUD stops panel (compact rows, current+next only) ────────────────
  renderHudPanel(stops) {
    const c = el('hud-sp-list');
    if (!c) return;
    c.innerHTML = '';

    const current = stops.find(s => s.state === 'current');
    const next    = stops.find(s => s.state === 'waiting');
    const toShow  = [current, next].filter(Boolean);
    const total   = stops.length;
    const done    = stops.filter(s => s.state === 'done').length;

    const hdr = document.createElement('div');
    hdr.className   = 'hud-sp-header';
    hdr.textContent = `Stop ${done + 1} of ${total} · ${done} done`;
    c.appendChild(hdr);

    toShow.forEach(s => {
      const row      = document.createElement('div');
      row.className  = `hud-stop-row ${s.state}`;
      const delta    = s.elapsed - (s.dur_s || 0);
      const timerTxt = s.elapsed > 0 || s.state === 'current' ? fmtTime(s.elapsed) : '—';
      const planned  = s.dur_s ? `/${fmtTime(s.dur_s)}` : '';
      const timerCls = s.running ? 'running' : (delta > 0 && s.elapsed > 0 ? 'over' : '');
      const badges   = (s.events || []).map(e =>
        `<span class="stop-event-badge">${e === 'openDoor' ? '🚪' : e === 'kneeling' ? '♿' : ''}</span>`
      ).join('');

      row.innerHTML = `
        <div class="hud-sr-num ${s.state}">${s.state === 'done' ? '✓' : s.id}</div>
        <div class="hud-sr-name">${s.name}${badges}</div>
        <div class="hud-sr-timer ${timerCls}">${timerTxt}${s.state === 'current' ? planned : ''}</div>
        ${s.state === 'current'
          ? `<button class="hud-sr-done-btn" data-stopid="${s.id}">✓ Next</button>`
          : ''}`;
      c.appendChild(row);
    });

    // Delegate Done button clicks
    c.querySelectorAll('.hud-sr-done-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = +btn.dataset.stopid;
        if (this.onStopDone) this.onStopDone(id);
      });
    });
  },

  toggleHudPanel() {
    const open  = !State.get('ui.hudPanelOpen');
    const panel = el('hud-stops-panel');
    const btn   = el('hud-toggle');
    State.set('ui.hudPanelOpen', open);
    panel?.classList.toggle('on', open);
    if (btn) btn.textContent = open ? '✕ Close' : '📍 Stops';
  },

  // ── Recording indicator ───────────────────────────────────────────────
  updateRecIndicator(status, val1, val2) {
    const bar = el('rec-indicator');
    if (!bar) return;

    switch (status) {
      case 'idle':
        bar.style.display = 'none';
        break;
      case 'moving':
        bar.style.display = '';
        setText('rec-sc', `${val1} stop${val1 !== 1 ? 's' : ''} detected${val2 ? ` · ${val2} with photo` : ''}`);
        break;
      case 'slowing':
        bar.style.display = '';
        setText('rec-sc', '🔴 Slowing down…');
        break;
      case 'stopped':
        bar.style.display = '';
        setText('rec-sc', `🔴 Stopped: ${val1}s / ${val2}s (${Math.max(0, val2 - val1)}s to register)`);
        break;
    }
  },

  // ── Stop prompt (shown during recording when stop detected) ──────────
  showStopPrompt(stopNum) {
    setText('cam-stop-num', stopNum);
    // Reset event buttons
    const de = el('evt-door'), ke = el('evt-knee');
    if (de) de.classList.remove('active');
    if (ke) ke.classList.remove('active');
    el('cam-prompt')?.classList.add('on');
  },

  hideStopPrompt() {
    el('cam-prompt')?.classList.remove('on');
  },

  // ── Photo corner overlay ──────────────────────────────────────────────
  showPhotoOverlay(stop, distM) {
    if (!stop?.photo) return;
    const ov = el('stop-photo-ov');
    if (!ov) return;
    setText('spo-name', stop.name || `Stop ${stop.id}`);
    setText('spo-badge', distM < 20 ? 'At stop' : `${Math.round(distM)} m ahead`);
    const img = el('spo-img');
    if (img) { img.src = stop.photo; img.style.display = 'block'; }
    ov.classList.add('on');
    State.set('ui.photoPreviewStopId', stop.id);

    clearTimeout(_photoCloseTimer);
    _photoCloseTimer = setTimeout(() => this.hidePhotoOverlay(), 12000);
  },

  hidePhotoOverlay() {
    clearTimeout(_photoCloseTimer);
    el('stop-photo-ov')?.classList.remove('on');
    State.set('ui.photoPreviewStopId', null);
  },

  // ── Arrival alerts ────────────────────────────────────────────────────
  showAlert(type, msg) {
    const ov = el('alert-ov');
    if (!ov) return;
    ov.className    = `alert-ov ${type}`;
    setText('alert-msg', msg);
    ov.style.display = '';
    clearTimeout(ov._t);
    ov._t = setTimeout(() => { ov.style.display = 'none'; }, 3500);
  },

  // ── GPS status dot ────────────────────────────────────────────────────
  setGPSStatus(status, msg) {
    const dot = el('gps-dot');
    if (dot) {
      dot.className = `gps-dot ${status || 'idle'}`;
      dot.title     = msg || '';
    }
    setText('gps-msg', msg || '');
  },

  // ── Recordings list ───────────────────────────────────────────────────
  renderRecCard(rec, idx, onLoad, onDelete, onExport) {
    const list = el('rec-list');
    if (!list) return;
    const old = el(`rcard-${idx}`);
    if (old) old.remove();

    const stopsInfo = rec.stops?.length
      ? `· ${rec.stops.length} stop${rec.stops.length > 1 ? 's' : ''}`
      : '· no stops';
    const date  = rec.date ? new Date(rec.date).toLocaleDateString('en-GB') : '';
    const dist  = (rec.dist ?? 0).toFixed(2);

    const card  = document.createElement('div');
    card.className = 'rec-card';
    card.id        = `rcard-${idx}`;
    card.innerHTML = `
      <div class="rec-card-icon">🛤️</div>
      <div class="rec-card-info">
        <div class="rec-card-name">${rec.name || 'Route'}</div>
        <div class="rec-card-meta">${date} · ${dist} km ${stopsInfo}</div>
      </div>
      <div class="rec-card-actions">
        <button class="btn go"  data-action="load">📂 Load</button>
        <button class="btn"     data-action="gpx" >↓ GPX</button>
        <button class="btn red" data-action="del" >✕</button>
      </div>`;

    card.querySelector('[data-action=load]').addEventListener('click', () => onLoad(idx));
    card.querySelector('[data-action=gpx]' ).addEventListener('click', () => onExport(idx));
    card.querySelector('[data-action=del]' ).addEventListener('click', () => onDelete(idx));

    list.insertBefore(card, list.firstChild);
    setText('rec-badge', ` (${list.querySelectorAll('.rec-card').length})`);
    setDisp('rec-empty', 'none');
  },

  clearRecCard(idx) {
    el(`rcard-${idx}`)?.remove();
  },

  // ── Bottom sheet ──────────────────────────────────────────────────────
  switchTab(name) {
    ['route', 'gps', 'stops', 'recs'].forEach(t => {
      el(`tab-${t}`)  ?.classList.toggle('active', t === name);
      el(`pane-${t}`) ?.classList.toggle('on',     t === name);
    });
    State.set('ui.activeTab', name);
    if (State.get('ui.shState') !== 'expanded') {
      State.set('ui.shState', 'expanded');
      this.applySheet();
    }
  },

  applySheet() {
    const sh    = el('sheet');
    const map   = el('map-wrap');
    const state = State.get('ui.shState');
    if (!sh) return;

    const configs = {
      hidden:   { sheetTop: '100vh',  mapBot: '56px' },
      mid:      { sheetTop: '60vh',   mapBot: '40vh' },
      expanded: { sheetTop: '30vh',   mapBot: '70vh' },
    };
    const cfg = configs[state] || configs.mid;
    sh.style.top          = cfg.sheetTop;
    sh.style.height       = '100vh';
    if (map) map.style.bottom = cfg.mapBot;
  },

  // ── Callbacks (set by app.js) ─────────────────────────────────────────
  onStopDone: null,  // (stopId: number) => void
};
