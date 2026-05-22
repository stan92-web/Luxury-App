/*
  Netlify serverless function — Drive image proxy
  Browser POSTs the full-quality base64 image here (same-origin, no CORS),
  then this function forwards it to Google Apps Script as a proper POST,
  manually following the 302 redirect so the POST body is not lost.
*/

const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbyZa4WLmRU0GuUTfN3HsmhGujADWU8HiEsCd_FQEl2GLJoVK7mQi9wlHbDU3abHQ7gP/exec';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  }

  try {
    const payload = event.body;

    // Step 1 — hit Apps Script exec URL without following its 302 redirect
    const r1 = await fetch(APPS_SCRIPT_URL, {
      method:   'POST',
      headers:  { 'Content-Type': 'application/json' },
      body:     payload,
      redirect: 'manual',
    });

    let result;
    const location = r1.headers.get('location');

    if (location && (r1.status === 301 || r1.status === 302)) {
      // Step 2 — POST again to the real execution URL (googleusercontent.com)
      const r2 = await fetch(location, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    payload,
      });
      result = await r2.json();
    } else {
      result = await r1.json();
    }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
