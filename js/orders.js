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

  /* ── Save order text data (POST via Netlify proxy — no URL length limit) ── */
  // Full payload including fullData is sent via fetch POST to the same-origin
  // Netlify function, which forwards it to Apps Script doPost → writeOrderRow.
  // This replaces the old JSONP GET which had to strip fullData for large quotes,
  // making those orders appear as "resave to enable loading" on other devices.
  async function saveToSheets(payload) {
    if (!AppData.SHEETS_URL) return;
    try {
      const res  = await fetch('/.netlify/functions/save-order', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
      const data = await res.json();
      if (data && data.ok) {
        Survey.toast('☁ Sheets saved ✓');
      } else {
        Survey.toast('⚠ Sheets save failed — order saved on this device');
      }
    } catch (_) {
      Survey.toast('⚠ Sheets save failed — order saved on this device');
    }
  }

  /* ── Save Drive image via Netlify function proxy (full quality POST) ── */
  // The browser POSTs to /.netlify/functions/drive-image (same-origin, no CORS
  // issues, no URL length limit).  That function forwards the payload to Google
  // Apps Script, manually following the 302 redirect so the POST body is not lost.
  async function saveDriveImage(payload, imageData) {
    if (!imageData) return;
    try {
      await fetch('/.netlify/functions/drive-image', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          imageOnly: true,
          imageData,
          orderId:  payload.orderId  || '',
          property: payload.property || '',
          savedAt:  payload.savedAt  || '',
        }),
      });
    } catch (_) {}
  }

  /* ── Build Drive archive image — print-layout screenshot ── */
  // Reproduces the PDF the user sees on iPad by:
  //   1. Extracting all @media print CSS rules from the loaded stylesheet
  //   2. Triggering prepareForPrint (scales sketch canvases to high-res, 150 mm)
  //   3. Injecting those rules into the html2canvas clone so it renders the print layout
  //   4. Capturing at 2× scale with 92% JPEG quality
  //   5. Restoring canvases via afterprint event
  async function buildOrderImage() {
    if (!window.html2canvas) return null;
    try {
      // Collect all rules that live inside @media print { … }
      let printCSS = '';
      try {
        for (const sheet of document.styleSheets) {
          try {
            for (const rule of sheet.cssRules) {
              const media = rule.conditionText ?? rule.media?.mediaText ?? '';
              if (media.trim() === 'print') {
                printCSS += Array.from(rule.cssRules || []).map(r => r.cssText).join('\n') + '\n';
              }
            }
          } catch (_) {} // cross-origin sheets throw SecurityError
        }
      } catch (_) {}

      // Trigger print preparation: scales sketch canvases to 300-dpi equivalent
      window.dispatchEvent(new Event('beforeprint'));
      await new Promise(r => requestAnimationFrame(r));
      await new Promise(r => requestAnimationFrame(r));

      window.scrollTo(0, 0);

      let shot;
      try {
        shot = await window.html2canvas(document.getElementById('app-wrap'), {
          scale:           2,
          useCORS:         true,
          backgroundColor: '#ffffff',
          logging:         false,
          onclone: (doc) => {
            // Inject print CSS — makes the clone look exactly like the PDF layout
            if (printCSS) {
              const s = doc.createElement('style');
              s.textContent = printCSS;
              doc.head.appendChild(s);
            }
            // Strip screen-only chrome
            doc.querySelectorAll('.no-print').forEach(el => el.remove());
            doc.getElementById('toast')?.remove();
            doc.body.style.background = '#fff';
            const wrap = doc.getElementById('app-wrap');
            if (wrap) wrap.style.background = '#fff';
          }
        });
      } finally {
        window.dispatchEvent(new Event('afterprint')); // always restore canvases
      }

      return shot.toDataURL('image/jpeg', 0.92);
    } catch (_) { return null; }
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
      property: address,
      version,
      savedAt:  new Date().toISOString(),
      status:   'Quote',
      rep:      data.customer?.surveyor   || '',
      customer: `${data.customer?.name || data.customer?.first || ''} ${data.customer?.last || ''}`.trim(),
      phone:    data.customer?.phone      || '',
      doorNo:   '',
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
      'Door No':  '',                'Address':  payload.address,
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

    // Step 2 — Drive image via Netlify proxy (full-quality html2canvas screenshot).
    // Fire-and-forget: runs after save toast so it doesn't block the UI.
    buildOrderImage().then(imageData => {
      if (imageData) saveDriveImage(payload, imageData);
    }).catch(() => {});
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
    showLocal(); // instant — local orders appear immediately

    // Auto-fetch from Sheets so orders saved on other devices show up
    // without the user needing to tap ↻ Refresh.
    // 2-second delay lets any in-progress save reach Apps Script first,
    // preventing the race where a fresh fetch returns before the write commits.
    if (AppData.SHEETS_URL) {
      setTimeout(() => {
        if (document.getElementById('orders-overlay')?.classList.contains('open')) {
          silentRefresh();
        }
      }, 2000);
    }
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

  // Background Sheets sync triggered automatically on panel open.
  // Shows a subtle indicator while fetching, then merges remote orders in.
  // Identical merge rules to refresh() — local copies with fullData always win.
  async function silentRefresh() {
    if (!AppData.SHEETS_URL) return;

    // Append a subtle "checking…" note at the bottom of the visible list
    const list = document.getElementById('orders-list');
    const ind  = document.createElement('div');
    ind.id = 'orders-sync-ind';
    ind.style.cssText = 'text-align:center;padding:8px 0 4px;font-size:11px;color:#aaa;';
    ind.textContent = '↻ Checking other devices…';
    if (list) list.appendChild(ind);

    const result = await fetchOrders();

    // Remove indicator however the fetch ended
    if (ind.parentNode) ind.parentNode.removeChild(ind);

    if (result === null) {
      // Network / timeout — keep whatever is already showing
      Survey.toast('⚠ Could not reach Google Sheets — showing this device only');
      return;
    }

    const before = allOrders.length;
    const merged = result.slice();
    [...pendingOrders, ...sessionSaved].forEach(o => {
      const idx = merged.findIndex(r => r['Order ID'] === o['Order ID']);
      if (idx === -1) {
        merged.unshift(o);
      } else if (o['Full Data'] && !merged[idx]['Full Data']) {
        merged.splice(idx, 1, o);
      }
    });
    allOrders = merged;

    if (document.getElementById('orders-overlay')?.classList.contains('open')) {
      renderList();
      // Tell the user how many orders came from Sheets so they can confirm sync
      const newCount = allOrders.length - before;
      if (newCount > 0) {
        Survey.toast(`☁ ${allOrders.length} orders loaded from all devices`);
      }
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

    // Merge Sheets rows with local data.
    // Rule: start with Sheets rows, then overlay any local version that has
    // fullData where the Sheets version does not — so orders always remain
    // loadable / editable even if Sheets stored a stripped copy.
    // pendingOrders is intentionally NOT cleared here; it stays in localStorage
    // so orders survive page reloads and remain loadable on this device.
    const merged = result.slice();
    [...pendingOrders, ...sessionSaved].forEach(o => {
      const idx = merged.findIndex(r => r['Order ID'] === o['Order ID']);
      if (idx === -1) {
        merged.unshift(o); // not in Sheets yet — add it
      } else if (o['Full Data'] && !merged[idx]['Full Data']) {
        merged.splice(idx, 1, o); // prefer local copy that has fullData
      }
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
