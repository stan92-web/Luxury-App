/*
  Netlify function — Invoice Ninja integration

  Receives order data + quote image from the iPad app and:
    1. Finds or creates / updates the client in Invoice Ninja
    2. Creates a versioned invoice (LH2607-XXXX v1, v2, …)
       — previous versions are left untouched so old quotes stay safe
    3. Attaches the quote-sheet image to the new invoice
    4. Returns { ok, invoiceId, invoiceUrl, version }

  Required Netlify environment variables (set in Netlify dashboard):
    NINJA_URL  — base URL, e.g. https://invoicing.co (no trailing slash)
    NINJA_KEY  — Invoice Ninja API token (Settings → API Tokens)
*/

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const JSON_HDR = { ...CORS, 'Content-Type': 'application/json' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const NINJA_URL = (process.env.NINJA_URL || '').replace(/\/$/, '');
  const NINJA_KEY =  process.env.NINJA_KEY  || '';

  if (!NINJA_URL || !NINJA_KEY) {
    return {
      statusCode: 500,
      headers: JSON_HDR,
      body: JSON.stringify({
        ok: false,
        error: 'Invoice Ninja not configured — add NINJA_URL and NINJA_KEY in Netlify → Site settings → Environment variables',
      }),
    };
  }

  const apiH = {
    'X-API-TOKEN':     NINJA_KEY,
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type':    'application/json',
  };

  try {
    const body       = JSON.parse(event.body || '{}');
    const { order, orderId, versionNum, imageData } = body;

    if (!order || !orderId) {
      return { statusCode: 400, headers: JSON_HDR, body: JSON.stringify({ ok: false, error: 'Missing order or orderId' }) };
    }

    const cust      = order.customer  || {};
    const pricing   = order.pricing   || {};
    const rooms     = order.rooms     || [];

    const firstName = (cust.name  || cust.first || '').trim();
    const lastName  = (cust.last  || '').trim();
    const fullName  = [firstName, lastName].filter(Boolean).join(' ') || 'Unknown Customer';
    const phone     = (cust.phone   || '').trim();
    const email     = (cust.email   || '').trim();
    const address   = (cust.address || '').trim();

    // ── 1. Find or create/update client ──────────────────────────────
    let clientId = null;

    for (const term of [email, fullName].filter(Boolean)) {
      if (clientId) break;
      const r = await fetch(
        `${NINJA_URL}/api/v1/clients?filter=${encodeURIComponent(term)}&per_page=5`,
        { headers: apiH }
      );
      if (r.ok) {
        const d = await r.json();
        if (d.data && d.data.length > 0) clientId = d.data[0].id;
      }
    }

    const clientPayload = {
      name:  fullName,
      phone,
      address1: address,
      contacts: [{ first_name: firstName, last_name: lastName, email: email || undefined, phone: phone || undefined }],
    };

    if (clientId) {
      await fetch(`${NINJA_URL}/api/v1/clients/${clientId}`, {
        method: 'PUT', headers: apiH, body: JSON.stringify(clientPayload),
      });
    } else {
      const r  = await fetch(`${NINJA_URL}/api/v1/clients`, {
        method: 'POST', headers: apiH, body: JSON.stringify(clientPayload),
      });
      const d  = await r.json();
      clientId = d.data && d.data.id;
    }

    if (!clientId) {
      return { statusCode: 500, headers: JSON_HDR, body: JSON.stringify({ ok: false, error: 'Could not create client in Invoice Ninja' }) };
    }

    // ── 2. Build design notes ─────────────────────────────────────────
    const noteLines = ['═══ DESIGN NOTES ═══', ''];

    rooms.forEach((room, i) => {
      const rName = (room.name || `Room ${i + 1}`).toUpperCase();
      noteLines.push(`ROOM ${i + 1} — ${rName}`);

      if (room.doorType === 'sliding') {
        const parts = ['Sliding'];
        if (room.doorSlide) parts.push(room.doorSlide);
        if (room.doorFrame) parts.push(room.doorFrame);
        noteLines.push(`Door: ${parts.join(' | ')}`);
      } else if (room.doorStyle) {
        noteLines.push(`Door: Hinged | ${room.doorStyle}`);
      }

      if (room.notes && room.notes.trim()) {
        noteLines.push(`Notes: ${room.notes.trim()}`);
      }
      noteLines.push('');
    });

    if (cust.notes && cust.notes.trim()) {
      noteLines.push('═══ INTERNAL NOTES ═══', cust.notes.trim(), '');
    }

    const rep       = (order.rep || cust.surveyor || '').trim();
    const quoteDate = (cust.date || '').trim();
    if (rep)       noteLines.push(`Rep: ${rep}`);
    if (quoteDate) noteLines.push(`Quote Date: ${quoteDate}`);

    const publicNotes = noteLines.join('\n');

    // ── 3. Build line items ───────────────────────────────────────────
    const total   = parseFloat(pricing.total   || 0);
    const deposit = parseFloat(pricing.deposit || 0);
    const balance = total - deposit;

    const lineItems = rooms.length > 0
      ? rooms.map((room, i) => {
          const rName = room.name || `Room ${i + 1}`;
          let doorDesc = '';
          if (room.doorType === 'sliding') {
            doorDesc = [room.doorSlide, room.doorFrame].filter(Boolean).join(' / ');
          } else {
            doorDesc = room.doorStyle || '';
          }
          return {
            product_key: 'Fitted Wardrobe',
            notes: [rName, doorDesc].filter(Boolean).join(' — '),
            quantity: 1,
            cost: rooms.length === 1 ? total : 0,
          };
        })
      : [{ product_key: 'Luxury House Fitted Wardrobe', notes: address || 'Fitted wardrobe installation', quantity: 1, cost: total }];

    // ── 4. Create versioned invoice ───────────────────────────────────
    const invoicePayload = {
      client_id:    clientId,
      number:       `${orderId} v${versionNum}`,
      date:         new Date().toISOString().slice(0, 10),
      public_notes: publicNotes,
      footer:       `Deposit: £${deposit.toFixed(2)}     Balance Due: £${balance.toFixed(2)}`,
      line_items:   lineItems,
    };

    const invResp = await fetch(`${NINJA_URL}/api/v1/invoices`, {
      method: 'POST', headers: apiH, body: JSON.stringify(invoicePayload),
    });

    if (!invResp.ok) {
      const txt = await invResp.text();
      return { statusCode: 500, headers: JSON_HDR, body: JSON.stringify({ ok: false, error: `Invoice create failed: ${txt.slice(0, 200)}` }) };
    }

    const invData   = await invResp.json();
    const invoiceId = invData.data && invData.data.id;
    const invoiceUrl = (invData.data && invData.data.invitations && invData.data.invitations[0])
      ? invData.data.invitations[0].link
      : `${NINJA_URL}/invoices/${invoiceId}`;

    // ── 5. Attach quote-sheet image (non-fatal if it fails) ───────────
    if (imageData && invoiceId) {
      try {
        const b64  = imageData.replace(/^data:image\/jpeg;base64,/, '');
        const buf  = Buffer.from(b64, 'base64');
        const blob = new Blob([buf], { type: 'image/jpeg' });
        const form = new FormData();
        form.append('_method', 'PUT');
        form.append('documents[]', blob, `quote-${orderId}-v${versionNum}.jpg`);

        await fetch(`${NINJA_URL}/api/v1/invoices/${invoiceId}/upload`, {
          method: 'POST',
          headers: { 'X-API-TOKEN': NINJA_KEY, 'X-Requested-With': 'XMLHttpRequest' },
          body: form,
        });
      } catch (imgErr) {
        console.error('Image upload error (non-fatal):', imgErr.message);
      }
    }

    return {
      statusCode: 200,
      headers: JSON_HDR,
      body: JSON.stringify({ ok: true, invoiceId, invoiceUrl, version: versionNum }),
    };

  } catch (err) {
    return { statusCode: 500, headers: JSON_HDR, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
