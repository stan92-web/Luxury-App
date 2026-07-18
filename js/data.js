/* ══════════════════════════════════════════════
   data.js — App config & product catalogue
   ─────────────────────────────────────────────
   This is the ONLY file you need to edit for:
     • Adding / removing door styles
     • Updating sliding door collections / frames
     • Setting your Google Sheets URL
     • Setting your EmailJS credentials
     • Changing the office WhatsApp number
══════════════════════════════════════════════ */

const AppData = (() => {

  /* ── WhatsApp ─────────────────────────────── */
  const OFFICE_WA = '447308154580'; // Office WhatsApp (digits only, no +)

  /* ── Google Sheets (Apps Script Web App URL) ─
     1. Open your Google Sheet
     2. Extensions → Apps Script
     3. Paste the code from setup/google-apps-script.js
     4. Deploy → New deployment → Web App
        Execute as: Me | Access: Anyone
     5. Copy the Web App URL and paste below        */
  const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbyZa4WLmRU0GuUTfN3HsmhGujADWU8HiEsCd_FQEl2GLJoVK7mQi9wlHbDU3abHQ7gP/exec';

  /* ── Invoice Ninja ────────────────────────────
     1. Log in to Invoice Ninja (invoicing.co or self-hosted)
     2. Settings → API Tokens → create a token and copy it
     3. In Netlify dashboard → Site settings → Environment variables, add:
          NINJA_URL  =  https://invoicing.co   (your Invoice Ninja base URL)
          NINJA_KEY  =  your_api_token_here
     4. Paste your Invoice Ninja base URL below (used to open invoices):  */
  const NINJA_URL = ''; // ← e.g. 'https://invoicing.co'

  /* ── EmailJS ──────────────────────────────────
     1. Register free at emailjs.com
     2. Add Email Service (connect Gmail)
     3. Create Email Template — include these vars:
          {{to_name}}  {{to_email}}  {{rep_name}}
          {{address}}  {{quote_date}}  {{quote_image}}
     4. Paste your IDs below                        */
  const EMAILJS_SERVICE  = ''; // ← e.g. 'service_abc123'
  const EMAILJS_TEMPLATE = ''; // ← e.g. 'template_xyz789'
  const EMAILJS_PUBLIC   = ''; // ← e.g. 'user_ABCdef123'

  /* ── Hinged door catalogue ────────────────── */
  const HINGED_RANGES = [
    { range: 'Glacier', finishes: [
      'High Gloss White',
      'High Gloss Cashmere',
      'High Gloss Light Grey & Graphite',
      'Super Matt Fir Green',
      'Super Matt Light Grey',
      'Super Matt Black',
      'Super Matt Graphite',
      'Super Matt Stone Grey & Cashmere',
    ]},
    { range: 'Turnberry', finishes: ['Ultra Matt Cashmere'] },
    { range: 'Bamburgh',  finishes: ['Ultra Matt White'] },
    { range: 'Hampton',   finishes: ['Ultra Matt Graphite', 'Ultra Matt Mussel'] },
    { range: 'Matfen',    finishes: [
      'Parisian Blue Oak',
      'Dust Grey Oak & Light Grey Oak',
      'Light Grey Oak & Graphite Oak',
    ]},
    { range: 'Alnwick',  finishes: ['Ultra Matt White Grey'] },
    { range: 'Portree',  finishes: ['Ultra Matt Indigo', 'White Oak'] },
    { range: 'Glendale', finishes: ['Ultra Matt Pale Cream'] },
    { range: 'Arko',     finishes: ['Light Casella Oak & Reed Green Oak'] },
    { range: 'Rialto',   finishes: ['Ultra Matt Dust Grey', 'Ultra Matt Cashmere'] },
    { range: 'Monaco',   finishes: ['Light Concrete'] },
    { range: 'Scoop',    finishes: ['Ultra Matt Light Grey'] },
  ];

  /* ── Sliding door collections ─────────────── */
  const SLIDING_COLLECTIONS = [
    'Heritage', 'Florence', 'Napoli', 'Torino', 'Tuscany', 'Venice',
  ];

  /* ── Frame / profile options ──────────────── */
  const FRAME_PROFILES = [
    'Polished Silver', 'Satin Silver', 'Bronze', 'Satin Bronze',
    'Black', 'White', 'Graphite', 'Satin Graphite', 'Satin Gold',
  ];

  /* ── Lead sources ─────────────────────────── */
  const LEAD_SOURCES = [
    'Website Enquiry', 'Referral', 'Social Media',
    'Showroom Visit', 'Google Ads', 'Other',
  ];

  return {
    OFFICE_WA,
    SHEETS_URL,
    NINJA_URL,
    EMAILJS_SERVICE,
    EMAILJS_TEMPLATE,
    EMAILJS_PUBLIC,
    HINGED_RANGES,
    SLIDING_COLLECTIONS,
    FRAME_PROFILES,
    LEAD_SOURCES,
  };
})();
