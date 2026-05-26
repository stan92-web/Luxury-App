/*
  Netlify serverless function — order save proxy

  The browser cannot POST directly to Apps Script because:
    1. The exec URL returns a 302 redirect, and re-POSTing to the redirect
       target from an external server fails silently.
    2. JSONP GET from the browser has browser URL-length limits (~8 KB) which
       truncates large payloads.

  Solution: browser POSTs here (same-origin, no CORS), and this function
  converts it to a server-side GET to Apps Script.  From Node.js:
    • redirect:'follow' on a GET correctly follows the 302 without losing params
    • No browser URL-length limit — Node.js handles arbitrarily long URLs
    • Apps Script doGet ?action=save handles the request normally
*/

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
    const payload = JSON.parse(event.body);

    // Convert to GET — Apps Script ?action=save endpoint, no redirect body loss
    const qs  = new URLSearchParams({ action: 'save', data: JSON.stringify(payload) });
    const url = `${APPS_SCRIPT_URL}?${qs.toString()}`;

    const r = await fetch(url, { redirect: 'follow' });

    let result;
    try   { result = await r.json(); }
    catch { result = { ok: false };  }

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
