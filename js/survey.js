/* ══════════════════════════════════════════════
   survey.js — Quote / Order form logic
   Manages rooms, auto-save, load, print, share.
   Depends on: Sketch (sketch.js), html2canvas

   TABLE OF CONTENTS — grep the LABEL to jump straight there
   ──────────────────────────────────────────────
   SURVEY:INIT        Init — date, event listeners, load-or-create room
   SURVEY:AUTOSAVE    Auto-save — scheduleSave, recalcBalance, save → localStorage
   SURVEY:LOAD        Load — restore customer / rooms / shapes from localStorage
   SURVEY:ROOMS       Rooms — addRoom, removeRoom, updateSingleRoomClass
   SURVEY:TEMPLATE    Room HTML template — buildRoomHTML
   SURVEY:SKETCHDIMS  Sketch dimension badges — updateSketchDims
   SURVEY:ACTIONS     Actions — clearAll, print (sets PDF filename from address)
   SURVEY:PRINTENGINE Print engine — scaleCanvasForPrint, restoreCanvas,
                        prepareForPrint, restoreAfterPrint  ⚠ DO NOT MODIFY
   SURVEY:CAPTURE     Image capture — waPhone, captureSheet, triggerDownload, shareSheet
   SURVEY:SEND        Send flows — sendToOffice, captureAndDownload, sendToCustomer
   SURVEY:DOORTYPE    Door type toggle — setDoorType (hinged / sliding rows)
   SURVEY:HELPERS     Helpers — gv, sv, showToast
   SURVEY:BOOT        Boot — DOMContentLoaded, print event wiring
   SURVEY:EXPORTS     Exports — public API returned to window.Survey
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
          name:     gv('c-first'),
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
          doorType:  gv(`dtype-${id}`),
          doorStyle: gv(`dstyle-${id}`),
          doorSlide: gv(`dslide-${id}`),
          doorFrame: gv(`dframe-${id}`),
          notes:     gv(`rnotes-${id}`),
          shapes: Sketch.getShapes(id)
        }))
      };
      localStorage.setItem('lh_survey_v1', JSON.stringify(data));
    } catch (e) {
      if (e && e.name === 'QuotaExceededError') {
        showToast('⚠ Storage full — could not auto-save');
      }
    }
  }

  /* ── Load ── */
  function load() {
    try {
      const raw = localStorage.getItem('lh_survey_v1');
      if (!raw) return false;
      const data = JSON.parse(raw);

      const c = data.customer || {};
      sv('c-first',    c.name || c.first);
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
        sv(`dstyle-${id}`, r.doorStyle);
        sv(`dslide-${id}`, r.doorSlide);
        sv(`dframe-${id}`, r.doorFrame);
        sv(`rnotes-${id}`, r.notes);
        setDoorType(id, r.doorType || 'hinged');
        // Defer shape load until canvas is sized
        requestAnimationFrame(() => { Sketch.setShapes(id, r.shapes); updateSketchDims(id); });
      });

      return (data.rooms && data.rooms.length > 0);
    } catch (_) {
      return false;
    }
  }

  /* ── Single-room class (drives print flex chain — replaces :has() for Safari compat) ── */
  function updateSingleRoomClass() {
    document.body.classList.toggle('single-room', activeIds.length === 1);
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

    updateSingleRoomClass();
    save(); // persist immediately so Orders.save() always includes the new room
    return id;
  }

  function removeRoom(id) {
    const el = document.getElementById(`room-card-${id}`);
    if (el) el.remove();
    const i = activeIds.indexOf(id);
    if (i !== -1) activeIds.splice(i, 1);
    updateSingleRoomClass();
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

        <input type="hidden" id="dtype-${id}" value="hinged">

        <div class="door-type-row no-print">
          <span class="ds-label">Door Type</span>
          <div class="door-type-btns">
            <button class="dtype-btn active" id="dtype-hinged-${id}"  onclick="Survey.setDoorType(${id},'hinged')">Hinged</button>
            <button class="dtype-btn"        id="dtype-sliding-${id}" onclick="Survey.setDoorType(${id},'sliding')">Sliding</button>
          </div>
        </div>

        <div class="door-style-row" id="ds-hinged-${id}">
          <span class="ds-label">Style</span>
          <input type="text" id="dstyle-${id}" placeholder="e.g. Glacier High Gloss White" autocomplete="off">
        </div>

        <div class="door-style-row" id="ds-sliding-${id}" style="display:none">
          <span class="ds-label">Collection</span>
          <input type="text" id="dslide-${id}" placeholder="e.g. Venice" autocomplete="off">
          <span class="ds-label ds-label-gap">Frame</span>
          <input type="text" id="dframe-${id}" placeholder="e.g. Polished Silver" autocomplete="off">
        </div>

        <div class="sketch-section">
          <div class="sketch-label">✏️ Sketch / Measurements</div>
          <div class="sketch-toolbar no-print" id="toolbar-${id}">
            <!-- Drawing tools -->
            <button class="sk-btn sk-tool-btn active" id="tool-pen-${id}"    onclick="Sketch.setTool(${id},'pen')"    title="Freehand draw">Pen</button>
            <button class="sk-btn sk-tool-btn"        id="tool-select-${id}" onclick="Sketch.setTool(${id},'select')" title="Select &amp; move shapes">Select</button>
            <button class="sk-btn sk-tool-btn"        id="tool-line-${id}"   onclick="Sketch.setTool(${id},'line')"   title="Draw straight line">Line</button>
            <button class="sk-btn sk-tool-btn"        id="tool-rect-${id}"   onclick="Sketch.setTool(${id},'rect')"   title="Draw rectangle">Box</button>
            <button class="sk-btn sk-tool-btn"        id="tool-text-${id}"   onclick="Sketch.setTool(${id},'text')"   title="Add text annotation">Text</button>
            <div class="sk-sep"></div>
            <!-- Colours -->
            <div class="colour-dots" id="colours-${id}">
              <div class="colour-dot active" style="background:#222222" onclick="Sketch.setColour(${id},'#222222',this)" title="Black"></div>
              <div class="colour-dot"        style="background:#c0392b" onclick="Sketch.setColour(${id},'#c0392b',this)" title="Red"></div>
              <div class="colour-dot"        style="background:#1a6eb5" onclick="Sketch.setColour(${id},'#1a6eb5',this)" title="Blue"></div>
              <div class="colour-dot"        style="background:#27ae60" onclick="Sketch.setColour(${id},'#27ae60',this)" title="Green"></div>
            </div>
            <div class="sk-sep"></div>
            <!-- Furniture + shape modifiers -->
            <button class="sk-btn sk-tpl-btn"     onclick="Sketch.insertTemplate(${id},'4door')"  title="Insert 4-door wardrobe">▭ 4-Door</button>
            <button class="sk-btn sk-tpl-btn"     onclick="Sketch.insertTemplate(${id},'corner')" title="Insert L-corner wardrobe">⌐ Corner</button>
            <button class="sk-btn sk-tpl-btn"     onclick="Sketch.insertTemplate(${id},'chest')"  title="Insert chest of drawers">▤ Chest</button>
            <button class="sk-btn sk-tpl-btn"     onclick="Sketch.insertTemplate(${id},'desk')"   title="Insert desk with 2 drawers">▭ Desk</button>
            <button class="sk-btn sk-section-btn" onclick="Sketch.removeSection(${id})"           title="Remove door/drawer">–</button>
            <button class="sk-btn sk-section-btn" onclick="Sketch.addSection(${id})"              title="Add door/drawer">+</button>
            <button class="sk-btn sk-section-btn" onclick="Sketch.flipCorner(${id})"              title="Flip corner or desk pedestal">⇄ Flip</button>
            <div class="sk-sep"></div>
            <!-- Measurements — always grouped -->
            <button class="sk-btn sk-meas-btn" onclick="Sketch.insertMeasurement(${id},'Width','W')"  title="Add Width label">↔ Width</button>
            <button class="sk-btn sk-meas-btn" onclick="Sketch.insertMeasurement(${id},'Height','H')" title="Add Height label">↕ Height</button>
            <button class="sk-btn sk-meas-btn" onclick="Sketch.insertMeasurement(${id},'Deep','D')"   title="Add Deep label">⬛ Deep</button>
            <div class="sk-sep"></div>
            <!-- Erase / Undo / Delete / Full Screen — right side -->
            <button class="sk-btn sk-tool-btn" id="tool-eraser-${id}" onclick="Sketch.setTool(${id},'eraser')" title="Erase freehand strokes">Erase</button>
            <button class="sk-btn sk-undo-btn"
              onpointerdown="Sketch._undoClearDown(this,${id})"
              onpointerup="Sketch._undoClearUp(this,${id})"
              onpointercancel="Sketch._undoClearCancel(this,${id})"
              oncontextmenu="return false"
              title="Undo (tap) • Hold to clear all">↩ Undo</button>
            <button class="sk-btn sk-del-btn"        onclick="Sketch.deleteSelected(${id})"                 title="Delete selected shape">✕ Del</button>
            <button class="sk-btn sk-fullscreen-btn" onclick="Sketch.openFullscreen(${id})"                 title="Open fullscreen sketch editor">⛶ Full</button>
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
    localStorage.removeItem('lh_order_id');
    localStorage.removeItem('lh_order_version');
    location.reload();
  }

  function print() {
    save();
    const addr  = gv('c-address');
    const label = addr || gv('c-first') || '';
    const prevTitle = document.title;
    if (label) document.title = label;
    prepareForPrint();
    // 300ms lets the browser commit all DOM/style changes before the print dialog opens.
    // onbeforeprint will also fire (and prepareForPrint runs again, harmlessly).
    setTimeout(function() {
      window.print();
      if (label) document.title = prevTitle;
    }, 300);
  }

  /* ── High-res canvas for print / share ── */
  // Target: 190 × 150 mm at 300 dpi
  const PRINT_W_PX = Math.round(190 / 25.4 * 300); // 2244
  const PRINT_H_PX = Math.round(150 / 25.4 * 300); // 1772

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
    if (activeIds.length === 1) {
      const c = document.getElementById(`canvas-${activeIds[0]}`);
      if (c) c.style.setProperty('height', '150mm', 'important');
      // Also lock the canvas-wrap so layout height is controlled even if canvas CSS fails
      const w = document.getElementById(`canvas-wrap-${activeIds[0]}`);
      if (w) w.style.setProperty('height', '150mm', 'important');
    }
  }

  function restoreAfterPrint() {
    if (activeIds.length === 1) {
      const c = document.getElementById(`canvas-${activeIds[0]}`);
      if (c) c.style.removeProperty('height');
      const w = document.getElementById(`canvas-wrap-${activeIds[0]}`);
      if (w) w.style.removeProperty('height');
    }
    activeIds.forEach(restoreCanvas);
  }

  /* ── WhatsApp — image of the full sheet ── */
  function waPhone(raw) {
    let n = raw.replace(/\D/g, '');
    if (n.startsWith('00')) n = n.slice(2);
    else if (n.startsWith('0')) n = '44' + n.slice(1);
    return n;
  }

  async function captureSheet() {
    window.scrollTo(0, 0);
    activeIds.forEach(scaleCanvasForPrint);
    await new Promise(r => requestAnimationFrame(r));
    try {
      return await html2canvas(document.getElementById('app-wrap'), {
        scale:           2,
        useCORS:         true,
        backgroundColor: '#ffffff',
        logging:         false,
        onclone: (doc) => {
          doc.querySelectorAll('.no-print').forEach(el => el.remove());
          doc.getElementById('toast')?.remove();
          doc.body.style.background = '#fff';
          doc.getElementById('app-wrap').style.background = '#fff';
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
          doc.querySelectorAll('.card, .room-card').forEach(el => {
            el.style.boxShadow = 'none';
            el.style.border = '1px solid #ddd';
          });
        }
      });
    } finally {
      activeIds.forEach(restoreCanvas); // always restore even if html2canvas throws
    }
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
    // Open WhatsApp with office contact synchronously (must be tied to user gesture
    // or iOS/Android will block the popup). Then capture + download image in background.
    window.open(`https://wa.me/${AppData.OFFICE_WA}`, '_blank');
    captureAndDownload();
  }

  async function captureAndDownload() {
    if (typeof html2canvas === 'undefined') {
      showToast('Image library not ready — check connection');
      return;
    }
    save();
    showToast('Saving image…');
    let canvas;
    try {
      canvas = await captureSheet();
    } catch (_) {
      activeIds.forEach(restoreCanvas);
      showToast('Could not capture sheet');
      return;
    }
    activeIds.forEach(restoreCanvas); // captureSheet scales canvases; always restore after
    triggerDownload(canvas);
    showToast('Image saved — attach it in WhatsApp ✓');
  }

  function sendToCustomer() {
    const number = waPhone(gv('c-phone'));
    if (!number) { showToast("Enter customer's phone number first"); return; }
    window.open(`https://wa.me/${number}`, '_blank');
    captureAndDownload();
  }

  /* ── Door type toggle ── */
  function setDoorType(id, type) {
    document.getElementById(`dtype-hinged-${id}`)?.classList.toggle('active', type === 'hinged');
    document.getElementById(`dtype-sliding-${id}`)?.classList.toggle('active', type === 'sliding');
    const hingedRow  = document.getElementById(`ds-hinged-${id}`);
    const slidingRow = document.getElementById(`ds-sliding-${id}`);
    if (hingedRow)  hingedRow.style.display  = type === 'hinged'  ? '' : 'none';
    if (slidingRow) slidingRow.style.display = type === 'sliding' ? '' : 'none';
    const inp = document.getElementById(`dtype-${id}`);
    if (inp) inp.value = type;
    scheduleSave();
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

  return {
    addRoom, removeRoom, clearAll, print, sendToOffice, sendToCustomer, setDoorType,
    toast: showToast,          // used by orders.js
    captureSheet               // used by orders.js (email)
  };
})();
