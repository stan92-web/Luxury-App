/*
  Netlify serverless function — fullData save proxy

  The browser's CompressionStream API is only available on Safari 16.4+.
  Older iPads (iOS 15 / early iOS 16) don't have it, so the client-side
  gzip path fails silently and fullData never reaches Sheets.

  This function accepts { orderId, fullData } as a plain POST body,
  gzips the fullData using Node's built-in zlib (no browser API needed),
  base64url-encodes it, then calls Apps Script ?action=saveFullData with
  a compact URL (~6 KB) that is well within Google's limits.

  Used as a fallback when the client-side gzip JSONP path returns false.
*/

const zlib       = require('zlib');
const { promisify } = require('util');
const gzipAsync  = promisify(zlib.gzip);

const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbyZa4WLmRU0GuUTfN3HsmhGujADWU8HiEsCd_FQEl2GLJoVK7mQi9wlHbDU3abHQ7gP/exec';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  try {
    const { orderId, fullData } = JSON.parse(event.body);
    if (!orderId || !fullData) {
      return {
        statusCode: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'missing orderId or fullData' }),
      };
    }

    // Server-side gzip → base64url — identical format to Apps Script Utilities.ungzip
    const compressed = await gzipAsync(Buffer.from(fullData, 'utf8'));
    const zdata = compressed.toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    // URL stays ~6 KB regardless of fullData size — well within Google's limits
    const qs  = new URLSearchParams({ action: 'saveFullData', orderId, zdata });
    const url = `${APPS_SCRIPT_URL}?${qs.toString()}`;

    const r = await fetch(url, { redirect: 'follow' });
    let result;
    try   { result = await r.json(); }
    catch { result = { ok: false }; }

    return {
      statusCode: 200,
      headers:    { ...CORS, 'Content-Type': 'application/json' },
      body:       JSON.stringify(result && result.ok ? result : { ok: false }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers:    { ...CORS, 'Content-Type': 'application/json' },
      body:       JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
