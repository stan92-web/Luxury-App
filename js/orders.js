/* ══════════════════════════════════════════════
   orders.js — Order save / load / email
   Depends on: data.js, survey.js
══════════════════════════════════════════════ */

const Orders = (() => {

  let allOrders   = [];
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
  async function saveToSheets(payload) {
    if (!AppData.SHEETS_URL) return false;
    try {
      await fetch(AppData.SHEETS_URL, {
        method:  'POST',
        mode:    'no-cors',
        headers: { 'Content-Type': 'text/plain' }, // text/plain = simple request, no CORS preflight
        body:    JSON.stringify(payload)
      });
      return true;
    } catch (_) { return false; }
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

    // Best-effort image capture — 6-second timeout so a hanging html2canvas
    // never blocks the order save. On iOS Safari this may fail silently.
    try {
      const captured = await Promise.race([
        Survey.captureSheet(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000))
      ]);
      const maxW  = 600;
      const scale = Math.min(1, maxW / captured.width);
      const thumb = document.createElement('canvas');
      thumb.width  = Math.round(captured.width  * scale);
      thumb.height = Math.round(captured.height * scale);
      thumb.getContext('2d').drawImage(captured, 0, 0, thumb.width, thumb.height);
      payload.imageData = thumb.toDataURL('image/jpeg', 0.3);
    } catch (_) { /* image capture failed or timed out — save without image */ }

    await saveToSheets(payload);

    // Immediately update the local orders list so the panel shows the new
    // order without needing a network round-trip to Google Sheets.
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
    allOrders = allOrders.filter(o => o['Order ID'] !== orderId);
    allOrders.unshift(localOrder);
    const panel = document.getElementById('orders-overlay');
    if (panel && panel.classList.contains('open')) renderList();

    if (!AppData.SHEETS_URL) {
      Survey.toast('Add your Google Sheets URL to js/data.js first');
    } else {
      Survey.toast(`Saved — ${orderId} v${version}`);
    }
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

    // Only show the loading spinner when we have no cached orders to display
    if (!allOrders.length) list.innerHTML = '<div class="orders-loading">Loading orders…</div>';
    const result = await fetchOrders();
    if (result === null) {
      // Fetch failed — keep showing cached orders if we have them
      if (allOrders.length) {
        Survey.toast('Could not refresh — showing saved orders');
        renderList();
      } else {
        list.innerHTML = '<div class="orders-empty">⚠️ Could not load orders from Google Sheets — check your internet connection, then tap <strong>↻ Refresh</strong> to try again.</div>';
      }
      return;
    }
    allOrders = result;
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
