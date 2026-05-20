/* ══════════════════════════════════════════════
   sketch.js — Canvas drawing engine
   - Pointer Events API (palm rejection)
   - One active pointer per canvas (no accidental marks)
   - Auto-straighten: pen strokes snap to H/V/45° axes
   - Endpoint snap: lines join automatically when drawn near an endpoint
   - Rect corner-drag resize + line endpoint drag
   - Select any rect or line, then ✕ Del to remove
   - Full-screen sketch overlay
══════════════════════════════════════════════ */

const Sketch = (() => {
  const states  = {};
  const SNAP_R     = 20;
  const HANDLE_R   = 8;   // visual radius of handles
  const HANDLE_HIT = 28;  // hit detection radius (touch-friendly)
  const EDGE_HIT   = 16;  // proximity for line/rect edge selection

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
      currentPath:     [],
      selectedIdx:     -1,
      resizeHandle:    null,
      resizePivot:     null,
      moving:          false,
      moveShapeStart:  null
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
    if (states[id]) states[id].selectedIdx = -1;
    const w = wrap.clientWidth;
    const h = Math.round(w * 0.7);
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

  /* ── Endpoint snap ───────────────────────────── */
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

  /* ── Selection helpers ───────────────────────── */
  // Returns handle name ('tl'/'tr'/'bl'/'br' for rects, 'ep1'/'ep2' for lines)
  function hitShapeHandle(x, y, sh) {
    if (sh.type === 'rect') {
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

  /* ── Distance helpers ────────────────────────── */
  function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - x1, py - y1);
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  /* ── Pointer events ──────────────────────────── */
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

    // ── Select tool: tap to select, drag handles to resize/move endpoints, drag body to move ──
    if (s.tool === 'select') {
      if (s.selectedIdx >= 0 && s.selectedIdx < s.shapes.length) {
        const handle = hitShapeHandle(p.x, p.y, s.shapes[s.selectedIdx]);
        if (handle) {
          const sh       = s.shapes[s.selectedIdx];
          s.drawing      = true;
          s.resizeHandle = handle;
          s.resizePivot  = sh.type === 'rect' ? resizePivotFor(handle, sh) : null;
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
          s.resizePivot  = sh.type === 'rect' ? resizePivotFor(handle, sh) : null;
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
      if (sh.type === 'rect') {
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
      if (sh.type === 'rect') { sh.x = orig.x + dx; sh.y = orig.y + dy; }
      else if (sh.type === 'line') { sh.x1 = orig.x1+dx; sh.y1 = orig.y1+dy; sh.x2 = orig.x2+dx; sh.y2 = orig.y2+dy; }
      else if (sh.type === 'pen')  { sh.path = orig.path.map(pt => ({ x: pt.x+dx, y: pt.y+dy })); }
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
        s.shapes.push({ type: 'pen', path: s.currentPath.slice(), colour: s.colour, lw: s.lineWidth });
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
      s.shapes.push({ type: 'text', x, y, text, colour: s.colour, size: 18 });
      redraw(id);
      notifyChange();
    }
    inp.addEventListener('blur',    commit);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') inp.remove(); });
  }

  /* ── Draw selection handles ──────────────────── */
  function drawSelectionHandles(ctx, sh) {
    ctx.save();
    if (sh.type === 'rect') {
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
    }
    ctx.restore();
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
    else if (sh.type === 'text') { ctx.font = `bold ${sh.size || 18}px Arial`; ctx.fillText(sh.text, sh.x, sh.y); }
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

  /* ── Data access ─────────────────────────────── */
  function getShapes(id) { return states[id] ? states[id].shapes : []; }

  function setShapes(id, shapes) {
    const s = states[id];
    if (!s) return;
    s.shapes      = Array.isArray(shapes) ? shapes : [];
    s.selectedIdx = -1;
    redraw(id);
  }

  /* ── Templates ───────────────────────────────── */
  function buildTemplate(name, W, H) {
    const shapes = [];
    if (name !== '4door') return shapes;

    const px   = W * 0.04, py  = H * 0.05;
    const bw   = W - px * 2, bh = H - py * 2;
    const bx   = px, by = py;
    const cols = 4;
    const colW = bw / cols;
    const topH = bh * 0.16;
    // Hanging bars sit just below the top shelf (small gap)
    const hangY = by + topH + bh * 0.04;

    // Outer carcass (selectable rect — drag corners to resize)
    shapes.push({ type: 'rect', x: bx, y: by, w: bw, h: bh, colour: '#222', lw: 3 });
    // Top shelf
    shapes.push({ type: 'line', x1: bx, y1: by + topH, x2: bx + bw, y2: by + topH, colour: '#222', lw: 2 });
    // 3 vertical dividers
    for (let i = 1; i < cols; i++) {
      shapes.push({ type: 'line', x1: bx + i * colW, y1: by, x2: bx + i * colW, y2: by + bh, colour: '#222', lw: 2 });
    }
    // Hanging bars — one per section, just below top shelf
    for (let i = 0; i < cols; i++) {
      const cx = bx + i * colW;
      shapes.push({ type: 'line', x1: cx + colW * 0.12, y1: hangY, x2: cx + colW * 0.88, y2: hangY, colour: '#1a6eb5', lw: 2.5 });
    }
    return shapes;
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

    if (fs.tool === 'select') {
      if (fs.selectedIdx >= 0 && fs.selectedIdx < fs.shapes.length) {
        const handle = hitShapeHandle(p.x, p.y, fs.shapes[fs.selectedIdx]);
        if (handle) {
          const sh        = fs.shapes[fs.selectedIdx];
          fs.drawing      = true;
          fs.resizeHandle = handle;
          fs.resizePivot  = sh.type === 'rect' ? resizePivotFor(handle, sh) : null;
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
          fs.resizePivot  = sh.type === 'rect' ? resizePivotFor(handle, sh) : null;
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
      if (sh.type === 'rect') { sh.x = orig.x + dx; sh.y = orig.y + dy; }
      else if (sh.type === 'line') { sh.x1 = orig.x1+dx; sh.y1 = orig.y1+dy; sh.x2 = orig.x2+dx; sh.y2 = orig.y2+dy; }
      else if (sh.type === 'pen')  { sh.path = orig.path.map(pt => ({ x: pt.x+dx, y: pt.y+dy })); }
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
        fs.shapes.push({ type: 'pen', path: fs.currentPath.slice(), colour: fs.colour, lw: fs.lineWidth });
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
      fs.shapes.push({ type: 'text', x, y, text, colour: fs.colour, size: 18 });
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
  }

  function fsSaveHistory() {
    fs.history.push(JSON.stringify(fs.shapes));
    if (fs.history.length > 50) fs.history.shift();
  }

  function fsDeleteSelected() {
    if (fs.selectedIdx < 0 || fs.selectedIdx >= fs.shapes.length) return;
    fsSaveHistory();
    fs.shapes.splice(fs.selectedIdx, 1);
    fs.selectedIdx = -1;
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

  document.addEventListener('DOMContentLoaded', initFsCanvas);

  return {
    init, resizeCanvas, redraw, redrawScaled, setTool, setColour, toggleStraighten, undo, clear, deleteSelected, getShapes, setShapes,
    insertTemplate, fsTpl,
    openFullscreen, closeFullscreen,
    fsSetTool, fsSetColour, fsUndo, fsClear, fsDeleteSelected, fsToggleStraighten
  };
})();
