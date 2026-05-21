/* ══════════════════════════════════════════════
   orders.js — Order save / load / email
   Depends on: data.js, survey.js
══════════════════════════════════════════════ */

const Orders = (() => {

  let allOrders    = [];
  let pendingOrders = JSON.parse(localStorage.getItem('lh_pending_orders') || '[]');
  let filterStatus = '';
  let searchTerm   = '';

  /* ── Order ID ────────────────────────────── */
  function generateId() {
    const d    = new Date();
    const yy   = String(d.getFullYear()).slice(-2);
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `LH${yy}${mm}-${rand}`;
  }

  function currentOrderId() {
    let id = localStorage.getItem('lh_order_id');
    if (!id) { id = generateId(); localStorage.setItem('lh_order_id', id); }
    return id;
  }

  function nextVersion() {
    const v = parseInt(localStorage.getItem('lh_order_version') || '0') + 1;
    localStorage.setItem('lh_order_version', String(v));
    return v;
  }

  /* ── Save to Google Sheets ───────────────── */
  // Form submission to a hidden iframe — completely bypasses iOS Safari
  // CORS/fetch restrictions. Form posts are never blocked cross-origin.
  // Apps Script receives it as a text/plain body prefixed with "_=".
  function saveToSheets(payload) {
    if (!AppData.SHEETS_URL) return;

    let fr = document.getElementById('_lhFr');
    if (!fr) {
      fr = document.createElement('iframe');
      fr.id = fr.name = '_lhFr';
      fr.style.display = 'none';
      document.body.appendChild(fr);
    }

    const form = document.createElement('form');
    form.method  = 'POST';
    form.action  = AppData.SHEETS_URL;
    form.target  = '_lhFr';
    form.enctype = 'text/plain';
    form.style.display = 'none';

    const inp = document.createElement('input');
    inp.type  = 'hidden';
    inp.name  = '_';
    inp.value = JSON.stringify(payload);
    form.appendChild(inp);

    document.body.appendChild(form);
    form.submit();
    setTimeout(() => { if (form.parentNode) form.parentNode.removeChild(form); }, 5000);
  }

  /* ── Build Drive archive image (no html2canvas — works on iOS Safari) ── */
  function buildOrderImage(payload) {
    const W = 600, PAD = 24;
    let y = 0;

    // Parse rooms from fullData; also grab live sketch canvases from DOM
    let rooms = [];
    try { rooms = JSON.parse(payload.fullData || '{}').rooms || []; } catch (_) {}
    const canvasEls = Array.from(document.querySelectorAll('[id^="canvas-"]'));

    const SKETCH_H  = 150;
    const roomBlock = rooms.length * (26 + (canvasEls.length ? SKETCH_H + 10 : 0) + 16);
    const totalH    = Math.min(64 + 110 + roomBlock + 90 + PAD, 1600);

    const out = document.createElement('canvas');
    out.width  = W;
    out.height = Math.max(totalH, 400);
    const ctx  = out.getContext('2d');

    // White background
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, out.height);

    // Red header bar
    ctx.fillStyle = '#8b1a1a';
    ctx.fillRect(0, 0, W, 64);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 22px Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('LUXURY HOUSE', PAD, 32);
    ctx.font = '12px Arial, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(payload.orderId || '', W - PAD, 25);
    ctx.fillText(payload.savedAt ? new Date(payload.savedAt).toLocaleDateString('en-GB') : '', W - PAD, 42);
    ctx.textAlign = 'left';

    y = 80;

    // Customer details
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 17px Arial, sans-serif';
    ctx.fillText(payload.customer || '', PAD, y); y += 24;
    ctx.font = '13px Arial, sans-serif';
    ctx.fillStyle = '#666';
    if (payload.property) { ctx.fillText(payload.property, PAD, y); y += 19; }
    if (payload.phone)    { ctx.fillText(payload.phone,    PAD, y); y += 19; }
    if (payload.rep)      { ctx.fillText('Rep: ' + payload.rep, PAD, y); y += 19; }

    // Divider
    y += 6;
    ctx.strokeStyle = '#ddd'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
    y += 14;

    // Rooms + sketch canvases
    rooms.forEach((room, i) => {
      ctx.fillStyle = '#1a1a1a';
      ctx.font = 'bold 14px Arial, sans-serif';
      const label = (room.name || ('Room ' + (i + 1))) +
                    (room.w && room.h ? '   ' + room.w + ' × ' + room.h + 'mm' : '');
      ctx.fillText(label, PAD, y); y += 22;

      const rc = canvasEls[i];
      if (rc && canvasEls.length) {
        try {
          const scale = Math.min((W - PAD * 2) / rc.width, SKETCH_H / rc.height, 1);
          ctx.drawImage(rc, PAD, y, rc.width * scale, rc.height * scale);
        } catch (_) {}
        y += SKETCH_H + 10;
      }
      y += 6;
    });

    // Divider + pricing
    ctx.strokeStyle = '#ddd';
    ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
    y += 14;
    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 16px Arial, sans-serif';
    if (payload.total)   { ctx.fillText('Total:    £' + payload.total,   PAD, y); y += 22; }
    ctx.font = '13px Arial, sans-serif';
    ctx.fillStyle = '#666';
    if (payload.deposit) { ctx.fillText('Deposit:  £' + payload.deposit, PAD, y); y += 19; }
    if (payload.balance) { ctx.fillText('Balance:  £' + payload.balance, PAD, y); }

    return out;
  }

  /* ── Public: save current quote ─────────── */
  async function save() {
    const raw = localStorage.getItem('lh_survey_v1');
    if (!raw) { Survey.toast('Nothing to save yet'); return; }

    const data    = JSON.parse(raw);
    const orderId = currentOrderId();
    const version = nextVersion();

    const rooms = (data.rooms || [])
      .map(r => [r.name, r.w && r.h ? `${r.w}×${r.h}mm` : ''].filter(Boolean).join(' '))
      .join(' | ');

    const doorNo  = data.customer?.door    || '';
    const address = data.customer?.address || '';

    // Google Sheets has a 50,000 char cell limit.
    // If fullData is too large (detailed sketches), strip shapes so the
    // order info saves reliably. The sketch stays on this device in localStorage.
    let fullData = raw;
    if (fullData.length > 44000) {
      try {
        const obj = JSON.parse(fullData);
        (obj.rooms || []).forEach(r => { r.shapes = []; });
        fullData = JSON.stringify(obj);
      } catch (_) { fullData = ''; }
    }

    const payload = {
      orderId,
      property: [doorNo, address].filter(Boolean).join(' '),
      version,
      savedAt:  new Date().toISOString(),
      status:   'Quote',
      rep:      data.customer?.surveyor   || '',
      customer: `${data.customer?.first || ''} ${data.customer?.last || ''}`.trim(),
      phone:    data.customer?.phone      || '',
      doorNo,
      address,
      rooms,
      total:    data.pricing?.total       || '',
      deposit:  data.pricing?.deposit     || '',
      balance:  data.pricing?.balance     || '',
      fullData
    };

    Survey.toast('Saving…');

    // Build the local order record first — used for both the in-memory list
    // and the pendingOrders cache so it survives if the POST doesn't reach Sheets.
    const localOrder = {
      'Order ID': orderId,  'Property': payload.property,
      'Saved At': payload.savedAt, 'Version': String(version),
      'Status':   'Quote',  'Rep':      payload.rep,
      'Customer': payload.customer, 'Phone':    payload.phone,
      'Door No':  payload.doorNo,   'Address':  payload.address,
      'Rooms':    payload.rooms,    'Total £':  payload.total,
      'Deposit £': payload.deposit, 'Balance £': payload.balance,
      'Full Data': payload.fullData
    };

    // Persist locally so the order is ALWAYS visible even if the POST fails
    // or the next JSONP refresh returns an empty sheet.
    pendingOrders = pendingOrders.filter(p => p['Order ID'] !== orderId);
    pendingOrders.unshift(localOrder);
    if (pendingOrders.length > 50) pendingOrders = pendingOrders.slice(0, 50);
    localStorage.setItem('lh_pending_orders', JSON.stringify(pendingOrders));

    allOrders = allOrders.filter(o => o['Order ID'] !== orderId);
    allOrders.unshift(localOrder);
    const panel = document.getElementById('orders-overlay');
    if (panel && panel.classList.contains('open')) renderList();

    if (!AppData.SHEETS_URL) {
      Survey.toast('Add your Google Sheets URL to js/data.js first');
    } else {
      Survey.toast(`Saved — ${orderId} v${version}`);
    }

    // Step 1 — text POST (form+iframe, fire-and-forget).
    saveToSheets(payload);

    // Step 2 — Drive image, best-effort separate POST.
    try {
      const img = buildOrderImage(payload);
      saveToSheets({
        orderId,
        property:  payload.property,
        savedAt:   payload.savedAt,
        imageOnly: true,
        imageData: img.toDataURL('image/jpeg', 0.4)
      });
    } catch (_) {}
  }

  /* ── Load orders from Sheets (JSONP — bypasses CORS) ── */
  function fetchOrders() {
    if (!AppData.SHEETS_URL) return Promise.resolve([]);
    return new Promise(resolve => {
      const cbName = 'lhCb' + Date.now();
      const script = document.createElement('script');
      const timer  = setTimeout(() => { cleanup(); resolve(null); }, 10000);

      const cleanup = () => {
        clearTimeout(timer);
        delete window[cbName];
        if (script.parentNode) script.parentNode.removeChild(script);
      };

      window[cbName] = data => {
        cleanup();
        resolve(Array.isArray(data.orders) ? data.orders : null);
      };

      script.onerror = () => { cleanup(); resolve(null); };
      script.src = AppData.SHEETS_URL + '?callback=' + cbName;
      document.head.appendChild(script);
    });
  }

  /* ── Orders panel ────────────────────────── */
  function openPanel() {
    const el = document.getElementById('orders-overlay');
    if (!el) return;
    el.classList.add('open');
    document.body.style.overflow = 'hidden';
    refresh();
  }

  function closePanel() {
    const el = document.getElementById('orders-overlay');
    if (el) el.classList.remove('open');
    document.body.style.overflow = '';
  }

  async function refresh() {
    const list = document.getElementById('orders-list');
    if (!list) return;

    if (!AppData.SHEETS_URL) {
      list.innerHTML = `
        <div class="orders-empty">
          <strong>Google Sheets not connected yet.</strong><br><br>
          1. Deploy the script from <code>setup/google-apps-script.js</code><br>
          2. Paste the Web App URL into <code>js/data.js → SHEETS_URL</code>
        </div>`;
      return;
    }

    // Show locally-known orders immediately — don't make the user wait for JSONP.
    // Merge pendingOrders into allOrders and render right away.
    const pre = allOrders.slice();
    pendingOrders.forEach(p => {
      if (!pre.some(r => r['Order ID'] === p['Order ID'])) pre.unshift(p);
    });
    if (pre.length) {
      allOrders = pre;
      renderList();
    } else {
      list.innerHTML = '<div class="orders-loading">Loading orders…</div>';
    }

    // Fetch from Sheets in the background and merge when it arrives.
    const result = await fetchOrders();

    if (result === null) {
      // JSONP timed out — keep showing what we already rendered above.
      if (!allOrders.length) {
        list.innerHTML = '<div class="orders-empty">⚠️ Could not load orders from Google Sheets — check your internet connection, then tap <strong>↻ Refresh</strong> to try again.</div>';
      }
      return;
    }

    // Remove confirmed orders from pendingOrders.
    pendingOrders = pendingOrders.filter(p =>
      !result.some(r => r['Order ID'] === p['Order ID'] && Number(r['Version']) >= Number(p['Version']))
    );
    localStorage.setItem('lh_pending_orders', JSON.stringify(pendingOrders));

    // Merge: sheet rows + any unconfirmed local saves.
    const merged = result.slice();
    pendingOrders.forEach(p => {
      if (!merged.some(r => r['Order ID'] === p['Order ID'])) merged.unshift(p);
    });
    allOrders = merged;
    renderList();
  }

  function renderList() {
    const list = document.getElementById('orders-list');
    if (!list) return;

    let orders = allOrders.slice();

    if (filterStatus) orders = orders.filter(o => o['Status'] === filterStatus);
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      orders = orders.filter(o =>
        (o['Customer'] || '').toLowerCase().includes(q) ||
        (o['Address']  || '').toLowerCase().includes(q) ||
        (o['Order ID'] || '').toLowerCase().includes(q) ||
        (o['Rep']      || '').toLowerCase().includes(q)
      );
    }

    // Keep only the latest version per order ID
    const byId = {};
    orders.forEach(o => {
      const id  = o['Order ID'];
      const ver = Number(o['Version'] || 0);
      if (!byId[id] || ver > Number(byId[id]['Version'] || 0)) byId[id] = o;
    });

    const latest = Object.values(byId).sort((a, b) =>
      new Date(b['Saved At'] || 0) - new Date(a['Saved At'] || 0)
    );

    if (!latest.length) {
      list.innerHTML = '<div class="orders-empty">No orders match your search.</div>';
      return;
    }

    list.innerHTML = latest.map(o => {
      const sc = o['Status'] === 'Order' ? 'status-order'
               : o['Status'] === 'Installed' ? 'status-installed'
               : 'status-quote';
      const total    = o['Total £'] ? `£${o['Total £']}` : '—';
      const date     = fmtDate(o['Saved At']);
      const addr     = [o['Door No'], o['Address']].filter(Boolean).join(' ');
      const hasData  = !!(o['Full Data']);
      const rowStyle = hasData ? '' : 'opacity:0.6';
      const noData   = hasData ? '' : '<span class="order-no-data">⚠ resave to enable loading</span>';
      return `
        <div class="order-row" style="${rowStyle}" onclick="Orders.loadOrder('${(o['Order ID']||'').replace(/'/g,"\\'")}')">
          <div class="order-id-badge">${o['Order ID'] || '—'}</div>
          <div class="order-main">
            <div class="order-customer">${o['Customer'] || '—'}</div>
            <div class="order-addr">${addr || '—'}</div>
            <div class="order-rooms">${o['Rooms'] || ''}${noData}</div>
          </div>
          <div class="order-side">
            <div class="order-price">${total}</div>
            <div class="order-date">${date}</div>
            <div class="order-rep">${o['Rep'] || ''}</div>
            <span class="order-status ${sc}">${o['Status'] || 'Quote'}</span>
          </div>
        </div>`;
    }).join('');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
    } catch (_) { return ''; }
  }

  function setFilter(status, btn) {
    filterStatus = status;
    document.querySelectorAll('.ofilter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderList();
  }

  function setSearch(val) {
    searchTerm = val;
    renderList();
  }

  /* ── Load an order into the form ─────────── */
  function loadOrder(orderId) {
    const versions = allOrders
      .filter(o => o['Order ID'] === orderId)
      .sort((a, b) => Number(b['Version'] || 0) - Number(a['Version'] || 0));

    if (!versions.length) { Survey.toast('Order not found'); return; }

    const fullData = versions[0]['Full Data'];
    if (!fullData) {
      Survey.toast('This order was saved with an older version — resave it from the form to enable loading');
      return;
    }

    const customer = versions[0]['Customer'] || orderId;
    if (!confirm(`Load order for ${customer}?\n\nThis will replace everything on the current form.`)) return;

    try {
      localStorage.setItem('lh_survey_v1',    fullData);
      localStorage.setItem('lh_order_id',     orderId);
      localStorage.setItem('lh_order_version', String(versions[0]['Version'] || 1));
      location.reload();
    } catch (_) {
      Survey.toast('Could not restore order — please try again');
    }
  }

  /* ── Email quote via EmailJS ─────────────── */
  async function sendEmail() {
    const emailEl = document.getElementById('c-email');
    const email   = emailEl ? emailEl.value.trim() : '';
    if (!email) { Survey.toast('Enter customer email address first'); return; }

    if (!AppData.EMAILJS_SERVICE) {
      Survey.toast('EmailJS not set up — see js/data.js');
      return;
    }

    Survey.toast('Preparing email…');

    try {
      const canvas = await Survey.captureSheet();
      canvas.toBlob(async blob => {
        const reader = new FileReader();
        reader.onloadend = async () => {
          try {
            emailjs.init(AppData.EMAILJS_PUBLIC);
            await emailjs.send(AppData.EMAILJS_SERVICE, AppData.EMAILJS_TEMPLATE, {
              to_email:    email,
              to_name:     document.getElementById('c-first')?.value  || 'Customer',
              rep_name:    document.getElementById('surveyor')?.value  || 'Luxury House',
              address:     document.getElementById('c-address')?.value || '',
              quote_date:  document.getElementById('survey-date')?.value || new Date().toLocaleDateString('en-GB'),
              quote_image: reader.result
            });
            Survey.toast('Quote emailed successfully ✓');
          } catch (err) {
            Survey.toast('Email failed — check EmailJS credentials in data.js');
          }
        };
        reader.readAsDataURL(blob);
      }, 'image/jpeg', 0.45);
    } catch (_) {
      Survey.toast('Could not capture quote image');
    }
  }

  /* ── Boot ────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', () => {
    // Clear order ID when starting a new quote
    const orig = Survey.clearAll;
    // Wire up search input
    const si = document.getElementById('orders-search-input');
    if (si) si.addEventListener('input', e => setSearch(e.target.value));
  });

  return { save, openPanel, closePanel, setFilter, setSearch, loadOrder, sendEmail, refresh };
})();
