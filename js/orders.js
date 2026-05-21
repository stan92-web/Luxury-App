/* ══════════════════════════════════════════════
   orders.js — Order save / load / email
   Depends on: data.js, survey.js
══════════════════════════════════════════════ */

const Orders = (() => {

  let allOrders     = [];
  let pendingOrders = JSON.parse(localStorage.getItem('lh_pending_orders') || '[]');
  let filterStatus  = '';
  let searchTerm    = '';
  const sessionSaved = []; // orders saved this page session — never wiped by JSONP

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

  /* ── Save order text data (JSONP GET — same mechanism as load, works on iOS) ── */
  // Sketch shapes are stripped so the payload stays small enough for a URL.
  // Room config, measurements, options and pricing are all preserved so orders
  // can be loaded from any device.
  function saveToSheets(payload) {
    if (!AppData.SHEETS_URL) return;

    let fullData = payload.fullData || '';
    if (fullData) {
      try {
        const stripped = JSON.parse(fullData);
        (stripped.rooms || []).forEach(r => { r.shapes = []; });
        fullData = JSON.stringify(stripped);
      } catch (_) { fullData = ''; }
    }

    const summary = {
      orderId:  payload.orderId,
      property: payload.property,
      version:  payload.version,
      savedAt:  payload.savedAt,
      status:   payload.status,
      rep:      payload.rep,
      customer: payload.customer,
      phone:    payload.phone,
      doorNo:   payload.doorNo,
      address:  payload.address,
      rooms:    payload.rooms,
      total:    payload.total,
      deposit:  payload.deposit,
      balance:  payload.balance,
      fullData
    };

    // Drop fullData if keeping it would push the URL past Google's practical limit.
    // The row still saves (customer, address, price) — just without the reload payload.
    const encodedFull    = encodeURIComponent(JSON.stringify(summary));
    const wouldBeLen     = AppData.SHEETS_URL.length + 15 + encodedFull.length + 30;
    const encodedData    = wouldBeLen > 7000
      ? encodeURIComponent(JSON.stringify({ ...summary, fullData: '' }))
      : encodedFull;

    const cbName = 'lhSv' + Date.now();
    const script = document.createElement('script');
    const timer  = setTimeout(() => {
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }, 15000);

    window[cbName] = result => {
      clearTimeout(timer);
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
      // Do NOT remove from pendingOrders here.  There is a race condition where
      // fetchOrders can run concurrently (Apps Script parallel executions) and
      // read the sheet before this write is committed.  If we cleared
      // pendingOrders now and that concurrent read returned an empty sheet,
      // allOrders would be wiped and the order would disappear.
      // pendingOrders is cleaned up by refresh() once fetchOrders confirms the
      // row is present — which happens on the next panel open.
    };

    script.onerror = () => {
      clearTimeout(timer);
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    script.src = AppData.SHEETS_URL
      + '?action=save'
      + '&data='     + encodedData
      + '&callback=' + cbName;

    document.head.appendChild(script);
  }

  /* ── Save Drive image via JSONP GET (same mechanism as text save) ── */
  // imageData is converted to base64url (RFC 4648 §5) before being placed in
  // the URL.  Base64url uses only A-Z a-z 0-9 - _ characters, all of which are
  // already URL-safe, so encodeURIComponent is not needed and the payload stays
  // the same size as the base64 string (no 3× inflation).
  // Apps Script decodes it back to standard base64 before Utilities.base64Decode.
  function saveDriveImage(payload, imageData) {
    if (!AppData.SHEETS_URL || !imageData) return;

    // Strip the data-URI prefix and convert to base64url
    const b64url = imageData
      .replace(/^data:image\/(jpeg|png);base64,/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const url = AppData.SHEETS_URL
      + '?action=saveImage'
      + '&orderId='   + encodeURIComponent(payload.orderId  || '')
      + '&property='  + encodeURIComponent(payload.property || '')
      + '&savedAt='   + encodeURIComponent(payload.savedAt  || '')
      + '&imageData=' + b64url
      + '&callback='; // callback name appended below

    // Bail out if the final URL would exceed Google Apps Script's practical limit
    const cbName = 'lhImg' + Date.now();
    if ((url + cbName).length > 7000) return;

    const script = document.createElement('script');
    const timer  = setTimeout(() => {
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }, 20000);

    window[cbName] = () => {
      clearTimeout(timer);
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    script.onerror = () => {
      clearTimeout(timer);
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    script.src = url + cbName;
    document.head.appendChild(script);
  }

  /* ── Build Drive archive image ── */
  // Tiny canvas so the base64url string fits in a JSONP GET URL (<7 KB).
  // 180 px wide keeps typical output around 1–2 KB base64 at 4% JPEG quality.
  function buildOrderImage(payload) {
    const W = 180, PAD = 10;
    let y = 0;

    let rooms = [];
    try { rooms = JSON.parse(payload.fullData || '{}').rooms || []; } catch (_) {}

    const rowH   = rooms.length * 16;
    const totalH = Math.min(40 + 70 + rowH + 50 + PAD, 300);

    const out = document.createElement('canvas');
    out.width  = W;
    out.height = Math.max(totalH, 160);
    const ctx  = out.getContext('2d');

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, out.height);

    ctx.fillStyle = '#8b1a1a';
    ctx.fillRect(0, 0, W, 36);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('LUXURY HOUSE', PAD, 18);
    ctx.font = '8px Arial, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(payload.orderId || '', W - PAD, 13);
    ctx.fillText(payload.savedAt ? new Date(payload.savedAt).toLocaleDateString('en-GB') : '', W - PAD, 24);
    ctx.textAlign = 'left';

    y = 44;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 9px Arial, sans-serif';
    ctx.fillText(payload.customer || '', PAD, y); y += 13;
    ctx.font = '8px Arial, sans-serif';
    ctx.fillStyle = '#666';
    if (payload.property) { ctx.fillText(payload.property, PAD, y); y += 11; }
    if (payload.phone)    { ctx.fillText(payload.phone,    PAD, y); y += 11; }
    if (payload.rep)      { ctx.fillText('Rep: ' + payload.rep, PAD, y); y += 11; }

    y += 4;
    ctx.strokeStyle = '#ddd'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
    y += 7;

    rooms.forEach((room, i) => {
      ctx.fillStyle = '#333';
      ctx.font = '8px Arial, sans-serif';
      const label = (room.name || ('Room ' + (i + 1)))
        + (room.w && room.h ? '  ' + room.w + '×' + room.h + 'mm' : '');
      ctx.fillText(label, PAD, y); y += 12;
    });

    y += 3;
    ctx.strokeStyle = '#ddd';
    ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
    y += 7;
    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 9px Arial, sans-serif';
    if (payload.total)   { ctx.fillText('Total: £' + payload.total,   PAD, y); y += 13; }
    ctx.font = '8px Arial, sans-serif';
    ctx.fillStyle = '#666';
    if (payload.deposit) { ctx.fillText('Dep: £' + payload.deposit, PAD, y); y += 11; }
    if (payload.balance) { ctx.fillText('Bal: £' + payload.balance, PAD, y); }

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

    // Session-permanent record — survives any JSONP result within this page load
    sessionSaved.unshift(localOrder);

    allOrders = allOrders.filter(o => o['Order ID'] !== orderId);
    allOrders.unshift(localOrder);
    const panel = document.getElementById('orders-overlay');
    if (panel && panel.classList.contains('open')) renderList();

    if (!AppData.SHEETS_URL) {
      Survey.toast('Add your Google Sheets URL to js/data.js first');
    } else {
      Survey.toast(`Saved — ${orderId} v${version}`);
    }

    // Step 1 — text data via JSONP GET (same mechanism as load — works on iOS).
    saveToSheets(payload);

    // Step 2 — Drive image via JSONP GET (same mechanism as text save).
    // 4% JPEG quality + 180 px canvas keeps base64url under ~2 KB so the
    // full URL stays within Google Apps Script's practical limit.
    try {
      const img       = buildOrderImage(payload);
      const imageData = img.toDataURL('image/jpeg', 0.04);
      saveDriveImage(payload, imageData);
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
    showLocal(); // instant — no JSONP race possible
  }

  // Show orders from local data only (allOrders + pendingOrders + sessionSaved).
  // Called when the panel first opens so a just-saved order is always visible.
  // The ↻ Refresh button calls refresh() to sync with Google Sheets.
  function showLocal() {
    const list = document.getElementById('orders-list');
    if (!list) return;

    const merged = allOrders.slice();
    [...pendingOrders, ...sessionSaved].forEach(o => {
      if (!merged.some(r => r['Order ID'] === o['Order ID'])) merged.unshift(o);
    });
    allOrders = merged;

    if (allOrders.length) {
      renderList();
    } else {
      list.innerHTML = '<div class="orders-empty">No orders on this device yet — tap <strong>↻ Refresh</strong> to load from Google Sheets.</div>';
    }
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

    // Merge: Sheets rows + pending saves + this-session saves.
    // sessionSaved is never cleared by JSONP so orders saved this page load
    // always survive even if Sheets and pendingOrders both return empty.
    const merged = result.slice();
    [...pendingOrders, ...allOrders, ...sessionSaved].forEach(o => {
      if (!merged.some(r => r['Order ID'] === o['Order ID'])) merged.unshift(o);
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
