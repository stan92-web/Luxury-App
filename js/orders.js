/* ══════════════════════════════════════════════
   orders.js — Order save / load / email
   Depends on: data.js, survey.js
══════════════════════════════════════════════ */

const Orders = (() => {

  let allOrders     = [];
  let pendingOrders = JSON.parse(localStorage.getItem('lh_pending_orders') || '[]');
  let filterStatus  = '';
  let filterMine    = false;
  let searchTerm    = '';
  let pollInterval  = null; // auto-refresh timer while Orders panel is open
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

  /* ── Save order via JSONP GET (iOS-safe, no CORS, no redirect issues) ── */
  // Uses the same <script>-tag injection as fetchOrders — Google does not
  // redirect GET requests to a different URL the way POST exec requests are,
  // so the callback always fires.  Apps Script doGet ?action=save handles it.
  // If the full payload exceeds 20 000 chars (large sketches), fullData is
  // stripped so metadata always reaches Sheets (order visible on all devices).
  // The Netlify function is then attempted in the background as a best-effort
  // channel to also store fullData.
  function saveViaJSONP(payload) {
    return new Promise(resolve => {
      const cbName = 'lhSaveCb' + Date.now();
      const timer  = setTimeout(() => { cleanup(); resolve({ ok: false }); }, 15000);
      const cleanup = () => {
        clearTimeout(timer);
        delete window[cbName];
        if (script.parentNode) script.parentNode.removeChild(script);
      };
      window[cbName] = data => { cleanup(); resolve(data || { ok: false }); };
      const script   = document.createElement('script');
      script.onerror = () => { cleanup(); resolve({ ok: false }); };
      const qs = new URLSearchParams({
        action:   'save',
        data:     JSON.stringify(payload),
        callback: cbName,
      });
      script.src = AppData.SHEETS_URL + '?' + qs.toString();
      document.head.appendChild(script);
    });
  }

  // Compress string with gzip → base64url for URL-safe fullData transmission
  async function gzipBase64url(str) {
    const bytes  = new TextEncoder().encode(str);
    const cs     = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    const arr = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < arr.length; i += 8192) {
      binary += String.fromCharCode(...arr.subarray(i, i + 8192));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  // Save compressed fullData via JSONP — URL stays ~6 KB regardless of order size
  async function saveFullDataViaJSONP(orderId, fullData) {
    let zdata;
    try { zdata = await gzipBase64url(fullData); }
    catch (_) { return false; }
    return new Promise(resolve => {
      const cbName = 'lhFdCb' + Date.now();
      const timer  = setTimeout(() => { cleanup(); resolve(false); }, 15000);
      const cleanup = () => {
        clearTimeout(timer);
        delete window[cbName];
        if (script.parentNode) script.parentNode.removeChild(script);
      };
      window[cbName] = data => { cleanup(); resolve(!!(data && data.ok)); };
      const script   = document.createElement('script');
      script.onerror = () => { cleanup(); resolve(false); };
      const qs = new URLSearchParams({ action: 'saveFullData', orderId, zdata, callback: cbName });
      script.src = AppData.SHEETS_URL + '?' + qs.toString();
      document.head.appendChild(script);
    });
  }

  // Save fullData for an order that's already in Sheets — no new version row.
  // Tries client-side gzip JSONP first (fast, no round-trip to Netlify).
  // Falls back to Netlify server-side gzip for older iPads without CompressionStream.
  async function saveFullDataOnly(orderId, fullData) {
    if (!orderId || !fullData) return;
    let saved = false;
    try { saved = await saveFullDataViaJSONP(orderId, fullData); } catch (_) {}
    if (!saved) {
      fetch('/.netlify/functions/save-fulldata', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ orderId, fullData }),
      }).catch(() => {});
    }
  }

  async function saveToSheets(payload, silent) {
    if (!AppData.SHEETS_URL) return;

    const result = await saveViaJSONP({ ...payload, fullData: '' });
    if (!(result && result.ok)) {
      if (!silent) Survey.toast('⚠ Cloud save failed — saved on this device only');
      return;
    }
    if (!silent) Survey.toast('☁ Sheets saved ✓');

    if (payload.fullData) saveFullDataOnly(payload.orderId, payload.fullData);
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

  /* ── Rep colour — consistent colour per rep name across devices ── */
  function repColor(name) {
    if (!name) return '#888';
    const palette = ['#c0392b','#1a6eb5','#27ae60','#8e44ad','#d35400','#16a085','#c77a2a','#2c3e7a'];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (name.charCodeAt(i) + ((h << 5) - h)) | 0;
    return palette[Math.abs(h) % palette.length];
  }

  /* ── Public: save current quote ─────────── */
  // silent=true suppresses all toasts — used by auto-save so the user
  // is not interrupted every 45 seconds while working.
  async function save(silent) {
    const raw = localStorage.getItem('lh_survey_v1');
    if (!raw) { if (!silent) Survey.toast('Nothing to save yet'); return; }

    const data    = JSON.parse(raw);
    const orderId = currentOrderId();
    const version = nextVersion();

    const rooms = (data.rooms || [])
      .map(r => [r.name, r.w && r.h ? `${r.w}×${r.h}mm` : ''].filter(Boolean).join(' '))
      .join(' | ');

    const address = data.customer?.address || '';

    let fullData = raw;
    if (fullData.length > 44000) {
      try {
        const obj = JSON.parse(fullData);
        (obj.rooms || []).forEach(r => { r.shapes = []; });
        fullData = JSON.stringify(obj);
      } catch (_) { fullData = ''; }
    }

    const currentStatus = localStorage.getItem('lh_order_status') || 'Quote';

    const payload = {
      orderId,
      property: address,
      version,
      savedAt:  new Date().toISOString(),
      status:   currentStatus,
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

    if (!silent) Survey.toast('Saving…');

    const localOrder = {
      'Order ID': orderId,  'Property': payload.property,
      'Saved At': payload.savedAt, 'Version': String(version),
      'Status':   currentStatus, 'Rep':    payload.rep,
      'Customer': payload.customer, 'Phone':    payload.phone,
      'Door No':  '',                'Address':  payload.address,
      'Rooms':    payload.rooms,    'Total £':  payload.total,
      'Deposit £': payload.deposit, 'Balance £': payload.balance,
      'Full Data': payload.fullData
    };

    pendingOrders = pendingOrders.filter(p => p['Order ID'] !== orderId);
    pendingOrders.unshift(localOrder);
    if (pendingOrders.length > 50) pendingOrders = pendingOrders.slice(0, 50);
    localStorage.setItem('lh_pending_orders', JSON.stringify(pendingOrders));

    sessionSaved.unshift(localOrder);

    allOrders = allOrders.filter(o => o['Order ID'] !== orderId);
    allOrders.unshift(localOrder);
    const panel = document.getElementById('orders-overlay');
    if (panel && panel.classList.contains('open')) renderList();

    if (!AppData.SHEETS_URL) {
      if (!silent) Survey.toast('Add your Google Sheets URL to js/data.js first');
    } else {
      if (!silent) Survey.toast(`Saved — ${orderId} v${version}`);
    }

    if (typeof Survey !== 'undefined' && Survey.updateCloudStatus) Survey.updateCloudStatus('clean');

    saveToSheets(payload, silent);

    // Drive image only on manual save — avoid capturing every 45 seconds
    if (!silent) {
      buildOrderImage().then(imageData => {
        if (imageData) saveDriveImage(payload, imageData);
      }).catch(() => {});
    }
  }

  // Auto-save: silent cloud save triggered by inactivity timer in survey.js.
  // Only runs if there is meaningful content (customer name or address).
  async function autoSave() {
    const raw = localStorage.getItem('lh_survey_v1');
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      const name = ((data.customer?.name || data.customer?.first || '') + ' ' + (data.customer?.last || '')).trim();
      const addr = (data.customer?.address || '').trim();
      if (!name && !addr) return; // blank form — nothing worth saving
    } catch (_) { return; }
    await save(true);
  }

  /* ── Convert a stored local order object back to a saveToSheets payload ── */
  function orderToPayload(o) {
    return {
      orderId:  String(o['Order ID']  || ''),
      property: String(o['Property']  || o['Address'] || ''),
      version:  Number(o['Version']   || 1),
      savedAt:  String(o['Saved At']  || new Date().toISOString()),
      status:   String(o['Status']    || 'Quote'),
      rep:      String(o['Rep']       || ''),
      customer: String(o['Customer']  || ''),
      phone:    String(o['Phone']     || ''),
      doorNo:   String(o['Door No']   || ''),
      address:  String(o['Address']   || ''),
      rooms:    String(o['Rooms']     || ''),
      total:    String(o['Total £']   || ''),
      deposit:  String(o['Deposit £'] || ''),
      balance:  String(o['Balance £'] || ''),
      fullData: String(o['Full Data'] || ''),
    };
  }

  /* ── Push this device's pending orders that haven't reached Sheets ── */
  // Called after every Sheets fetch. Compares pendingOrders against what
  // Sheets returned and silently POSTs anything that's missing. This means
  // each device automatically contributes its local orders to the shared pool
  // the first time it opens the Orders panel after an app update.
  // Pass silent=true to suppress the "Syncing…" toast (used by startupSync).
  function pushUnsyncedPending(sheetsOrders, silent) {
    if (!AppData.SHEETS_URL || !pendingOrders.length) return;
    const inSheets      = new Set(sheetsOrders.map(o => String(o['Order ID'])));
    // hasFullData: true means the Sheets row already has fullData — skip those.
    const needsFullData = new Set(
      sheetsOrders.filter(o => !o['hasFullData']).map(o => String(o['Order ID']))
    );

    // Orders not in Sheets at all — full save (metadata + fullData)
    const notInSheets = pendingOrders.filter(p => !inSheets.has(String(p['Order ID'])));

    // Orders in Sheets but fullData missing — push fullData only, no new version row
    const fdOnly = pendingOrders.filter(p => {
      const id = String(p['Order ID']);
      return inSheets.has(id) && needsFullData.has(id) && p['Full Data'];
    });

    if (!notInSheets.length && !fdOnly.length) return;

    if (notInSheets.length) {
      if (!silent) Survey.toast(`↑ Syncing ${notInSheets.length} order${notInSheets.length !== 1 ? 's' : ''} to cloud…`);
      notInSheets.slice(0, 20).forEach((p, i) => {
        setTimeout(() => saveToSheets(orderToPayload(p)).catch(() => {}), i * 400);
      });
    }

    if (fdOnly.length) {
      const offset = notInSheets.length * 400;
      fdOnly.slice(0, 20).forEach((p, i) => {
        setTimeout(() => {
          saveFullDataOnly(String(p['Order ID']), String(p['Full Data'])).catch(() => {});
        }, offset + i * 400);
      });
    }
  }

  /* ── Silent background sync on startup ────── */
  // Runs 6 seconds after page load — checks if any locally-saved orders are
  // missing their fullData in Sheets, and re-uploads silently.
  // This means an iPad that saved orders will automatically contribute them
  // to the shared Sheets even if the user never opens the Orders panel.
  async function startupSync() {
    if (!AppData.SHEETS_URL || !pendingOrders.length) return;
    try {
      const result = await fetchOrders();
      if (result && Array.isArray(result)) pushUnsyncedPending(result, true); // silent
    } catch (_) {}
  }

  /* ── Load orders from Sheets (JSONP — bypasses CORS) ── */
  function fetchOrders() {
    if (!AppData.SHEETS_URL) return Promise.resolve([]);
    return new Promise(resolve => {
      const cbName = 'lhCb' + Date.now();
      const script = document.createElement('script');
      const timer  = setTimeout(() => { cleanup(); resolve(null); }, 25000);

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
    showLocal();

    if (AppData.SHEETS_URL) {
      // Initial fetch — 2 s delay so any in-progress save reaches Apps Script first
      setTimeout(() => {
        if (document.getElementById('orders-overlay')?.classList.contains('open')) {
          silentRefresh(false); // false = show the "Checking…" indicator on first load
        }
      }, 2000);

      // Auto-poll every 30 s while the panel is open so status changes and new
      // orders from other iPads appear without anyone tapping Refresh.
      clearInterval(pollInterval);
      pollInterval = setInterval(() => {
        if (document.getElementById('orders-overlay')?.classList.contains('open')) {
          silentRefresh(true); // true = quiet, no indicator for background polls
        } else {
          clearInterval(pollInterval);
        }
      }, 30000);
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
  // quiet=true suppresses the "Checking…" indicator and the count toast
  // — used by the 30-second auto-poll so the list doesn't flash every poll.
  async function silentRefresh(quiet) {
    if (!AppData.SHEETS_URL) return;

    const list = document.getElementById('orders-list');
    let ind;
    if (!quiet) {
      ind = document.createElement('div');
      ind.id = 'orders-sync-ind';
      ind.style.cssText = 'text-align:center;padding:8px 0 4px;font-size:11px;color:#aaa;';
      ind.textContent = '↻ Checking other devices…';
      if (list) list.appendChild(ind);
    }

    const result = await fetchOrders();

    if (ind && ind.parentNode) ind.parentNode.removeChild(ind);

    if (result === null) {
      if (!quiet) Survey.toast('⚠ Could not reach Google Sheets — showing this device only');
      return;
    }

    pushUnsyncedPending(result);

    const sheetsIds      = new Set(result.map(o => String(o['Order ID'])));
    const localOnlyCount = pendingOrders.filter(p => !sheetsIds.has(String(p['Order ID']))).length;

    const merged = result.slice();
    [...pendingOrders, ...sessionSaved].forEach(o => {
      const idx = merged.findIndex(r => r['Order ID'] === o['Order ID']);
      if (idx === -1) {
        merged.unshift(o);
      } else if (o['Full Data'] && !merged[idx]['Full Data'] && !merged[idx]['hasFullData']) {
        merged.splice(idx, 1, o);
      }
    });
    allOrders = merged;

    if (document.getElementById('orders-overlay')?.classList.contains('open')) {
      renderList();
      if (!quiet) {
        const fromSheets = sheetsIds.size;
        if (fromSheets > 0 || localOnlyCount > 0) {
          const parts = [];
          if (fromSheets)     parts.push(`${fromSheets} order${fromSheets !== 1 ? 's' : ''} from cloud`);
          if (localOnlyCount) parts.push(`${localOnlyCount} local (syncing…)`);
          Survey.toast(`☁ ${parts.join(' · ')}`);
        }
      }
      prefetchMissingFullData().catch(() => {});
    }
  }

  /* ── Silently pre-fetch fullData for orders showing "resave" badge ── */
  // After any Sheets sync, orders whose fullData wasn't saved to the cloud
  // show a "resave to enable loading" badge.  For OLD orders (saved before the
  // two-step save was introduced) the fullData may actually be in Sheets but in
  // an unexpected column — this prefetch will find it and clear the badge
  // automatically without the user doing anything.
  // Runs sequentially, up to 5 most-recent orders at a time, 600 ms apart so
  // we don't overwhelm Apps Script's rate limits.
  async function prefetchMissingFullData() {
    const missing = allOrders
      .filter(o => !o['Full Data'] && !o['hasFullData'])
      .sort((a, b) => new Date(b['Saved At'] || 0) - new Date(a['Saved At'] || 0))
      .slice(0, 5);

    if (!missing.length) return;

    let anyFound = false;
    for (const o of missing) {
      try {
        const fd = await fetchOrderData(o['Order ID']);
        if (fd) {
          // Cache fullData in the in-memory order so the badge clears
          // and the order loads instantly if tapped.
          const live = allOrders.find(x => x['Order ID'] === o['Order ID']);
          if (live) { live['Full Data'] = fd; live['hasFullData'] = true; }
          anyFound = true;
        }
      } catch (_) {}
      // Pause between JSONP requests to stay within Apps Script rate limits
      await new Promise(r => setTimeout(r, 600));
    }

    if (anyFound && document.getElementById('orders-overlay')?.classList.contains('open')) {
      renderList(); // re-render — badges gone for orders whose data was found
    }
  }

  function closePanel() {
    const el = document.getElementById('orders-overlay');
    if (el) el.classList.remove('open');
    document.body.style.overflow = '';
    clearInterval(pollInterval);
    pollInterval = null;
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

    // Fetch from Sheets and merge when it arrives.
    const result = await fetchOrders();

    if (result === null) {
      if (!allOrders.length) {
        list.innerHTML = '<div class="orders-empty">⚠️ Could not load orders from Google Sheets — check your internet connection, then tap <strong>↻ Refresh</strong> to try again.</div>';
      } else {
        Survey.toast('⚠ Could not reach Sheets — showing local orders');
      }
      return;
    }

    // Push any local orders that haven't reached Sheets yet
    pushUnsyncedPending(result);

    // Merge: start with Sheets rows, then overlay local copies that have fullData
    const merged = result.slice();
    [...pendingOrders, ...sessionSaved].forEach(o => {
      const idx = merged.findIndex(r => r['Order ID'] === o['Order ID']);
      if (idx === -1) {
        merged.unshift(o);
      } else if (o['Full Data'] && !merged[idx]['Full Data'] && !merged[idx]['hasFullData']) {
        merged.splice(idx, 1, o);
      }
    });
    allOrders = merged;
    renderList();
    // Silently try to load fullData for orders still showing the "resave" badge
    prefetchMissingFullData().catch(() => {});
  }

  function renderList() {
    const list = document.getElementById('orders-list');
    if (!list) return;

    let orders = allOrders.slice();

    if (filterStatus) orders = orders.filter(o => o['Status'] === filterStatus);
    if (filterMine) {
      const myName = (localStorage.getItem('lh_rep_name') || '').trim().toLowerCase();
      if (myName) orders = orders.filter(o => (o['Rep'] || '').trim().toLowerCase() === myName);
    }
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      orders = orders.filter(o =>
        (o['Customer'] || '').toLowerCase().includes(q) ||
        (o['Address']  || '').toLowerCase().includes(q) ||
        (o['Order ID'] || '').toLowerCase().includes(q) ||
        (o['Rep']      || '').toLowerCase().includes(q)
      );
    }

    // Keep only the best row per order ID: highest version; on a tie prefer
    // the row that has fullData so the order stays loadable after a background save.
    // NaN-safe: old rows stored timestamps in the Version column — treat as -1
    // so any real version number (1, 2, …) always wins over those legacy rows.
    const byId = {};
    orders.forEach(o => {
      const id  = o['Order ID'];
      const ver = isNaN(Number(o['Version']))   ? -1 : Number(o['Version']);
      const cur = byId[id];
      if (!cur) { byId[id] = o; return; }
      const cv  = isNaN(Number(cur['Version'])) ? -1 : Number(cur['Version']);
      const oHas  = !!(o['Full Data']   || o['hasFullData']);
      const curHas = !!(cur['Full Data'] || cur['hasFullData']);
      if (ver > cv || (ver === cv && oHas && !curHas)) byId[id] = o;
    });

    const latest = Object.values(byId).sort((a, b) =>
      new Date(b['Saved At'] || 0) - new Date(a['Saved At'] || 0)
    );

    if (!latest.length) {
      list.innerHTML = '<div class="orders-empty">No orders match your search.</div>';
      return;
    }

    // Group by month (most recent month first)
    const byMonth = {};
    const monthKeys = [];
    latest.forEach(o => {
      const d   = new Date(o['Saved At'] || 0);
      const key = isNaN(d.getTime()) ? 'Unknown'
        : d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
      if (!byMonth[key]) { byMonth[key] = []; monthKeys.push(key); }
      byMonth[key].push(o);
    });

    let html = '';
    monthKeys.forEach(month => {
      html += `<div class="order-month-heading">${month}</div>`;
      byMonth[month].forEach(o => {
        const stat     = o['Status'] || 'Quote';
        const rowCls   = stat === 'Order' ? ' order-row-confirmed'
                       : stat === 'Installed' ? ' order-row-installed' : '';
        const total    = o['Total £'] ? `£${o['Total £']}` : '—';
        const date     = fmtDate(o['Saved At']);
        const addr     = [o['Door No'], o['Address']].filter(Boolean).join(' ');
        const hasData  = !!(o['Full Data'] || o['hasFullData']);
        const noData   = hasData ? '' : '<span class="order-no-data">⚠ resave to enable loading</span>';
        const oid      = (o['Order ID'] || '').replace(/'/g, "\\'");
        const rep      = o['Rep'] || '';
        const rc       = rep ? repColor(rep) : '#888';

        // Is this order from the current device's rep?
        const myName   = (localStorage.getItem('lh_rep_name') || '').trim().toLowerCase();
        const isMine   = !myName || !rep || rep.trim().toLowerCase() === myName;

        // Left border uses rep colour; non-mine rows are slightly dimmed
        const borderStyle = `border-left:4px solid ${rc};`;
        const dimStyle    = (!isMine && myName) ? 'opacity:0.75;' : '';
        const dataStyle   = hasData ? '' : 'opacity:0.65;';
        const rowStyle    = borderStyle + dimStyle + dataStyle;

        // Rep badge — prominent, top of right column
        const repLabel = rep || (isMine && myName ? myName : '');
        const repBadge = repLabel
          ? `<div class="order-rep-badge-lg" style="background:${rc}18;color:${rc};border-color:${rc}66">${repLabel}</div>`
          : '';

        // "Not yours" label
        const notMine  = (!isMine && myName)
          ? `<div class="order-not-mine">👤 ${rep}'s order</div>` : '';

        const qa = stat === 'Quote'     ? ' oss-q-active' : '';
        const oa = stat === 'Order'     ? ' oss-o-active' : '';
        const ia = stat === 'Installed' ? ' oss-i-active' : '';
        const statusSel = `
          <div class="order-status-sel" onclick="event.stopPropagation()">
            <button class="oss-btn${qa}" onclick="Orders.setStatus('${oid}','Quote')">Quote</button>
            <span class="oss-arrow">›</span>
            <button class="oss-btn${oa}" onclick="Orders.setStatus('${oid}','Order')">Order</button>
            <span class="oss-arrow">›</span>
            <button class="oss-btn${ia}" onclick="Orders.setStatus('${oid}','Installed')">Installed</button>
          </div>`;
        html += `
          <div class="order-row${rowCls}" style="${rowStyle}" onclick="Orders.loadOrder('${oid}')">
            <div class="order-main">
              <div class="order-header-row">
                <span class="order-id-badge">${o['Order ID'] || '—'}</span>
                ${notMine}
              </div>
              <div class="order-customer">${o['Customer'] || '—'}</div>
              <div class="order-addr">${addr || '—'}</div>
              <div class="order-rooms">${o['Rooms'] || ''}${noData}</div>
              ${statusSel}
            </div>
            <div class="order-side">
              ${repBadge}
              <div class="order-price">${total}</div>
              <div class="order-date">${date}</div>
            </div>
          </div>`;
      });
    });

    list.innerHTML = html;
  }

  /* ── Set status: Quote / Order / Installed ── */
  // Updates status in-place via Apps Script ?action=updateStatus — no new
  // version row is created, so fullData on existing rows is never disturbed.
  function setStatus(orderId, newStatus) {
    const o = allOrders.find(x => x['Order ID'] === orderId);
    if (!o || o['Status'] === newStatus) return;

    o['Status'] = newStatus;

    // Update pending cache and session record
    pendingOrders.forEach(p => { if (p['Order ID'] === orderId) p['Status'] = newStatus; });
    localStorage.setItem('lh_pending_orders', JSON.stringify(pendingOrders));
    const ss = sessionSaved.find(x => x['Order ID'] === orderId);
    if (ss) ss['Status'] = newStatus;

    // Update active order status if it is the currently-loaded order
    if (localStorage.getItem('lh_order_id') === orderId) {
      localStorage.setItem('lh_order_status', newStatus);
    }

    renderList();
    Survey.toast(`Status → ${newStatus}`);

    if (AppData.SHEETS_URL) updateStatusInSheets(orderId, newStatus);
  }

  // JSONP call to Apps Script ?action=updateStatus — updates the Status cell
  // of the latest version row without creating a new row or touching fullData.
  function updateStatusInSheets(orderId, status) {
    const cbName = 'lhUsCb' + Date.now();
    const script = document.createElement('script');
    const timer  = setTimeout(() => {
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }, 15000);
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
    const qs = new URLSearchParams({ action: 'updateStatus', orderId, status, callback: cbName });
    script.src = AppData.SHEETS_URL + '?' + qs.toString();
    document.head.appendChild(script);
  }

  function fmtDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
    } catch (_) { return ''; }
  }

  function setFilter(status, btn) {
    filterStatus = status;
    // Only remove active from status-filter buttons, not the Mine toggle
    document.querySelectorAll('.ofilter-btn:not([data-type="mine"])').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderList();
  }

  function toggleMine(btn) {
    const myName = (localStorage.getItem('lh_rep_name') || '').trim();
    if (!myName) { Survey.toast('Set your name in the "My Name" box first'); return; }
    filterMine = !filterMine;
    if (btn) btn.classList.toggle('active', filterMine);
    renderList();
  }

  function setSearch(val) {
    searchTerm = val;
    renderList();
  }

  /* ── Fetch one order's fullData from Sheets via JSONP ── */
  function fetchOrderData(orderId) {
    return new Promise(resolve => {
      if (!AppData.SHEETS_URL) return resolve(null);
      const cbName = 'lhOrdCb' + Date.now();
      const script = document.createElement('script');
      const timer  = setTimeout(() => { cleanup(); resolve(null); }, 15000);
      const cleanup = () => {
        clearTimeout(timer);
        delete window[cbName];
        if (script.parentNode) script.parentNode.removeChild(script);
      };
      window[cbName] = data => {
        cleanup();
        if (!data || !data.ok || !data.order) { resolve(null); return; }
        // New rows: fullData is in the 'Full Data' column
        // Old rows (pre-column-fix): fullData landed in an unnamed column — returned as key ''
        // Validate: real fullData is JSON starting with '{' and is long (>100 chars)
        // This rejects balance values like "250" that sit in the 'Full Data' column on old rows
        const candidates = [data.order['Full Data'], data.order['']];
        const fd = candidates.find(v => {
          const s = String(v || '');
          return s.length > 100 && s.charAt(0) === '{';
        });
        resolve(fd ? String(fd) : null);
      };
      script.onerror = () => { cleanup(); resolve(null); };
      script.src = AppData.SHEETS_URL
        + '?action=getOrder&orderId=' + encodeURIComponent(orderId)
        + '&callback=' + cbName;
      document.head.appendChild(script);
    });
  }

  /* ── Load an order into the form ─────────── */
  async function loadOrder(orderId) {
    const versions = allOrders
      .filter(o => o['Order ID'] === orderId)
      .sort((a, b) => {
        const av = isNaN(Number(a['Version'])) ? -1 : Number(a['Version']);
        const bv = isNaN(Number(b['Version'])) ? -1 : Number(b['Version']);
        return bv - av;
      });

    if (!versions.length) { Survey.toast('Order not found'); return; }

    const order = versions[0];
    let fullData = order['Full Data'];

    if (!fullData) {
      Survey.toast('Fetching order data…');
      fullData = await fetchOrderData(orderId);
      if (fullData) {
        order['Full Data'] = fullData; // cache for this session
      } else {
        Survey.toast('Order data not found — resave it from the original device first');
        return;
      }
    }

    const customer = order['Customer'] || orderId;
    const orderRep = (order['Rep'] || '').trim();
    const myName   = (localStorage.getItem('lh_rep_name') || '').trim();
    const isOther  = myName && orderRep && orderRep.toLowerCase() !== myName.toLowerCase();

    const confirmMsg = isOther
      ? `⚠ This order belongs to ${orderRep}.\n\nCustomer: ${customer}\n\nLoading it will replace everything on YOUR current form. Only do this if you mean to.\n\nContinue?`
      : `Load order for ${customer}?\n\nThis will replace everything on the current form.`;
    if (!confirm(confirmMsg)) return;

    try {
      localStorage.setItem('lh_survey_v1',     fullData);
      localStorage.setItem('lh_order_id',      orderId);
      localStorage.setItem('lh_order_version', String(order['Version'] || 1));
      localStorage.setItem('lh_order_status',  order['Status'] || 'Quote');
      closePanel();
      location.reload();
    } catch (_) {
      Survey.toast('Could not restore order — please try again');
    }
  }

  /* ── Delete a single order from cloud + local cache ── */
  function deleteOrder(orderId) {
    const o = allOrders.find(x => x['Order ID'] === orderId);
    if (!o) return;
    const label = [o['Customer'], o['Address']].filter(Boolean).join(' — ') || orderId;
    if (!confirm(`Delete order?\n\n${label}\n\nThis removes it from the cloud permanently.`)) return;

    allOrders     = allOrders.filter(x => x['Order ID'] !== orderId);
    pendingOrders = pendingOrders.filter(x => x['Order ID'] !== orderId);
    localStorage.setItem('lh_pending_orders', JSON.stringify(pendingOrders));
    const si = sessionSaved.findIndex(x => x['Order ID'] === orderId);
    if (si !== -1) sessionSaved.splice(si, 1);

    renderList();
    Survey.toast('Deleting…');

    if (!AppData.SHEETS_URL) return;
    const cbName = 'lhDelCb' + Date.now();
    const script = document.createElement('script');
    const timer  = setTimeout(() => {
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
      Survey.toast('⚠ Cloud delete timed out');
    }, 15000);
    window[cbName] = () => {
      clearTimeout(timer);
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
      Survey.toast('Order deleted');
    };
    script.onerror = () => {
      clearTimeout(timer);
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
      Survey.toast('⚠ Cloud delete failed');
    };
    script.src = AppData.SHEETS_URL
      + '?action=deleteOrder&orderId=' + encodeURIComponent(orderId)
      + '&callback=' + cbName;
    document.head.appendChild(script);
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
    // Wire search input
    const si = document.getElementById('orders-search-input');
    if (si) si.addEventListener('input', e => setSearch(e.target.value));

    // Rep name — load from storage and wire save-on-change
    const repInput = document.getElementById('rep-name-input');
    if (repInput) {
      repInput.value = localStorage.getItem('lh_rep_name') || '';
      repInput.addEventListener('input', () => {
        localStorage.setItem('lh_rep_name', repInput.value.trim());
      });
    }

    // Startup sync — silently upload any locally-saved orders that are missing
    // their fullData in Google Sheets.  Runs 6 s after load so it doesn't
    // compete with the initial page render.  This ensures every device
    // contributes its orders to the shared Sheets automatically — even if the
    // user never opens the Orders panel.
    setTimeout(() => startupSync().catch(() => {}), 6000);
  });

  return { save, autoSave, openPanel, closePanel, setFilter, toggleMine, setSearch, loadOrder, sendEmail, refresh, setStatus, diagnostic };

  function diagnostic() {
    const pending  = JSON.parse(localStorage.getItem('lh_pending_orders') || '[]');
    const surveyRaw = localStorage.getItem('lh_survey_v1');
    const surveyObj = surveyRaw ? (() => { try { return JSON.parse(surveyRaw); } catch(_) { return null; } })() : null;
    const activeId  = localStorage.getItem('lh_order_id') || '—';
    const lines = [
      `=== DEVICE DIAGNOSTIC v73 ===`,
      ``,
      `Locally stored orders: ${pending.length}`,
      ...pending.map(p =>
        `  ${p['Order ID']} v${p['Version']} | ${p['Customer'] || '?'} | ${p['Status'] || 'Quote'} | fullData: ${p['Full Data'] ? 'YES' : 'NO'}`
      ),
      ``,
      `Active order on form: ${activeId}`,
      `Form data present: ${surveyRaw ? 'YES (' + surveyRaw.length + ' chars)' : 'NO'}`,
      surveyObj ? `  Customer: ${((surveyObj.customer || {}).name || (surveyObj.customer || {}).first || '?')} ${((surveyObj.customer || {}).last || '')}`.trim() : '',
      ``,
      `Sheets URL configured: ${!!AppData.SHEETS_URL}`,
    ].filter(l => l !== null);
    const msg = lines.join('\n');
    alert(msg);
    console.log(msg);
  }
})();
