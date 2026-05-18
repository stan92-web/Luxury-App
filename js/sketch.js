/* ══════════════════════════════════════════════
   sketch.js — Canvas drawing engine
   One independent state object per canvas.
   No dependencies on other modules.
══════════════════════════════════════════════ */

const Sketch = (() => {
  const states = {};

  /* ── Init ── */
  function init(id) {
    const canvas = document.getElementById(`canvas-${id}`);
    if (!canvas) return;

    states[id] = {
      tool:       'pen',
      colour:     '#222222',
      lineWidth:  2.5,
      drawing:    false,
      shapes:     [],
      history:    [],
      startX:     0,
      startY:     0,
      currentPath: []
    };

    canvas.addEventListener('mousedown',  e => onDown(id, e));
    canvas.addEventListener('mousemove',  e => onMove(id, e));
    canvas.addEventListener('mouseup',    e => onUp(id, e));
    canvas.addEventListener('mouseleave', e => onUp(id, e));

    canvas.addEventListener('touchstart', e => { e.preventDefault(); onDown(id, e.touches[0]); },        { passive: false });
    canvas.addEventListener('touchmove',  e => { e.preventDefault(); onMove(id, e.touches[0]); },        { passive: false });
    canvas.addEventListener('touchend',   e => { e.preventDefault(); onUp(id, e.changedTouches[0]); },   { passive: false });

    resizeCanvas(id);
  }

  /* ── Canvas sizing ── */
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

  /* ── Coordinate helper ── */
  function getPos(id, e) {
    const canvas = document.getElementById(`canvas-${id}`);
    const rect   = canvas.getBoundingClientRect();
    const sx     = canvas.width  / rect.width;
    const sy     = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * sx,
      y: (e.clientY - rect.top)  * sy
    };
  }

  /* ── Pointer events ── */
  function onDown(id, e) {
    const s = states[id];
    if (!s) return;
    const p = getPos(id, e);

    if (s.tool === 'text') {
      showTextInput(id, p.x, p.y);
      return;
    }

    s.drawing = true;
    s.startX  = p.x;
    s.startY  = p.y;

    if (s.tool === 'pen') {
      s.currentPath = [{ x: p.x, y: p.y }];
    }
  }

  function onMove(id, e) {
    const s = states[id];
    if (!s || !s.drawing) return;
    const p = getPos(id, e);

    if (s.tool === 'pen') {
      s.currentPath.push({ x: p.x, y: p.y });
    }
    redraw(id, p.x, p.y);
  }

  function onUp(id, e) {
    const s = states[id];
    if (!s || !s.drawing) return;
    const p = getPos(id, e);
    s.drawing = false;

    saveHistory(id);

    if (s.tool === 'pen' && s.currentPath.length > 1) {
      s.shapes.push({ type: 'pen', path: s.currentPath.slice(), colour: s.colour, lw: s.lineWidth });
      s.currentPath = [];

    } else if (s.tool === 'line') {
      s.shapes.push({ type: 'line', x1: s.startX, y1: s.startY, x2: p.x, y2: p.y, colour: s.colour, lw: s.lineWidth });

    } else if (s.tool === 'rect') {
      const w = p.x - s.startX;
      const h = p.y - s.startY;
      if (Math.abs(w) > 4 || Math.abs(h) > 4) {
        s.shapes.push({ type: 'rect', x: s.startX, y: s.startY, w, h, colour: s.colour, lw: s.lineWidth });
      }
    }

    redraw(id);
    notifyChange();
  }

  /* ── Text input overlay ── */
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
      font-size:13px; padding:3px 8px; z-index:10;
      min-width:90px; max-width:200px;
      font-family:Arial,sans-serif;
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
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter')  commit();
      if (e.key === 'Escape') inp.remove();
    });
  }

  /* ── Redraw ── */
  function redraw(id, previewX, previewY) {
    const canvas = document.getElementById(`canvas-${id}`);
    if (!canvas) return;
    const s   = states[id];
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!s) return;

    s.shapes.forEach(sh => renderShape(ctx, sh));

    if (s.tool === 'pen' && s.currentPath.length > 1) {
      drawPenPath(ctx, s.currentPath, s.colour, s.lineWidth);
    }

    if (s.drawing && previewX !== undefined) {
      ctx.strokeStyle = s.colour;
      ctx.lineWidth   = s.lineWidth;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      if (s.tool === 'line') {
        ctx.beginPath();
        ctx.moveTo(s.startX, s.startY);
        ctx.lineTo(previewX, previewY);
        ctx.stroke();
      } else if (s.tool === 'rect') {
        ctx.beginPath();
        ctx.strokeRect(s.startX, s.startY, previewX - s.startX, previewY - s.startY);
      }
    }
  }

  function renderShape(ctx, sh) {
    ctx.strokeStyle = sh.colour;
    ctx.fillStyle   = sh.colour;
    ctx.lineWidth   = sh.lw || 2.5;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    if      (sh.type === 'pen')  { drawPenPath(ctx, sh.path, sh.colour, sh.lw); }
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

  /* ── History ── */
  function saveHistory(id) {
    const s = states[id];
    if (!s) return;
    s.history.push(JSON.stringify(s.shapes));
    if (s.history.length > 50) s.history.shift();
  }

  /* ── Public controls ── */
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
    ['pen', 'line', 'rect', 'text'].forEach(t => {
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

  /* ── Data access ── */
  function getShapes(id) {
    return states[id] ? states[id].shapes : [];
  }

  function setShapes(id, shapes) {
    const s = states[id];
    if (!s) return;
    s.shapes = Array.isArray(shapes) ? shapes : [];
    redraw(id);
  }

  /* ── Notify survey module of changes (loose coupling) ── */
  function notifyChange() {
    if (typeof window.onSketchUpdated === 'function') window.onSketchUpdated();
  }

  return { init, resizeCanvas, redraw, setTool, setColour, undo, clear, getShapes, setShapes };
})();
