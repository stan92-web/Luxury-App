/* ══════════════════════════════════════════════
   sketch.js — Canvas drawing engine
   - Pointer Events API (palm rejection)
   - One active pointer per canvas (no accidental marks)
   - Auto-straighten: pen strokes snap to H/V/45° axes
   - Endpoint snap: lines join automatically when drawn near an endpoint
   - Full-screen sketch overlay
══════════════════════════════════════════════ */

const Sketch = (() => {
  const states  = {};
  const SNAP_R  = 20; // snap radius in canvas pixels

  /* ── Init ────────────────────────────────────── */
  function init(id) {
    const canvas = document.getElementById(`canvas-${id}`);
    if (!canvas) return;

    states[id] = {
      tool:            'pen',
      colour:          '#222222',
      lineWidth:       2.5,
      autoStraighten:  true,
      drawing:         false,
      activePointerId: null,
      pendingStart:    null,
      snapCandidate:   null,
      shapes:          [],
      history:         [],
      startX:          0,
      startY:          0,
      currentPath:     []
    };

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown',   e => { e.preventDefault(); onDown(id, e); });
    canvas.addEventListener('pointermove',   e => { e.preventDefault(); onMove(id, e); });
    canvas.addEventListener('pointerup',     e => { e.preventDefault(); onUp(id, e); });
    canvas.addEventListener('pointercancel', e => onCancel(id, e));

    resizeCanvas(id);
  }

  /* ── Canvas sizing ───────────────────────────── */
  function resizeCanvas(id) {
    const canvas = document.getElementById(`canvas-${id}`);
    const wrap   = document.getElementById(`canvas-wrap-${id}`);
    if (!canvas || !wrap) return;
    const w = wrap.clientWidth;
    const h = Math.round(w * 0.5);
    canvas.width        = w;
    canvas.height       = h;
    canvas.style.width  = w + 'px';
    canvas.style.height = h + 'px';
    redraw(id);
  }

  /* ── Coordinate helper ───────────────────────── */
  function getPos(canvas, e) {
    const rect = canvas.getBoundingClientRect();
    const sx   = canvas.width  / rect.width;
    const sy   = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }

  /* ── Endpoint snap helpers ───────────────────── */
  function getSnapPoints(shapes) {
    const pts = [];
    for (const sh of shapes) {
      if (sh.type === 'line') {
        pts.push({ x: sh.x1, y: sh.y1 }, { x: sh.x2, y: sh.y2 });
      } else if (sh.type === 'rect') {
        pts.push(
          { x: sh.x,        y: sh.y },
          { x: sh.x + sh.w, y: sh.y },
          { x: sh.x,        y: sh.y + sh.h },
          { x: sh.x + sh.w, y: sh.y + sh.h }
        );
      } else if (sh.type === 'pen' && sh.path.length) {
        pts.push(sh.path[0], sh.path[sh.path.length - 1]);
      }
    }
    return pts;
  }

  function findSnap(x, y, shapes) {
    let best = null, bestD = SNAP_R;
    for (const p of getSnapPoints(shapes)) {
      const d = Math.hypot(x - p.x, y - p.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best; // null if nothing within radius
  }

  /* ── Pointer events (palm rejection) ─────────── */
  function onDown(id, e) {
    const s      = states[id];
    const canvas = document.getElementById(`canvas-${id}`);
    if (!s || !canvas || s.activePointerId !== null) return;

    s.activePointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);

    let p = getPos(canvas, e);

    if (s.tool === 'text') {
      showTextInput(id, p.x, p.y);
      s.activePointerId = null;
      return;
    }

    // Snap start point to nearest existing endpoint
    const snap = findSnap(p.x, p.y, s.shapes);
    if (snap) p = snap;

    s.drawing      = true;
    s.startX       = p.x;
    s.startY       = p.y;
    s.pendingStart = { x: p.x, y: p.y };
    s.currentPath  = [];
    s.snapCandidate = null;
  }

  function onMove(id, e) {
    const s      = states[id];
    const canvas = document.getElementById(`canvas-${id}`);
    if (!s || !s.drawing || e.pointerId !== s.activePointerId) return;

    const p = getPos(canvas, e);

    if (s.pendingStart) {
      if (Math.hypot(p.x - s.pendingStart.x, p.y - s.pendingStart.y) < 8) return;
      s.currentPath  = [s.pendingStart, p];
      s.pendingStart = null;
    } else if (s.tool === 'pen') {
      s.currentPath.push(p);
    }

    // Find snap candidate for end point — used for preview and visual indicator
    const snap = findSnap(p.x, p.y, s.shapes);
    s.snapCandidate = snap;
    const px = snap ? snap.x : p.x;
    const py = snap ? snap.y : p.y;

    redraw(id, px, py);
  }

  function onUp(id, e) {
    const s      = states[id];
    const canvas = document.getElementById(`canvas-${id}`);
    if (!s || !s.drawing || e.pointerId !== s.activePointerId) return;

    const raw   = getPos(canvas, e);
    const snap  = findSnap(raw.x, raw.y, s.shapes);
    const ex    = snap ? snap.x : raw.x;
    const ey    = snap ? snap.y : raw.y;

    s.drawing         = false;
    s.activePointerId = null;
    s.pendingStart    = null;
    s.snapCandidate   = null;

    saveHistory(id);

    if (s.tool === 'pen' && s.currentPath.length > 1) {
      if (s.autoStraighten && isRoughlyLinear(s.currentPath)) {
        const a  = s.currentPath[0];
        // Endpoint snap takes priority over angle snap
        let x2, y2;
        if (snap) { x2 = snap.x; y2 = snap.y; }
        else      { const ep = snapEndpoint(a.x, a.y, raw.x, raw.y); x2 = ep.x; y2 = ep.y; }
        s.shapes.push({ type: 'line', x1: a.x, y1: a.y, x2, y2, colour: s.colour, lw: s.lineWidth });
      } else {
        s.shapes.push({ type: 'pen', path: s.currentPath.slice(), colour: s.colour, lw: s.lineWidth });
      }
      s.currentPath = [];

    } else if (s.tool === 'line') {
      s.shapes.push({ type: 'line', x1: s.startX, y1: s.startY, x2: ex, y2: ey, colour: s.colour, lw: s.lineWidth });

    } else if (s.tool === 'rect') {
      const w = ex - s.startX, h = ey - s.startY;
      if (Math.abs(w) > 4 || Math.abs(h) > 4)
        s.shapes.push({ type: 'rect', x: s.startX, y: s.startY, w, h, colour: s.colour, lw: s.lineWidth });
    }

    redraw(id);
    notifyChange();
  }

  function onCancel(id, e) {
    const s = states[id];
    if (!s || e.pointerId !== s.activePointerId) return;
    s.drawing         = false;
    s.activePointerId = null;
    s.pendingStart    = null;
    s.snapCandidate   = null;
    s.currentPath     = [];
    redraw(id);
  }

  /* ── Auto-straighten helpers ─────────────────── */
  function isRoughlyLinear(path) {
    if (path.length < 3) return true;
    const a   = path[0], b = path[path.length - 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 25) return false;
    let maxDev = 0;
    for (let i = 1; i < path.length - 1; i++)
      maxDev = Math.max(maxDev, ptLineDist(path[i], a, b));
    return maxDev < Math.max(18, len * 0.15);
  }

  function ptLineDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    return len === 0
      ? Math.hypot(p.x - a.x, p.y - a.y)
      : Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy) / len;
  }

  // Snap end-point to nearest H/V/45° axis.
  // H and V each own a 60° zone; 45° diagonals own 30° zones.
  function snapEndpoint(x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len === 0) return { x: x2, y: y2 };
    let ang = Math.atan2(dy, dx) * 180 / Math.PI;
    if (ang < 0) ang += 360;
    let snapped;
    if      (ang <  30 || ang >= 330) snapped = 0;
    else if (ang <  60)               snapped = 45;
    else if (ang < 120)               snapped = 90;
    else if (ang < 150)               snapped = 135;
    else if (ang < 210)               snapped = 180;
    else if (ang < 240)               snapped = 225;
    else if (ang < 300)               snapped = 270;
    else                              snapped = 315;
    const rad = snapped * Math.PI / 180;
    return { x: x1 + Math.cos(rad) * len, y: y1 + Math.sin(rad) * len };
  }

  /* ── Text input overlay ──────────────────────── */
  function showTextInput(id, x, y) {
    const wrap = document.getElementById(`canvas-wrap-${id}`);
    if (!wrap) return;
    const inp       = document.createElement('input');
    inp.type        = 'text';
    inp.placeholder = 'Label / dimension…';
    inp.style.cssText = `
      position:absolute; left:${x}px; top:${Math.max(0, y - 14)}px;
      background:rgba(255,255,255,0.97); color:#111;
      border:1.5px solid #c0392b; border-radius:4px;
      font-size:14px; padding:4px 8px; z-index:10;
      min-width:90px; max-width:200px; font-family:Arial,sans-serif;
    `;
    wrap.appendChild(inp);
    inp.focus();
    function commit() {
      const text = inp.value.trim();
      inp.remove();
      if (!text) return;
      saveHistory(id);
      const s = states[id];
      s.shapes.push({ type: 'text', x, y, text, colour: s.colour, size: 13 });
      redraw(id);
      notifyChange();
    }
    inp.addEventListener('blur',    commit);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') inp.remove(); });
  }

  /* ── Redraw ──────────────────────────────────── */
  function redraw(id, previewX, previewY) {
    const canvas = document.getElementById(`canvas-${id}`);
    if (!canvas) return;
    const s   = states[id];
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!s) return;

    s.shapes.forEach(sh => renderShape(ctx, sh));

    if (s.tool === 'pen' && s.currentPath.length > 1)
      drawPenPath(ctx, s.currentPath, s.colour, s.lineWidth);

    if (s.drawing && previewX !== undefined) {
      ctx.strokeStyle = s.colour;
      ctx.lineWidth   = s.lineWidth;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      if (s.tool === 'line') {
        ctx.beginPath(); ctx.moveTo(s.startX, s.startY); ctx.lineTo(previewX, previewY); ctx.stroke();
      } else if (s.tool === 'rect') {
        ctx.beginPath(); ctx.strokeRect(s.startX, s.startY, previewX - s.startX, previewY - s.startY);
      }
    }

    // Snap indicator — blue ring at snap target
    if (s.snapCandidate) drawSnapIndicator(ctx, s.snapCandidate);
  }

  function drawSnapIndicator(ctx, p) {
    ctx.save();
    ctx.strokeStyle = '#1a6eb5';
    ctx.fillStyle   = '#1a6eb5';
    ctx.lineWidth   = 2;
    ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function renderShape(ctx, sh) {
    ctx.strokeStyle = sh.colour;
    ctx.fillStyle   = sh.colour;
    ctx.lineWidth   = sh.lw || 2.5;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    if      (sh.type === 'pen')  drawPenPath(ctx, sh.path, sh.colour, sh.lw);
    else if (sh.type === 'line') { ctx.beginPath(); ctx.moveTo(sh.x1, sh.y1); ctx.lineTo(sh.x2, sh.y2); ctx.stroke(); }
    else if (sh.type === 'rect') { ctx.beginPath(); ctx.strokeRect(sh.x, sh.y, sh.w, sh.h); }
    else if (sh.type === 'text') { ctx.font = `${sh.size || 13}px Arial`; ctx.fillText(sh.text, sh.x, sh.y); }
  }

  function drawPenPath(ctx, path, colour, lw) {
    if (path.length < 2) return;
    ctx.strokeStyle = colour;
    ctx.lineWidth   = lw || 2.5;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
    ctx.stroke();
  }

  /* ── History ─────────────────────────────────── */
  function saveHistory(id) {
    const s = states[id];
    if (!s) return;
    s.history.push(JSON.stringify(s.shapes));
    if (s.history.length > 50) s.history.shift();
  }

  /* ── Public controls ─────────────────────────── */
  function undo(id) {
    const s = states[id];
    if (!s || !s.history.length) return;
    s.shapes = JSON.parse(s.history.pop());
    redraw(id);
    notifyChange();
  }

  function clear(id) {
    const s = states[id];
    if (!s) return;
    saveHistory(id);
    s.shapes = [];
    redraw(id);
    notifyChange();
  }

  function setTool(id, tool) {
    const s = states[id];
    if (s) s.tool = tool;
    ['pen','line','rect','text'].forEach(t => {
      const btn = document.getElementById(`tool-${t}-${id}`);
      if (btn) btn.classList.toggle('active', t === tool);
    });
  }

  function setColour(id, colour, el) {
    const s = states[id];
    if (s) s.colour = colour;
    const parent = document.getElementById(`colours-${id}`);
    if (parent) parent.querySelectorAll('.colour-dot').forEach(d => d.classList.remove('active'));
    if (el) el.classList.add('active');
  }

  function toggleStraighten(id, btn) {
    const s = states[id];
    if (!s) return;
    s.autoStraighten = !s.autoStraighten;
    if (btn) btn.classList.toggle('active', s.autoStraighten);
  }

  /* ── Data access ─────────────────────────────── */
  function getShapes(id) { return states[id] ? states[id].shapes : []; }

  function setShapes(id, shapes) {
    const s = states[id];
    if (!s) return;
    s.shapes = Array.isArray(shapes) ? shapes : [];
    redraw(id);
  }

  /* ── Notify survey module ────────────────────── */
  function notifyChange() {
    if (typeof window.onSketchUpdated === 'function') window.onSketchUpdated();
  }

  /* ══════════════════════════════════════════════
     FULL-SCREEN SKETCH
  ══════════════════════════════════════════════ */
  const fs = {
    roomId:          null,
    tool:            'pen',
    colour:          '#222222',
    lineWidth:       3,
    autoStraighten:  true,
    drawing:         false,
    activePointerId: null,
    pendingStart:    null,
    snapCandidate:   null,
    shapes:          [],
    history:         [],
    startX:          0,
    startY:          0,
    currentPath:     []
  };

  function openFullscreen(roomId) {
    const s = states[roomId];
    if (!s) return;

    fs.roomId          = roomId;
    fs.tool            = s.tool;
    fs.colour          = s.colour;
    fs.autoStraighten  = s.autoStraighten;
    fs.lineWidth       = 3;
    fs.drawing         = false;
    fs.activePointerId = null;
    fs.pendingStart    = null;
    fs.snapCandidate   = null;
    fs.history         = [];
    fs.currentPath     = [];

    document.getElementById('fs-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';

    const area   = document.getElementById('fs-canvas-area');
    const canvas = document.getElementById('fs-canvas');
    canvas.width        = area.clientWidth;
    canvas.height       = area.clientHeight;
    canvas.style.width  = canvas.width  + 'px';
    canvas.style.height = canvas.height + 'px';

    const roomCanvas = document.getElementById(`canvas-${roomId}`);
    const sx = canvas.width  / roomCanvas.width;
    const sy = canvas.height / roomCanvas.height;
    fs.shapes = scaleShapes(s.shapes, sx, sy);

    fsUpdateToolbar();
    fsRedraw();
  }

  function closeFullscreen() {
    if (fs.roomId === null) return;

    const s          = states[fs.roomId];
    const roomCanvas = document.getElementById(`canvas-${fs.roomId}`);
    const fsCanvas   = document.getElementById('fs-canvas');

    const sx = roomCanvas.width  / fsCanvas.width;
    const sy = roomCanvas.height / fsCanvas.height;

    saveHistory(fs.roomId);
    s.shapes         = scaleShapes(fs.shapes, sx, sy);
    s.autoStraighten = fs.autoStraighten;
    redraw(fs.roomId);

    document.getElementById('fs-overlay').classList.remove('open');
    document.body.style.overflow = '';

    fs.roomId = null;
    notifyChange();
  }

  function scaleShapes(shapes, sx, sy) {
    return shapes.map(sh => {
      if (sh.type === 'pen')  return { ...sh, path: sh.path.map(p => ({ x: p.x*sx, y: p.y*sy })) };
      if (sh.type === 'line') return { ...sh, x1: sh.x1*sx, y1: sh.y1*sy, x2: sh.x2*sx, y2: sh.y2*sy };
      if (sh.type === 'rect') return { ...sh, x: sh.x*sx, y: sh.y*sy, w: sh.w*sx, h: sh.h*sy };
      if (sh.type === 'text') return { ...sh, x: sh.x*sx, y: sh.y*sy };
      return sh;
    });
  }

  /* ── FS pointer events ───────────────────────── */
  function initFsCanvas() {
    const canvas = document.getElementById('fs-canvas');
    if (!canvas) return;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown',   e => { e.preventDefault(); fsDown(e); });
    canvas.addEventListener('pointermove',   e => { e.preventDefault(); fsMove(e); });
    canvas.addEventListener('pointerup',     e => { e.preventDefault(); fsUp(e); });
    canvas.addEventListener('pointercancel', e => fsCancelDraw(e));
  }

  function fsGetPos(e) {
    const canvas = document.getElementById('fs-canvas');
    const rect   = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function fsDown(e) {
    if (fs.activePointerId !== null) return;
    const canvas = document.getElementById('fs-canvas');
    fs.activePointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);

    let p = fsGetPos(e);
    if (fs.tool === 'text') { fsShowTextInput(p.x, p.y); fs.activePointerId = null; return; }

    // Snap start point
    const snap = findSnap(p.x, p.y, fs.shapes);
    if (snap) p = snap;

    fs.drawing      = true;
    fs.startX       = p.x;
    fs.startY       = p.y;
    fs.pendingStart = { x: p.x, y: p.y };
    fs.currentPath  = [];
    fs.snapCandidate = null;
  }

  function fsMove(e) {
    if (!fs.drawing || e.pointerId !== fs.activePointerId) return;
    const p = fsGetPos(e);
    if (fs.pendingStart) {
      if (Math.hypot(p.x - fs.pendingStart.x, p.y - fs.pendingStart.y) < 8) return;
      fs.currentPath  = [fs.pendingStart, p];
      fs.pendingStart = null;
    } else if (fs.tool === 'pen') {
      fs.currentPath.push(p);
    }
    const snap = findSnap(p.x, p.y, fs.shapes);
    fs.snapCandidate = snap;
    fsRedraw(snap ? snap.x : p.x, snap ? snap.y : p.y);
  }

  function fsUp(e) {
    if (!fs.drawing || e.pointerId !== fs.activePointerId) return;
    const raw  = fsGetPos(e);
    const snap = findSnap(raw.x, raw.y, fs.shapes);
    const ex   = snap ? snap.x : raw.x;
    const ey   = snap ? snap.y : raw.y;

    fs.drawing         = false;
    fs.activePointerId = null;
    fs.pendingStart    = null;
    fs.snapCandidate   = null;

    fsSaveHistory();

    if (fs.tool === 'pen' && fs.currentPath.length > 1) {
      if (fs.autoStraighten && isRoughlyLinear(fs.currentPath)) {
        const a = fs.currentPath[0];
        let x2, y2;
        if (snap) { x2 = snap.x; y2 = snap.y; }
        else      { const ep = snapEndpoint(a.x, a.y, raw.x, raw.y); x2 = ep.x; y2 = ep.y; }
        fs.shapes.push({ type: 'line', x1: a.x, y1: a.y, x2, y2, colour: fs.colour, lw: fs.lineWidth });
      } else {
        fs.shapes.push({ type: 'pen', path: fs.currentPath.slice(), colour: fs.colour, lw: fs.lineWidth });
      }
      fs.currentPath = [];
    } else if (fs.tool === 'line') {
      fs.shapes.push({ type: 'line', x1: fs.startX, y1: fs.startY, x2: ex, y2: ey, colour: fs.colour, lw: fs.lineWidth });
    } else if (fs.tool === 'rect') {
      const w = ex - fs.startX, h = ey - fs.startY;
      if (Math.abs(w) > 4 || Math.abs(h) > 4)
        fs.shapes.push({ type: 'rect', x: fs.startX, y: fs.startY, w, h, colour: fs.colour, lw: fs.lineWidth });
    }
    fsRedraw();
  }

  function fsCancelDraw(e) {
    if (e.pointerId !== fs.activePointerId) return;
    fs.drawing         = false;
    fs.activePointerId = null;
    fs.pendingStart    = null;
    fs.snapCandidate   = null;
    fs.currentPath     = [];
    fsRedraw();
  }

  function fsShowTextInput(x, y) {
    const area = document.getElementById('fs-canvas-area');
    const inp  = document.createElement('input');
    inp.type   = 'text';
    inp.placeholder = 'Label / dimension…';
    inp.style.cssText = `
      position:absolute; left:${x}px; top:${Math.max(0, y - 16)}px;
      background:rgba(255,255,255,0.97); color:#111;
      border:2px solid #c0392b; border-radius:5px;
      font-size:16px; padding:5px 10px; z-index:10;
      min-width:100px; max-width:240px; font-family:Arial,sans-serif;
    `;
    area.appendChild(inp);
    inp.focus();
    function commit() {
      const text = inp.value.trim();
      inp.remove();
      if (!text) return;
      fsSaveHistory();
      fs.shapes.push({ type: 'text', x, y, text, colour: fs.colour, size: 16 });
      fsRedraw();
    }
    inp.addEventListener('blur',    commit);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') inp.remove(); });
  }

  function fsRedraw(previewX, previewY) {
    const canvas = document.getElementById('fs-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    fs.shapes.forEach(sh => renderShape(ctx, sh));
    if (fs.tool === 'pen' && fs.currentPath.length > 1)
      drawPenPath(ctx, fs.currentPath, fs.colour, fs.lineWidth);

    if (fs.drawing && previewX !== undefined) {
      ctx.strokeStyle = fs.colour;
      ctx.lineWidth   = fs.lineWidth;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      if (fs.tool === 'line') {
        ctx.beginPath(); ctx.moveTo(fs.startX, fs.startY); ctx.lineTo(previewX, previewY); ctx.stroke();
      } else if (fs.tool === 'rect') {
        ctx.beginPath(); ctx.strokeRect(fs.startX, fs.startY, previewX - fs.startX, previewY - fs.startY);
      }
    }

    if (fs.snapCandidate) drawSnapIndicator(ctx, fs.snapCandidate);
  }

  function fsSaveHistory() {
    fs.history.push(JSON.stringify(fs.shapes));
    if (fs.history.length > 50) fs.history.shift();
  }

  function fsSetTool(tool) {
    fs.tool = tool;
    ['pen','line','rect','text'].forEach(t => {
      const btn = document.getElementById(`fs-tool-${t}`);
      if (btn) btn.classList.toggle('active', t === tool);
    });
  }

  function fsSetColour(colour, el) {
    fs.colour = colour;
    document.querySelectorAll('#fs-colours .colour-dot').forEach(d => d.classList.remove('active'));
    if (el) el.classList.add('active');
  }

  function fsUndo()  { if (!fs.history.length) return; fs.shapes = JSON.parse(fs.history.pop()); fsRedraw(); }
  function fsClear() { fsSaveHistory(); fs.shapes = []; fsRedraw(); }

  function fsToggleStraighten(btn) {
    fs.autoStraighten = !fs.autoStraighten;
    if (btn) btn.classList.toggle('active', fs.autoStraighten);
  }

  function fsUpdateToolbar() {
    fsSetTool(fs.tool);
    fsSetColour(fs.colour);
    const btn = document.getElementById('fs-straighten');
    if (btn) btn.classList.toggle('active', fs.autoStraighten);
  }

  document.addEventListener('DOMContentLoaded', initFsCanvas);

  return {
    init, resizeCanvas, redraw, setTool, setColour, toggleStraighten, undo, clear, getShapes, setShapes,
    openFullscreen, closeFullscreen,
    fsSetTool, fsSetColour, fsUndo, fsClear, fsToggleStraighten
  };
})();
