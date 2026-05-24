/* ══════════════════════════════════════════════
   sketch.js — Canvas drawing engine
   - Pointer Events API (palm rejection)
   - One active pointer per canvas (no accidental marks)
   - Auto-straighten: pen strokes snap to H/V/45° axes
   - Endpoint snap: lines join automatically when drawn near an endpoint
   - Rect corner-drag resize + line endpoint drag
   - Select any rect or line, then ✕ Del to remove
   - Full-screen sketch overlay

   TABLE OF CONTENTS — grep the LABEL to jump straight there
   ──────────────────────────────────────────────
   SKETCH:CONSTANTS   SNAP_R, HANDLE_R, HANDLE_HIT, EDGE_HIT
   SKETCH:INIT        init(), resizeCanvas()
   SKETCH:COORDS      getPos()
   SKETCH:SNAP        getSnapPoints(), findSnap() — endpoint snap
   SKETCH:SELECTION   hitShapeHandle(), hitShapeBody(), getCornerHandles(), resizePivotFor()
   SKETCH:DISTANCE    distToSeg()
   SKETCH:POINTER     onDown(), onMove(), onUp(), onCancel() — per-canvas pointer events
   SKETCH:STRAIGHTEN  isRoughlyLinear(), ptLineDist(), snapEndpoint()
   SKETCH:TEXTINPUT   showTextInput() overlay
   SKETCH:HANDLES     drawSelectionHandles()
   SKETCH:REDRAW      redraw(), drawSnapIndicator(), renderShape(), drawPenPath()
   SKETCH:HISTORY     saveHistory()
   SKETCH:CONTROLS    undo(), redrawScaled(), clear(), deleteSelected(), setTool(), setColour(), toggleStraighten()
   SKETCH:DATA        getShapes(), setShapes()
   SKETCH:TEMPLATES   buildTemplate() 4-door, insertTemplate(), fsTpl()
   SKETCH:NOTIFY      notifyChange()
   SKETCH:FULLSCREEN  fs state, openFullscreen(), closeFullscreen(), scaleShapes()
   SKETCH:FSPOINTER   initFsCanvas(), fsGetPos(), fsDown(), fsMove(), fsUp(), fsCancelDraw()
   SKETCH:FSTEXT      fsShowTextInput()
   SKETCH:FSREDRAW    fsRedraw(), fsSaveHistory()
   SKETCH:FSCONTROLS  fsDeleteSelected(), fsSetTool(), fsSetColour(), fsUndo(), fsClear(), fsToggleStraighten(), fsUpdateToolbar()
   SKETCH:BOOT        DOMContentLoaded → initFsCanvas
   SKETCH:EXPORTS     return { ... }
══════════════════════════════════════════════ */

