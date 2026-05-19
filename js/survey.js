/* ══════════════════════════════════════════════
   survey.js — Field survey form logic
   Manages rooms, auto-save, load, print.
   Depends on: Sketch (sketch.js)
══════════════════════════════════════════════ */

const Survey = (() => {
  let nextId      = 0;
  const activeIds = [];   // ordered list of active room ids
  let saveTimer   = null;

  /* ── Init ── */
  function init() {
    const today = new Date();

    const dateInput = document.getElementById('survey-date');
    if (dateInput) dateInput.value = today.toISOString().split('T')[0];

    const headerDate = document.getElementById('header-date');
    if (headerDate) {
      headerDate.textContent = today.toLocaleDateString('en-GB', {
        weekday: 'short', day: 'numeric', month: 'long', year: 'numeric'
      });
    }

    // Register sketch change callback
    window.onSketchUpdated = () => {
      scheduleSave();
      activeIds.forEach(updateSketchDims);
    };

    // Save on any form input
    document.addEventListener('input', scheduleSave);

    // Resize canvases when window changes
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => activeIds.forEach(Sketch.resizeCanvas), 180);
    });

    // Load saved data — if nothing saved, start with one blank room
    const loaded = load();
    if (!loaded) addRoom();
  }

  /* ── Save (debounced) ── */
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }

  function save() {
    try {
      const data = {
        customer: {
          first:    gv('c-first'),
          last:     gv('c-last'),
          phone:    gv('c-phone'),
          email:    gv('c-email'),
          address:  gv('c-address'),
          source:   gv('c-source'),
          surveyor: gv('surveyor'),
          date:     gv('survey-date'),
          notes:    gv('c-notes')
        },
        rooms: activeIds.map(id => ({
          name:   gv(`rname-${id}`),
          w:      gv(`dw-${id}`),
          h:      gv(`dh-${id}`),
          d:      gv(`dd-${id}`),
          doors:  gv(`du-${id}`),
          notes:  gv(`rnotes-${id}`),
          shapes: Sketch.getShapes(id)
        }))
      };
      localStorage.setItem('lh_survey_v1', JSON.stringify(data));
    } catch (_) {}
  }

  /* ── Load ── */
  function load() {
    try {
      const raw = localStorage.getItem('lh_survey_v1');
      if (!raw) return false;
      const data = JSON.parse(raw);

      const c = data.customer || {};
      sv('c-first',    c.first);
      sv('c-last',     c.last);
      sv('c-phone',    c.phone);
      sv('c-email',    c.email);
      sv('c-address',  c.address);
      sv('c-source',   c.source);
      sv('surveyor',   c.surveyor);
      sv('survey-date', c.date);
      sv('c-notes',    c.notes);

      (data.rooms || []).forEach(r => {
        const id = addRoom();
        sv(`rname-${id}`, r.name);
        sv(`dw-${id}`,    r.w);
        sv(`dh-${id}`,    r.h);
        sv(`dd-${id}`,    r.d);
        sv(`du-${id}`,    r.doors);
        sv(`rnotes-${id}`, r.notes);
        // Defer shape load until canvas is sized
        requestAnimationFrame(() => { Sketch.setShapes(id, r.shapes); updateSketchDims(id); });
      });

      return (data.rooms && data.rooms.length > 0);
    } catch (_) {
      return false;
    }
  }

  /* ── Add / Remove rooms ── */
  function addRoom() {
    nextId++;
    const id = nextId;
    activeIds.push(id);

    const container = document.getElementById('rooms-container');
    const div       = document.createElement('div');
    div.className   = 'room-card';
    div.id          = `room-card-${id}`;
    div.innerHTML   = buildRoomHTML(id);
    container.appendChild(div);

    requestAnimationFrame(() => {
      Sketch.init(id);
    });

    return id;
  }

  function removeRoom(id) {
    const el = document.getElementById(`room-card-${id}`);
    if (el) el.remove();
    const i = activeIds.indexOf(id);
    if (i !== -1) activeIds.splice(i, 1);
    save();
    showToast('Room removed');
  }

  /* ── Room HTML template ── */
  function buildRoomHTML(id) {
    return `
      <div class="room-card-header">
        <div class="room-header-left">
          <div class="room-number">Wardrobe / Room ${id}</div>
          <input type="text" class="room-name-input" id="rname-${id}"
            placeholder="e.g. Master Bedroom, En Suite, Hallway…">
        </div>
        <button class="btn btn-danger btn-sm no-print" onclick="Survey.removeRoom(${id})">✕ Remove</button>
      </div>

      <div class="room-card-body">

        <div class="dims-row">
          <div class="dim-group">
            <label>Width</label>
            <input type="number" class="dim-input" id="dw-${id}" placeholder="—" inputmode="decimal">
            <div class="dim-unit">mm</div>
          </div>
          <div class="dim-group">
            <label>Height</label>
            <input type="number" class="dim-input" id="dh-${id}" placeholder="—" inputmode="decimal">
            <div class="dim-unit">mm</div>
          </div>
          <div class="dim-group">
            <label>Depth</label>
            <input type="number" class="dim-input" id="dd-${id}" placeholder="—" inputmode="decimal">
            <div class="dim-unit">mm</div>
          </div>
          <div class="dim-group">
            <label>Doors</label>
            <input type="number" class="dim-input" id="du-${id}" placeholder="—" min="1" max="20" inputmode="numeric">
            <div class="dim-unit">units</div>
          </div>
        </div>

        <div class="sketch-section">
          <div class="sketch-label">✏️ Sketch / Measurements</div>
          <div class="sketch-toolbar no-print" id="toolbar-${id}">
            <button class="sk-btn active" id="tool-pen-${id}"  onclick="Sketch.setTool(${id},'pen')">✏️ Draw</button>
            <button class="sk-btn"        id="tool-line-${id}" onclick="Sketch.setTool(${id},'line')">╱ Line</button>
            <button class="sk-btn"        id="tool-rect-${id}" onclick="Sketch.setTool(${id},'rect')">▭ Box</button>
            <button class="sk-btn"        id="tool-text-${id}" onclick="Sketch.setTool(${id},'text')">T Label</button>
            <div class="sk-sep"></div>
            <div class="colour-dots" id="colours-${id}">
              <div class="colour-dot active" style="background:#222222" onclick="Sketch.setColour(${id},'#222222',this)" title="Black"></div>
              <div class="colour-dot"        style="background:#c0392b" onclick="Sketch.setColour(${id},'#c0392b',this)" title="Red"></div>
              <div class="colour-dot"        style="background:#1a6eb5" onclick="Sketch.setColour(${id},'#1a6eb5',this)" title="Blue"></div>
              <div class="colour-dot"        style="background:#27ae60" onclick="Sketch.setColour(${id},'#27ae60',this)" title="Green"></div>
            </div>
            <div class="sk-sep"></div>
            <button class="sk-btn active" id="tool-straighten-${id}" onclick="Sketch.toggleStraighten(${id},this)" title="Snap hand-drawn lines to straight">⟋ Straighten</button>
            <div class="sk-sep"></div>
            <button class="sk-btn" onclick="Sketch.undo(${id})">↩ Undo</button>
            <button class="sk-btn" onclick="Sketch.clear(${id})">🗑 Clear</button>
            <div class="sk-sep"></div>
            <button class="sk-btn sk-fullscreen-btn" onclick="Sketch.openFullscreen(${id})">⛶ Full Screen</button>
          </div>
          <div class="canvas-wrap" id="canvas-wrap-${id}">
            <canvas id="canvas-${id}" class="room-canvas"></canvas>
          </div>
          <div class="sketch-dims" id="sketch-dims-${id}" style="display:none"></div>
        </div>

        <div class="notes-group">
          <label>Notes / Observations</label>
          <textarea id="rnotes-${id}" rows="3"
            placeholder="e.g. Alcove on left, sloped ceiling, skirting 100mm, customer wants open shelving…"></textarea>
        </div>

      </div>
    `;
  }

  /* ── Sketch dimension badges ── */
  function updateSketchDims(id) {
    const el = document.getElementById(`sketch-dims-${id}`);
    if (!el) return;
    const labels = Sketch.getShapes(id).filter(s => s.type === 'text' && s.text.trim());
    if (labels.length === 0) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    el.innerHTML = '<span class="sketch-dims-title">📐 From sketch</span>'
      + labels.map(s => `<span class="dim-badge">${s.text.trim()}</span>`).join('');
  }

  /* ── Actions ── */
  function clearAll() {
    if (!confirm('Start a new survey? This will clear all current data.')) return;
    localStorage.removeItem('lh_survey_v1');
    location.reload();
  }

  function print() {
    save(); // ensure latest state saved
    window.print();
  }

  /* ── Helpers ── */
  function gv(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
  }
  function sv(id, val) {
    const el = document.getElementById(id);
    if (el && val !== undefined && val !== null) el.value = val;
  }

  let toastTimer;
  function showToast(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent  = msg;
    t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.style.display = 'none', 2500);
  }

  /* ── Boot ── */
  document.addEventListener('DOMContentLoaded', init);

  return { addRoom, removeRoom, clearAll, print };
})();
