/* ══════════════════════════════════════════════
   survey.js — Quote / Order form logic
   Manages rooms, auto-save, load, print, share.
   Depends on: Sketch (sketch.js), html2canvas
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

    // Auto-calculate balance when total or deposit changes
    ['p-total', 'p-deposit'].forEach(fid => {
      const el = document.getElementById(fid);
      if (el) el.addEventListener('input', recalcBalance);
    });

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

  function recalcBalance() {
    const total   = parseFloat(document.getElementById('p-total')?.value)   || 0;
    const deposit = parseFloat(document.getElementById('p-deposit')?.value) || 0;
    const bal     = document.getElementById('p-balance');
    if (bal) bal.value = total > 0 ? (total - deposit).toFixed(2) : '';
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
        pricing: {
          total:   gv('p-total'),
          deposit: gv('p-deposit')
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

      const p = data.pricing || {};
      sv('p-total',   p.total);
      sv('p-deposit', p.deposit);
      recalcBalance();

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
    showToast('Wardrobe removed');
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
            <button class="sk-btn active" id="tool-pen-${id}"    onclick="Sketch.setTool(${id},'pen')">✏️ Draw</button>
            <button class="sk-btn"        id="tool-line-${id}"   onclick="Sketch.setTool(${id},'line')">╱ Line</button>
            <button class="sk-btn"        id="tool-rect-${id}"   onclick="Sketch.setTool(${id},'rect')">▭ Box</button>
            <button class="sk-btn"        id="tool-text-${id}"   onclick="Sketch.setTool(${id},'text')">T Label</button>
            <button class="sk-btn"        id="tool-eraser-${id}" onclick="Sketch.setTool(${id},'eraser')">✕ Erase</button>
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
    if (!confirm('Start a new quote / order? This will clear all current data.')) return;
    localStorage.removeItem('lh_survey_v1');
    location.reload();
  }

  function print() {
    save();
    window.print();
  }

  /* ── High-res canvas for print / share ── */
  // Target: 190 × 175 mm at 300 dpi
  const PRINT_W_PX = Math.round(190 / 25.4 * 300); // 2244
  const PRINT_H_PX = Math.round(175 / 25.4 * 300); // 2067

  function scaleCanvasForPrint(id) {
    const canvas = document.getElementById(`canvas-${id}`);
    if (!canvas || canvas._printScaled) return;
    const rect = canvas.getBoundingClientRect();
    canvas._origW = canvas.width;
    canvas._origH = canvas.height;
    canvas._origStyleW = canvas.style.width;
    canvas._origStyleH = canvas.style.height;
    canvas._printScaled = true;
    const scaleX = PRINT_W_PX / canvas.width;
    const scaleY = PRINT_H_PX / canvas.height;
    canvas.width  = PRINT_W_PX;
    canvas.height = PRINT_H_PX;
    canvas.style.width  = rect.width  + 'px';
    canvas.style.height = rect.height + 'px';
    Sketch.redrawScaled(id, scaleX, scaleY);
  }

  function restoreCanvas(id) {
    const canvas = document.getElementById(`canvas-${id}`);
    if (!canvas || !canvas._printScaled) return;
    canvas.width  = canvas._origW;
    canvas.height = canvas._origH;
    canvas.style.width  = canvas._origStyleW;
    canvas.style.height = canvas._origStyleH;
    delete canvas._origW;
    delete canvas._origH;
    delete canvas._origStyleW;
    delete canvas._origStyleH;
    delete canvas._printScaled;
    Sketch.redraw(id);
  }

  function prepareForPrint() {
    save();
    activeIds.forEach(scaleCanvasForPrint);
  }

  function restoreAfterPrint() {
    activeIds.forEach(restoreCanvas);
  }

  /* ── WhatsApp — image of the full sheet ── */
  const OFFICE_WA = '447308154580';

  function waPhone(raw) {
    let n = raw.replace(/\D/g, '');
    if (n.startsWith('00')) n = n.slice(2);
    else if (n.startsWith('0')) n = '44' + n.slice(1);
    return n;
  }

  async function captureSheet() {
    window.scrollTo(0, 0);
    // Scale canvases to high-res so the WhatsApp image is sharp
    activeIds.forEach(scaleCanvasForPrint);
    await new Promise(r => requestAnimationFrame(r));
    return await html2canvas(document.getElementById('app-wrap'), {
      scale:           2,
      useCORS:         true,
      allowTaint:      true,
      backgroundColor: '#ffffff',
      logging:         false,
      // onclone runs on a hidden DOM copy — we apply print styling there
      // so the live page is never touched
      onclone: (doc) => {
        // Remove all buttons / toolbars
        doc.querySelectorAll('.no-print').forEach(el => el.remove());
        doc.getElementById('toast')?.remove();

        // White page background
        doc.body.style.background = '#fff';
        doc.getElementById('app-wrap').style.background = '#fff';

        // Header: white with red underline (matches print CSS)
        const hdr = doc.querySelector('header');
        if (hdr) Object.assign(hdr.style, {
          background: '#fff', boxShadow: 'none',
          position: 'relative', height: 'auto',
          borderBottom: '2px solid #8b1a1a', padding: '8px 22px'
        });
        const lm = doc.querySelector('.logo-mark');
        if (lm) Object.assign(lm.style, { background: '#8b1a1a', width: '32px', height: '32px', fontSize: '12px' });
        const lt = doc.querySelector('.logo-text');
        if (lt) lt.style.color = '#1a1a1a';

        // Cards: flat white
        doc.querySelectorAll('.card, .room-card').forEach(el => {
          el.style.boxShadow = 'none';
          el.style.border = '1px solid #ddd';
        });
      }
    });
    activeIds.forEach(restoreCanvas);
  }

  function triggerDownload(canvas) {
    const a    = document.createElement('a');
    a.download = 'luxury-house-quote.jpg';
    a.href     = canvas.toDataURL('image/jpeg', 0.92);
    a.click();
  }

  async function shareSheet(waNumber) {
    if (typeof html2canvas === 'undefined') {
      showToast('Image library not ready — check connection');
      return;
    }
    save();
    showToast('Preparing sheet…');

    let canvas;
    try {
      canvas = await captureSheet();
    } catch (_) {
      showToast('Could not capture sheet');
      return;
    }

    canvas.toBlob(async blob => {
      const file = new File([blob], 'luxury-house-quote.jpg', { type: 'image/jpeg' });

      // On iPad / iPhone the native share sheet includes WhatsApp
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: 'Luxury House — Quote / Order' });
          return;
        } catch (err) {
          if (err.name === 'AbortError') return; // user cancelled
        }
      }

      // Desktop fallback: download the image, open the WhatsApp chat
      triggerDownload(canvas);
      if (waNumber) window.open(`https://wa.me/${waNumber}`, '_blank');
    }, 'image/jpeg', 0.92);
  }

  function sendToOffice() {
    shareSheet(OFFICE_WA);
  }

  function sendToCustomer() {
    const number = waPhone(gv('c-phone'));
    if (!number) { showToast("Enter customer's phone number first"); return; }
    shareSheet(number);
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
    t.textContent   = msg;
    t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.style.display = 'none', 2500);
  }

  /* ── Boot ── */
  document.addEventListener('DOMContentLoaded', () => {
    init();
    // High-res canvas before print, restore after
    window.onbeforeprint = prepareForPrint;
    window.onafterprint  = restoreAfterPrint;
    // iOS Safari fallback
    if (window.matchMedia) {
      const mq = window.matchMedia('print');
      const handler = e => { if (e.matches) prepareForPrint(); else restoreAfterPrint(); };
      if (mq.addEventListener) mq.addEventListener('change', handler);
      else mq.addListener(handler); // older Safari
    }
  });

  return { addRoom, removeRoom, clearAll, print, sendToOffice, sendToCustomer };
})();