const Sketch = (() => {
  const states  = {};
  /* SKETCH:CONSTANTS */
  const SNAP_R     = 20;
  const HANDLE_R   = 8;   // visual radius of handles
  const HANDLE_HIT = 28;  // hit detection radius (touch-friendly)
  const EDGE_HIT   = 16;  // proximity for line/rect edge selection

  /* SKETCH:INIT ─────────────────────────────────── */
  function init(id) {
    const canvas = document.getElementById(`canvas-${id}`);
    if (!canvas) return;
    if (states[id]) return; // already initialised — don't double-bind events

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
      currentPath:     [],
      selectedIdx:     -1,
      resizeHandle:    null,
      resizePivot:     null,
      moving:          false,
      moveShapeStart:  null
    };

    canvas.style.touchAction = 'none';
    canvas.addEventListener('touchstart',    e => e.preventDefault(), { passive: false });
    canvas.addEventListener('touchmove',     e => e.preventDefault(), { passive: false });
    canvas.addEventListener('pointerdown',   e => { e.preventDefault(); onDown(id, e); });
    canvas.addEventListener('pointermove',   e => { e.preventDefault(); onMove(id, e); });
    canvas.addEventListener('pointerup',     e => { e.preventDefault(); onUp(id, e); });
    canvas.addEventListener('pointercancel', e => onCancel(id, e));

    // PC fallback: if setPointerCapture fails, pointerup outside the canvas
    // won't fire on the canvas — this window listener rescues that case so the
    // drawing state never gets permanently stuck.
    window.addEventListener('pointerup', e => {
      const s = states[id];
      if (s && s.drawing && e.pointerId === s.activePointerId) onUp(id, e);
    });

    resizeCanvas(id);
  }

  /* ── Canvas sizing ───────────────────────────── */
  function resizeCanvas(id) {
    const canvas = document.getElementById(`canvas-${id}`);
    const wrap   = document.getElementById(`canvas-wrap-${id}`);
    if (!canvas || !wrap) return;
    if (states[id]) states[id].selectedIdx = -1;
    const w = wrap.clientWidth;
    const h = Math.round(w * 0.7);
    canvas.width        = w;
    canvas.height       = h;
    canvas.style.width  = w + 'px';
    canvas.style.height = h + 'px';
    redraw(id);
  }

  /* SKETCH:COORDS ───────────────────────────────── */
  function getPos(canvas, e) {
    const rect = canvas.getBoundingClientRect();
    const sx   = canvas.width  / rect.width;
    const sy   = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }

  /* SKETCH:SNAP ─────────────────────────────────── */
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
    return best;
  }

  /* SKETCH:SELECTION ────────────────────────────── */
  // Returns handle name ('tl'/'tr'/'bl'/'br' for rects, 'ep1'/'ep2' for lines)
  function hitShapeHandle(x, y, sh) {
    if (sh.type === 'rect' || sh.type === 'wardrobe4door') {
      const x2 = sh.x + sh.w, y2 = sh.y + sh.h;
      const handles = [
        { name: 'tl', x: sh.x, y: sh.y },
        { name: 'tr', x: x2,   y: sh.y },
        { name: 'bl', x: sh.x, y: y2   },
        { name: 'br', x: x2,   y: y2   }
      ];
      for (const h of handles) {
        if (Math.hypot(x - h.x, y - h.y) <= HANDLE_HIT) return h.name;
      }
    } else if (sh.type === 'line') {
      if (Math.hypot(x - sh.x1, y - sh.y1) <= HANDLE_HIT) return 'ep1';
      if (Math.hypot(x - sh.x2, y - sh.y2) <= HANDLE_HIT) return 'ep2';
    }
    return null;
  }

  // Returns true if point is on/near the shape's body (border for rect, line body for line)
  function hitShapeBody(x, y, sh) {
    if (sh.type === 'line') {
      return distToSeg(x, y, sh.x1, sh.y1, sh.x2, sh.y2) <= EDGE_HIT;
    }
    if (sh.type === 'rect') {
      const x1 = Math.min(sh.x, sh.x + sh.w), x2 = Math.max(sh.x, sh.x + sh.w);
      const y1 = Math.min(sh.y, sh.y + sh.h), y2 = Math.max(sh.y, sh.y + sh.h);
      const t  = EDGE_HIT;
      const onTop    = Math.abs(y - y1) <= t && x >= x1 - t && x <= x2 + t;
      const onBottom = Math.abs(y - y2) <= t && x >= x1 - t && x <= x2 + t;
      const onLeft   = Math.abs(x - x1) <= t && y >= y1 - t && y <= y2 + t;
      const onRight  = Math.abs(x - x2) <= t && y >= y1 - t && y <= y2 + t;
      return onTop || onBottom || onLeft || onRight;
    }
    if (sh.type === 'wardrobe4door') {
      // Click anywhere inside the bounding box to select / move the whole wardrobe
      return x >= sh.x && x <= sh.x + sh.w && y >= sh.y && y <= sh.y + sh.h;
    }
    if (sh.type === 'text') {
      const size = sh.size || 28;
      const tw   = sh.text.length * size * 0.58;
      return x >= sh.x - 6 && x <= sh.x + tw + 6 && y >= sh.y - size - 6 && y <= sh.y + size * 0.35 + 6;
    }
    return false;
  }

  function getCornerHandles(sh) {
    const x2 = sh.x + sh.w, y2 = sh.y + sh.h;
    return [
      { name: 'tl', x: sh.x, y: sh.y },
      { name: 'tr', x: x2,   y: sh.y },
      { name: 'bl', x: sh.x, y: y2   },
      { name: 'br', x: x2,   y: y2   }
    ];
  }

  function resizePivotFor(handle, sh) {
    const x2 = sh.x + sh.w, y2 = sh.y + sh.h;
    if (handle === 'tl') return { x: x2,   y: y2   };
    if (handle === 'tr') return { x: sh.x, y: y2   };
    if (handle === 'bl') return { x: x2,   y: sh.y };
    return                      { x: sh.x, y: sh.y };
  }

  /* SKETCH:DISTANCE ─────────────────────────────── */
  function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - x1, py - y1);
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  /* SKETCH:POINTER ──────────────────────────────── */
  function onDown(id, e) {
    const s      = states[id];
    const canvas = document.getElementById(`canvas-${id}`);
    if (!s || !canvas || s.activePointerId !== null) return;

    s.activePointerId = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}

    let p = getPos(canvas, e);

    if (s.tool === 'text') {
      showTextInput(id, p.x, p.y);
      s.activePointerId = null;
      return;
    }

    // ── Select tool: tap to select, drag handles to resize/move endpoints, drag body to move ──
    if (s.tool === 'select') {
      if (s.selectedIdx >= 0 && s.selectedIdx < s.shapes.length) {
        const handle = hitShapeHandle(p.x, p.y, s.shapes[s.selectedIdx]);
        if (handle) {
          const sh       = s.shapes[s.selectedIdx];
          s.drawing      = true;
          s.resizeHandle = handle;
          s.resizePivot  = (sh.type === 'rect' || sh.type === 'wardrobe4door') ? resizePivotFor(handle, sh) : null;
          return;
        }
        if (hitShapeBody(p.x, p.y, s.shapes[s.selectedIdx])) {
          saveHistory(id);
          s.drawing        = true;
          s.moving         = true;
          s.startX         = p.x;
          s.startY         = p.y;
          s.moveShapeStart = JSON.parse(JSON.stringify(s.shapes[s.selectedIdx]));
          return;
        }
      }
      for (let i = s.shapes.length - 1; i >= 0; i--) {
        if (hitShapeHandle(p.x, p.y, s.shapes[i]) || hitShapeBody(p.x, p.y, s.shapes[i])) {
          s.selectedIdx     = i;
          s.activePointerId = null;
          redraw(id);
          return;
        }
      }
      s.selectedIdx     = -1;
      s.activePointerId = null;
      redraw(id);
      return;
    }

    // ── Rect tool: selection + resize/drag ──
    if (s.tool === 'rect') {
      // Check handle on already-selected shape
      if (s.selectedIdx >= 0 && s.selectedIdx < s.shapes.length) {
        const handle = hitShapeHandle(p.x, p.y, s.shapes[s.selectedIdx]);
        if (handle) {
          const sh       = s.shapes[s.selectedIdx];
          s.drawing      = true;
          s.resizeHandle = handle;
          s.resizePivot  = (sh.type === 'rect' || sh.type === 'wardrobe4door') ? resizePivotFor(handle, sh) : null;
          return;
        }
      }
      // Hit-test all selectable shapes (newest first)
      for (let i = s.shapes.length - 1; i >= 0; i--) {
        if (hitShapeBody(p.x, p.y, s.shapes[i])) {
          s.selectedIdx     = i;
          s.activePointerId = null;
          redraw(id);
          return;
        }
      }
      s.selectedIdx = -1; // tap empty space: deselect, then draw new rect
    }

    const snap = s.tool === 'line' ? findSnap(p.x, p.y, s.shapes) : null;
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

    // ── Handle resize / endpoint drag ──
    if (s.resizeHandle && s.selectedIdx >= 0 && s.selectedIdx < s.shapes.length) {
      const sh = s.shapes[s.selectedIdx];
      if (sh.type === 'rect' || sh.type === 'wardrobe4door') {
        const piv = s.resizePivot;
        sh.x = Math.min(p.x, piv.x); sh.y = Math.min(p.y, piv.y);
        sh.w = Math.abs(p.x - piv.x); sh.h = Math.abs(p.y - piv.y);
      } else if (sh.type === 'line') {
        if (s.resizeHandle === 'ep1') { sh.x1 = p.x; sh.y1 = p.y; }
        else                          { sh.x2 = p.x; sh.y2 = p.y; }
      }
      redraw(id);
      return;
    }

    // ── Select tool body-drag: move shape ──
    if (s.moving && s.selectedIdx >= 0 && s.selectedIdx < s.shapes.length) {
      const dx = p.x - s.startX, dy = p.y - s.startY;
      const orig = s.moveShapeStart, sh = s.shapes[s.selectedIdx];
      if (sh.type === 'rect' || sh.type === 'wardrobe4door') { sh.x = orig.x + dx; sh.y = orig.y + dy; }
      else if (sh.type === 'line') { sh.x1 = orig.x1+dx; sh.y1 = orig.y1+dy; sh.x2 = orig.x2+dx; sh.y2 = orig.y2+dy; }
      else if (sh.type === 'pen')  { sh.path = orig.path.map(pt => ({ x: pt.x+dx, y: pt.y+dy })); }
      else if (sh.type === 'text') { sh.x = orig.x + dx; sh.y = orig.y + dy; }
      redraw(id);
      return;
    }

    if (s.pendingStart) {
      if (Math.hypot(p.x - s.pendingStart.x, p.y - s.pendingStart.y) < 8) return;
      s.currentPath  = [s.pendingStart, p];
      s.pendingStart = null;
    } else if (s.tool === 'pen' || s.tool === 'eraser') {
      s.currentPath.push(p);
    }

    const snap = s.tool === 'line' ? findSnap(p.x, p.y, s.shapes) : null;
    s.snapCandidate = snap;
    redraw(id, snap ? snap.x : p.x, snap ? snap.y : p.y);
  }

  function onUp(id, e) {
    const s      = states[id];
    const canvas = document.getElementById(`canvas-${id}`);
    if (!s || !s.drawing || e.pointerId !== s.activePointerId) return;

    const raw  = getPos(canvas, e);
    const snap = s.tool === 'line' ? findSnap(raw.x, raw.y, s.shapes) : null;
    const ex   = snap ? snap.x : raw.x;
    const ey   = snap ? snap.y : raw.y;

    s.drawing         = false;
    s.activePointerId = null;
    s.pendingStart    = null;
    s.snapCandidate   = null;

    if (s.resizeHandle) {
      s.resizeHandle = null;
      s.resizePivot  = null;
      saveHistory(id);
      redraw(id);
      notifyChange();
      return;
    }

    if (s.moving) {
      s.moving        = false;
      s.moveShapeStart = null;
      redraw(id);
      notifyChange();
      return;
    }

    saveHistory(id);
    if (s.tool === 'select') { redraw(id); return; }

    if (s.tool === 'pen' && s.currentPath.length > 1) {
      if (s.autoStraighten && isRoughlyLinear(s.currentPath)) {
        const a = s.currentPath[0];
        let x2, y2;
        if (snap) { x2 = snap.x; y2 = snap.y; }
        else      { const ep = snapEndpoint(a.x, a.y, raw.x, raw.y); x2 = ep.x; y2 = ep.y; }
        s.shapes.push({ type: 'line', x1: a.x, y1: a.y, x2, y2, colour: s.colour, lw: s.lineWidth });
      } else {
        s.shapes.push({ type: 'pen', path: smoothPath(s.currentPath.slice()), colour: s.colour, lw: s.lineWidth });
      }
      s.currentPath = [];

    } else if (s.tool === 'line') {
      s.shapes.push({ type: 'line', x1: s.startX, y1: s.startY, x2: ex, y2: ey, colour: s.colour, lw: s.lineWidth });

    } else if (s.tool === 'rect') {
      const w = ex - s.startX, h = ey - s.startY;
      if (Math.abs(w) > 4 || Math.abs(h) > 4) {
        s.shapes.push({ type: 'rect', x: s.startX, y: s.startY, w, h, colour: s.colour, lw: s.lineWidth });
        s.selectedIdx = s.shapes.length - 1; // auto-select newly drawn rect

      }
    } else if (s.tool === 'eraser' && s.currentPath.length > 0) {
      const path = s.currentPath.length > 1 ? s.currentPath.slice() : [s.currentPath[0], s.currentPath[0]];
      s.shapes.push({ type: 'pen', path, colour: '#ffffff', lw: 22 });
      s.currentPath = [];
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
    s.resizeHandle    = null;
    s.resizePivot     = null;
    s.moving          = false;
    s.moveShapeStart  = null;
    redraw(id);
  }

  /* SKETCH:STRAIGHTEN ───────────────────────────── */
  function isRoughlyLinear(path) {
    if (path.length < 3) return true;
    const a   = path[0], b = path[path.length - 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    // 120px minimum — keeps short handwriting strokes as freehand curves
    if (len < 120) return false;
    let maxDev = 0;
    for (let i = 1; i < path.length - 1; i++)
      maxDev = Math.max(maxDev, ptLineDist(path[i], a, b));
    return maxDev < Math.max(10, len * 0.07);
  }

  // Two-pass weighted average — smooths out finger jitter without losing shape
  function smoothPath(path) {
    if (path.length < 4) return path;
    let p = path.slice();
    for (let pass = 0; pass < 2; pass++) {
      const s = [p[0]];
      for (let i = 1; i < p.length - 1; i++) {
        s.push({
          x: (p[i - 1].x + p[i].x * 2 + p[i + 1].x) / 4,
          y: (p[i - 1].y + p[i].y * 2 + p[i + 1].y) / 4
        });
      }
      s.push(p[p.length - 1]);
      p = s;
    }
    return p;
  }

  function ptLineDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    return len === 0
      ? Math.hypot(p.x - a.x, p.y - a.y)
      : Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy) / len;
  }

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

  /* SKETCH:TEXTINPUT ────────────────────────────── */
  function showTextInput(id, x, y) {
    const wrap = document.getElementById(`canvas-wrap-${id}`);
    if (!wrap) return;
    const inp       = document.createElement('input');
    inp.type        = 'text';
    inp.placeholder = 'Write or type here…';
    inp.style.cssText = `
      position:absolute; left:${Math.min(x, wrap.clientWidth - 220)}px; top:${Math.max(0, y - 18)}px;
      background:rgba(255,255,255,0.98); color:#1a1a1a;
      border:2px solid #8b1a1a; border-radius:6px;
      font-size:26px; padding:5px 10px; z-index:10;
      min-width:160px; max-width:280px;
      font-family:'Caveat',cursive; font-weight:700;
      box-shadow:0 3px 12px rgba(0,0,0,0.15);
    `;
    wrap.appendChild(inp);
    inp.focus();
    function commit() {
      const text = inp.value.trim();
      inp.remove();
      if (!text) return;
      saveHistory(id);
      const s = states[id];
      s.shapes.push({ type: 'text', x, y, text, colour: s.colour, size: 28 });
      redraw(id);
      notifyChange();
    }
    inp.addEventListener('blur',    commit);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') inp.remove(); });
  }

  /* SKETCH:HANDLES ──────────────────────────────── */
  function drawSelectionHandles(ctx, sh) {
    ctx.save();
    if (sh.type === 'rect' || sh.type === 'wardrobe4door') {
      // Dashed selection border
      ctx.strokeStyle = '#1a6eb5';
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(sh.x - 1, sh.y - 1, sh.w + 2, sh.h + 2);
      ctx.setLineDash([]);
      // Corner handles
      for (const h of getCornerHandles(sh)) {
        ctx.beginPath(); ctx.arc(h.x, h.y, HANDLE_R, 0, Math.PI * 2);
        ctx.fillStyle   = '#1a6eb5'; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      }
    } else if (sh.type === 'line') {
      // Blue highlight over the line
      ctx.strokeStyle  = '#1a6eb5';
      ctx.lineWidth    = 5;
      ctx.lineCap      = 'round';
      ctx.globalAlpha  = 0.3;
      ctx.beginPath(); ctx.moveTo(sh.x1, sh.y1); ctx.lineTo(sh.x2, sh.y2); ctx.stroke();
      ctx.globalAlpha  = 1;
      // Endpoint handles
      for (const [x, y] of [[sh.x1, sh.y1], [sh.x2, sh.y2]]) {
        ctx.beginPath(); ctx.arc(x, y, HANDLE_R, 0, Math.PI * 2);
        ctx.fillStyle   = '#1a6eb5'; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      }
    } else if (sh.type === 'text') {
      const size = sh.size || 28;
      const tw   = sh.text.length * size * 0.58;
      const th   = size * 1.35;
      ctx.strokeStyle = '#1a6eb5';
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(sh.x - 5, sh.y - size - 5, tw + 10, th + 5);
      ctx.setLineDash([]);
      // Drag handle dot at top-centre
      const mx = sh.x + tw / 2;
      ctx.beginPath(); ctx.arc(mx, sh.y - size - 16, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#1a6eb5'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      // ✥ crosshair icon inside dot
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(mx - 4, sh.y - size - 16); ctx.lineTo(mx + 4, sh.y - size - 16); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(mx, sh.y - size - 20);     ctx.lineTo(mx, sh.y - size - 12);     ctx.stroke();
    }
    ctx.restore();
  }

  /* SKETCH:REDRAW ───────────────────────────────── */
  function redraw(id, previewX, previewY) {
    const canvas = document.getElementById(`canvas-${id}`);
    if (!canvas) return;
    const s   = states[id];
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!s) return;

    if (s.selectedIdx >= s.shapes.length) s.selectedIdx = -1;

    s.shapes.forEach(sh => renderShape(ctx, sh));

    if (s.selectedIdx >= 0) drawSelectionHandles(ctx, s.shapes[s.selectedIdx]);

    if (s.tool === 'pen' && s.currentPath.length > 1)
      drawPenPath(ctx, s.currentPath, s.colour, s.lineWidth);

    if (s.tool === 'eraser' && s.drawing && s.currentPath.length > 1)
      drawPenPath(ctx, s.currentPath, '#ffffff', 22);

    if (s.drawing && previewX !== undefined) {
      ctx.strokeStyle = s.colour;
      ctx.lineWidth   = s.lineWidth;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      if (s.tool === 'line') {
        ctx.beginPath(); ctx.moveTo(s.startX, s.startY); ctx.lineTo(previewX, previewY); ctx.stroke();
      } else if (s.tool === 'rect') {
        ctx.beginPath(); ctx.strokeRect(s.startX, s.startY, previewX - s.startX, previewY - s.startY);
      } else if (s.tool === 'eraser') {
        ctx.save();
        ctx.strokeStyle = '#bbb'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.arc(previewX, previewY, 11, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    }

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
    else if (sh.type === 'wardrobe4door') {
      const { x, y, w, h } = sh;
      const cols = sh.cols || 4, colW = w / cols, topH = h * 0.16, hangY = y + topH + h * 0.04;
      // Outer carcass
      ctx.strokeStyle = sh.colour || '#222'; ctx.lineWidth = sh.lw || 3;
      ctx.beginPath(); ctx.strokeRect(x, y, w, h);
      // Top shelf
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, y + topH); ctx.lineTo(x + w, y + topH); ctx.stroke();
      // Vertical dividers
      for (let i = 1; i < cols; i++) {
        ctx.beginPath(); ctx.moveTo(x + i * colW, y); ctx.lineTo(x + i * colW, y + h); ctx.stroke();
      }
      // Hanging bars (blue)
      ctx.strokeStyle = '#1a6eb5'; ctx.lineWidth = 2.5;
      for (let i = 0; i < cols; i++) {
        const cx = x + i * colW;
        ctx.beginPath(); ctx.moveTo(cx + colW * 0.12, hangY); ctx.lineTo(cx + colW * 0.88, hangY); ctx.stroke();
      }
    }
    else if (sh.type === 'text') {
      ctx.font         = `700 ${sh.size || 28}px 'Caveat', cursive`;
      ctx.textBaseline = 'alphabetic';
      ctx.shadowColor  = 'rgba(0,0,0,0.12)';
      ctx.shadowBlur   = 2;
      ctx.shadowOffsetX = 0.5;
      ctx.shadowOffsetY = 0.5;
      ctx.fillText(sh.text, sh.x, sh.y);
      ctx.shadowColor  = 'transparent';
      ctx.shadowBlur   = 0;
    }
  }

  function drawPenPath(ctx, path, colour, lw) {
    if (path.length < 2) return;
    ctx.strokeStyle = colour;
    ctx.lineWidth   = lw || 2.5;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    if (path.length === 2) {
      ctx.lineTo(path[1].x, path[1].y);
    } else {
      for (let i = 1; i < path.length - 1; i++) {
        const mx = (path[i].x + path[i + 1].x) / 2;
        const my = (path[i].y + path[i + 1].y) / 2;
        ctx.quadraticCurveTo(path[i].x, path[i].y, mx, my);
      }
      ctx.lineTo(path[path.length - 1].x, path[path.length - 1].y);
    }
    ctx.stroke();
  }

  /* SKETCH:HISTORY ──────────────────────────────── */
  function saveHistory(id) {
    const s = states[id];
    if (!s) return;
    s.history.push(JSON.stringify(s.shapes));
    if (s.history.length > 50) s.history.shift();
  }

  /* SKETCH:CONTROLS ─────────────────────────────── */
  function undo(id) {
    const s = states[id];
    if (!s || !s.history.length) return;
    s.shapes      = JSON.parse(s.history.pop());
    s.selectedIdx = -1;
    redraw(id);
    notifyChange();
  }

  function redrawScaled(id, scaleX, scaleY) {
    const canvas = document.getElementById(`canvas-${id}`);
    if (!canvas) return;
    const s = states[id];
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!s) return;
    ctx.save();
    ctx.scale(scaleX, scaleY);
    s.shapes.forEach(sh => renderShape(ctx, sh));
    ctx.restore();
  }

  function clear(id) {
    const s = states[id];
    if (!s) return;
    saveHistory(id);
    s.shapes      = [];
    s.selectedIdx = -1;
    redraw(id);
    notifyChange();
  }

  function deleteSelected(id) {
    const s = states[id];
    if (!s || s.selectedIdx < 0 || s.selectedIdx >= s.shapes.length) return;
    saveHistory(id);
    s.shapes.splice(s.selectedIdx, 1);
    s.selectedIdx = -1;
    redraw(id);
    notifyChange();
  }

  function setTool(id, tool) {
    const s = states[id];
    if (s) {
      s.tool = tool;
      if (tool !== 'rect' && tool !== 'select') s.selectedIdx = -1;
    }
    ['select','pen','line','rect','text','eraser'].forEach(t => {
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

  /* SKETCH:DATA ─────────────────────────────────── */
  function getShapes(id) { return states[id] ? states[id].shapes : []; }

  function setShapes(id, shapes) {
    const s = states[id];
    if (!s) return;
    s.shapes      = Array.isArray(shapes) ? shapes : [];
    s.selectedIdx = -1;
    redraw(id);
  }

  /* SKETCH:TEMPLATES ────────────────────────────── */
  function buildTemplate(name, W, H) {
    if (name !== '4door') return [];
    const px = W * 0.04, py = H * 0.05;
    const x  = px, y = py, w = W - px * 2, h = H - py * 2;
    // Single shape — resize/move updates x,y,w,h and renderShape redraws everything
    return [{ type: 'wardrobe4door', x, y, w, h, cols: 4, colour: '#222', lw: 3 }];
  }

  function insertTemplate(id, name) {
    const canvas = document.getElementById(`canvas-${id}`);
    if (!canvas) return;
    const s = states[id];
    saveHistory(id);
    const before = s.shapes.length;
    s.shapes.push(...buildTemplate(name, canvas.width, canvas.height));
    s.selectedIdx = before; // select the outer carcass (first inserted shape)
    setTool(id, 'select');  // auto-switch to select so rep can immediately resize
    redraw(id);
    notifyChange();
  }

  function fsTpl(name) {
    const canvas = document.getElementById('fs-canvas');
    if (!canvas) return;
    fsSaveHistory();
    const before = fs.shapes.length;
    fs.shapes.push(...buildTemplate(name, canvas.width, canvas.height));
    fs.selectedIdx = before;
    fsSetTool('select');
    fsRedraw();
  }

  /* SKETCH:NOTIFY ───────────────────────────────── */
  function notifyChange() {
    if (typeof window.onSketchUpdated === 'function') window.onSketchUpdated();
  }

  /* SKETCH:FULLSCREEN ───────────────────────────── */
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
    currentPath:     [],
    selectedIdx:     -1,
    resizeHandle:    null,
    resizePivot:     null,
    moving:          false,
    moveShapeStart:  null
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
    fs.selectedIdx     = -1;
    fs.resizeHandle    = null;
    fs.resizePivot     = null;

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
    s.selectedIdx    = -1;
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

  /* SKETCH:FSPOINTER ────────────────────────────── */
  function initFsCanvas() {
    const canvas = document.getElementById('fs-canvas');
    if (!canvas) return;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('touchstart',    e => e.preventDefault(), { passive: false });
    canvas.addEventListener('touchmove',     e => e.preventDefault(), { passive: false });
    canvas.addEventListener('pointerdown',   e => { e.preventDefault(); fsDown(e); });
    canvas.addEventListener('pointermove',   e => { e.preventDefault(); fsMove(e); });
    canvas.addEventListener('pointerup',     e => { e.preventDefault(); fsUp(e); });
    canvas.addEventListener('pointercancel', e => fsCancelDraw(e));

    // PC fallback for fullscreen canvas — same reason as per-room canvas
    window.addEventListener('pointerup', e => {
      if (fs.drawing && e.pointerId === fs.activePointerId) fsUp(e);
    });
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
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}

    let p = fsGetPos(e);
    if (fs.tool === 'text') { fsShowTextInput(p.x, p.y); fs.activePointerId = null; return; }

    if (fs.tool === 'select') {
      if (fs.selectedIdx >= 0 && fs.selectedIdx < fs.shapes.length) {
        const handle = hitShapeHandle(p.x, p.y, fs.shapes[fs.selectedIdx]);
        if (handle) {
          const sh        = fs.shapes[fs.selectedIdx];
          fs.drawing      = true;
          fs.resizeHandle = handle;
          fs.resizePivot  = (sh.type === 'rect' || sh.type === 'wardrobe4door') ? resizePivotFor(handle, sh) : null;
          return;
        }
        if (hitShapeBody(p.x, p.y, fs.shapes[fs.selectedIdx])) {
          fsSaveHistory();
          fs.drawing        = true;
          fs.moving         = true;
          fs.startX         = p.x;
          fs.startY         = p.y;
          fs.moveShapeStart = JSON.parse(JSON.stringify(fs.shapes[fs.selectedIdx]));
          return;
        }
      }
      for (let i = fs.shapes.length - 1; i >= 0; i--) {
        if (hitShapeHandle(p.x, p.y, fs.shapes[i]) || hitShapeBody(p.x, p.y, fs.shapes[i])) {
          fs.selectedIdx     = i;
          fs.activePointerId = null;
          fsRedraw();
          return;
        }
      }
      fs.selectedIdx     = -1;
      fs.activePointerId = null;
      fsRedraw();
      return;
    }

    if (fs.tool === 'rect') {
      if (fs.selectedIdx >= 0 && fs.selectedIdx < fs.shapes.length) {
        const handle = hitShapeHandle(p.x, p.y, fs.shapes[fs.selectedIdx]);
        if (handle) {
          const sh        = fs.shapes[fs.selectedIdx];
          fs.drawing      = true;
          fs.resizeHandle = handle;
          fs.resizePivot  = (sh.type === 'rect' || sh.type === 'wardrobe4door') ? resizePivotFor(handle, sh) : null;
          return;
        }
      }
      for (let i = fs.shapes.length - 1; i >= 0; i--) {
        if (hitShapeBody(p.x, p.y, fs.shapes[i])) {
          fs.selectedIdx     = i;
          fs.activePointerId = null;
          fsRedraw();
          return;
        }
      }
      fs.selectedIdx = -1;
    }

    const snap = fs.tool === 'line' ? findSnap(p.x, p.y, fs.shapes) : null;
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

    if (fs.resizeHandle && fs.selectedIdx >= 0 && fs.selectedIdx < fs.shapes.length) {
      const sh = fs.shapes[fs.selectedIdx];
      if (sh.type === 'rect') {
        const piv = fs.resizePivot;
        sh.x = Math.min(p.x, piv.x); sh.y = Math.min(p.y, piv.y);
        sh.w = Math.abs(p.x - piv.x); sh.h = Math.abs(p.y - piv.y);
      } else if (sh.type === 'line') {
        if (fs.resizeHandle === 'ep1') { sh.x1 = p.x; sh.y1 = p.y; }
        else                           { sh.x2 = p.x; sh.y2 = p.y; }
      }
      fsRedraw();
      return;
    }

    if (fs.moving && fs.selectedIdx >= 0 && fs.selectedIdx < fs.shapes.length) {
      const dx = p.x - fs.startX, dy = p.y - fs.startY;
      const orig = fs.moveShapeStart, sh = fs.shapes[fs.selectedIdx];
      if (sh.type === 'rect' || sh.type === 'wardrobe4door') { sh.x = orig.x + dx; sh.y = orig.y + dy; }
      else if (sh.type === 'line') { sh.x1 = orig.x1+dx; sh.y1 = orig.y1+dy; sh.x2 = orig.x2+dx; sh.y2 = orig.y2+dy; }
      else if (sh.type === 'pen')  { sh.path = orig.path.map(pt => ({ x: pt.x+dx, y: pt.y+dy })); }
      else if (sh.type === 'text') { sh.x = orig.x + dx; sh.y = orig.y + dy; }
      fsRedraw();
      return;
    }

    if (fs.pendingStart) {
      if (Math.hypot(p.x - fs.pendingStart.x, p.y - fs.pendingStart.y) < 8) return;
      fs.currentPath  = [fs.pendingStart, p];
      fs.pendingStart = null;
    } else if (fs.tool === 'pen' || fs.tool === 'eraser') {
      fs.currentPath.push(p);
    }
    const snap = fs.tool === 'line' ? findSnap(p.x, p.y, fs.shapes) : null;
    fs.snapCandidate = snap;
    fsRedraw(snap ? snap.x : p.x, snap ? snap.y : p.y);
  }

  function fsUp(e) {
    if (!fs.drawing || e.pointerId !== fs.activePointerId) return;
    const raw  = fsGetPos(e);
    const snap = fs.tool === 'line' ? findSnap(raw.x, raw.y, fs.shapes) : null;
    const ex   = snap ? snap.x : raw.x;
    const ey   = snap ? snap.y : raw.y;

    fs.drawing         = false;
    fs.activePointerId = null;
    fs.pendingStart    = null;
    fs.snapCandidate   = null;

    if (fs.resizeHandle) {
      fs.resizeHandle = null;
      fs.resizePivot  = null;
      fsSaveHistory();
      fsRedraw();
      return;
    }

    if (fs.moving) {
      fs.moving        = false;
      fs.moveShapeStart = null;
      fsRedraw();
      return;
    }

    fsSaveHistory();
    if (fs.tool === 'select') { fsRedraw(); return; }

    if (fs.tool === 'pen' && fs.currentPath.length > 1) {
      if (fs.autoStraighten && isRoughlyLinear(fs.currentPath)) {
        const a = fs.currentPath[0];
        let x2, y2;
        if (snap) { x2 = snap.x; y2 = snap.y; }
        else      { const ep = snapEndpoint(a.x, a.y, raw.x, raw.y); x2 = ep.x; y2 = ep.y; }
        fs.shapes.push({ type: 'line', x1: a.x, y1: a.y, x2, y2, colour: fs.colour, lw: fs.lineWidth });
      } else {
        fs.shapes.push({ type: 'pen', path: smoothPath(fs.currentPath.slice()), colour: fs.colour, lw: fs.lineWidth });
      }
      fs.currentPath = [];
    } else if (fs.tool === 'line') {
      fs.shapes.push({ type: 'line', x1: fs.startX, y1: fs.startY, x2: ex, y2: ey, colour: fs.colour, lw: fs.lineWidth });
    } else if (fs.tool === 'rect') {
      const w = ex - fs.startX, h = ey - fs.startY;
      if (Math.abs(w) > 4 || Math.abs(h) > 4) {
        fs.shapes.push({ type: 'rect', x: fs.startX, y: fs.startY, w, h, colour: fs.colour, lw: fs.lineWidth });
        fs.selectedIdx = fs.shapes.length - 1;
      }
    } else if (fs.tool === 'eraser' && fs.currentPath.length > 0) {
      const path = fs.currentPath.length > 1 ? fs.currentPath.slice() : [fs.currentPath[0], fs.currentPath[0]];
      fs.shapes.push({ type: 'pen', path, colour: '#ffffff', lw: 22 });
      fs.currentPath = [];
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
    fs.resizeHandle    = null;
    fs.resizePivot     = null;
    fs.moving          = false;
    fs.moveShapeStart  = null;
    fsRedraw();
  }

  /* SKETCH:FSTEXT ───────────────────────────────── */
  function fsShowTextInput(x, y) {
    const area   = document.getElementById('fs-canvas-area');
    const canvas = document.getElementById('fs-canvas');
    const inp    = document.createElement('input');
    inp.type     = 'text';
    inp.placeholder = 'Write or type here…';
    inp.style.cssText = `
      position:absolute; left:${Math.min(x, (canvas ? canvas.clientWidth : 800) - 300)}px; top:${Math.max(0, y - 20)}px;
      background:rgba(255,255,255,0.98); color:#1a1a1a;
      border:2px solid #8b1a1a; border-radius:6px;
      font-size:34px; padding:6px 14px; z-index:10;
      min-width:200px; max-width:440px;
      font-family:'Caveat',cursive; font-weight:700;
      box-shadow:0 4px 16px rgba(0,0,0,0.2);
    `;
    area.appendChild(inp);
    inp.focus();
    function commit() {
      const text = inp.value.trim();
      inp.remove();
      if (!text) return;
      fsSaveHistory();
      fs.shapes.push({ type: 'text', x, y, text, colour: fs.colour, size: 36 });
      fsRedraw();
    }
    inp.addEventListener('blur',    commit);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') inp.remove(); });
  }

  /* SKETCH:FSREDRAW ─────────────────────────────── */
  function fsRedraw(previewX, previewY) {
    const canvas = document.getElementById('fs-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (fs.selectedIdx >= fs.shapes.length) fs.selectedIdx = -1;

    fs.shapes.forEach(sh => renderShape(ctx, sh));

    if (fs.selectedIdx >= 0) drawSelectionHandles(ctx, fs.shapes[fs.selectedIdx]);

    if (fs.tool === 'pen' && fs.currentPath.length > 1)
      drawPenPath(ctx, fs.currentPath, fs.colour, fs.lineWidth);

    if (fs.tool === 'eraser' && fs.drawing && fs.currentPath.length > 1)
      drawPenPath(ctx, fs.currentPath, '#ffffff', 22);

    if (fs.drawing && previewX !== undefined) {
      ctx.strokeStyle = fs.colour;
      ctx.lineWidth   = fs.lineWidth;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      if (fs.tool === 'line') {
        ctx.beginPath(); ctx.moveTo(fs.startX, fs.startY); ctx.lineTo(previewX, previewY); ctx.stroke();
      } else if (fs.tool === 'rect') {
        ctx.beginPath(); ctx.strokeRect(fs.startX, fs.startY, previewX - fs.startX, previewY - fs.startY);
      } else if (fs.tool === 'eraser') {
        ctx.save();
        ctx.strokeStyle = '#bbb'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.arc(previewX, previewY, 11, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    }

    if (fs.snapCandidate) drawSnapIndicator(ctx, fs.snapCandidate);

    // Show/hide section +/- buttons based on whether a wardrobe is selected
    const selSh = fs.selectedIdx >= 0 && fs.selectedIdx < fs.shapes.length ? fs.shapes[fs.selectedIdx] : null;
    const showSec = selSh?.type === 'wardrobe4door';
    ['fs-section-sep','fs-section-rem','fs-section-count','fs-section-add'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = showSec ? '' : 'none';
    });
    if (showSec) {
      const countEl = document.getElementById('fs-section-count');
      if (countEl) countEl.textContent = selSh.cols || 4;
    }
  }

  function fsSaveHistory() {
    fs.history.push(JSON.stringify(fs.shapes));
    if (fs.history.length > 50) fs.history.shift();
  }

  /* SKETCH:FSCONTROLS ───────────────────────────── */
  function fsDeleteSelected() {
    if (fs.selectedIdx < 0 || fs.selectedIdx >= fs.shapes.length) return;
    fsSaveHistory();
    fs.shapes.splice(fs.selectedIdx, 1);
    fs.selectedIdx = -1;
    fsRedraw();
  }

  function fsAddSection() {
    if (fs.selectedIdx < 0 || fs.selectedIdx >= fs.shapes.length) return;
    const sh = fs.shapes[fs.selectedIdx];
    if (sh.type !== 'wardrobe4door' || (sh.cols || 4) >= 8) return;
    fsSaveHistory();
    sh.cols = (sh.cols || 4) + 1;
    fsRedraw();
  }

  function fsRemoveSection() {
    if (fs.selectedIdx < 0 || fs.selectedIdx >= fs.shapes.length) return;
    const sh = fs.shapes[fs.selectedIdx];
    if (sh.type !== 'wardrobe4door' || (sh.cols || 4) <= 1) return;
    fsSaveHistory();
    sh.cols = (sh.cols || 4) - 1;
    fsRedraw();
  }

  function fsSetTool(tool) {
    fs.tool = tool;
    if (tool !== 'rect' && tool !== 'select') fs.selectedIdx = -1;
    ['select','pen','line','rect','text','eraser'].forEach(t => {
      const btn = document.getElementById(`fs-tool-${t}`);
      if (btn) btn.classList.toggle('active', t === tool);
    });
  }

  function fsSetColour(colour, el) {
    fs.colour = colour;
    document.querySelectorAll('#fs-colours .colour-dot').forEach(d => d.classList.remove('active'));
    if (el) el.classList.add('active');
  }

  function fsUndo() {
    if (!fs.history.length) return;
    fs.shapes      = JSON.parse(fs.history.pop());
    fs.selectedIdx = -1;
    fsRedraw();
  }
  function fsClear() {
    fsSaveHistory();
    fs.shapes      = [];
    fs.selectedIdx = -1;
    fsRedraw();
  }

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

  /* SKETCH:BOOT */
  document.addEventListener('DOMContentLoaded', () => {
    initFsCanvas();
    // Redraw all canvases once Caveat font is loaded so saved text renders correctly
    document.fonts.ready.then(() => Object.keys(states).forEach(id => redraw(id)));
  });

  /* SKETCH:EXPORTS */
  return {
    init, resizeCanvas, redraw, redrawScaled, setTool, setColour, toggleStraighten, undo, clear, deleteSelected, getShapes, setShapes,
    insertTemplate, fsTpl, fsAddSection, fsRemoveSection,
    openFullscreen, closeFullscreen,
    fsSetTool, fsSetColour, fsUndo, fsClear, fsDeleteSelected, fsToggleStraighten
  };
})();
