/*
  ══════════════════════════════════════════════════════
  LUXURY HOUSE — Google Apps Script for Order Storage
  ══════════════════════════════════════════════════════

  HOW TO DEPLOY:
  1. Go to sheets.google.com and create a new spreadsheet
     named "Luxury House Orders"
  2. Click Extensions → Apps Script
  3. Delete any existing code and paste ALL of this file
  4. Click Save (floppy disk icon)
  5. Click Deploy → New deployment
  6. Click the gear icon next to "Type" → select Web App
  7. Set:  Execute as → Me
           Who has access → Anyone
  8. Click Deploy → Authorise access (sign in to Google)
  9. Copy the Web App URL
  10. Paste it into js/data.js as the SHEETS_URL value

  The spreadsheet will auto-create an "Orders" sheet on
  first save with all the correct column headers.
  ══════════════════════════════════════════════════════
*/

// ── Save an order (called by the app on Save Order) ──
function doPost(e) {
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Orders');

    // Auto-create sheet with headers on first use
    if (!sheet) {
      sheet = ss.insertSheet('Orders');
      sheet.appendRow([
        'Order ID', 'Property', 'Saved At', 'Version', 'Status',
        'Rep', 'Customer', 'Phone', 'Door No', 'Address',
        'Rooms', 'Total £', 'Deposit £', 'Balance £',
        'Full Data'
      ]);
      sheet.setFrozenRows(1);
      // Bold header row
      sheet.getRange(1, 1, 1, 15).setFontWeight('bold');
    }

    var data = JSON.parse(e.postData.contents);

    sheet.appendRow([
      data.orderId   || '',
      data.property  || '',
      data.savedAt   || new Date().toISOString(),
      data.version   || 1,
      data.status    || 'Quote',
      data.rep       || '',
      data.customer  || '',
      data.phone     || '',
      data.doorNo    || '',
      data.address   || '',
      data.rooms     || '',
      data.total     || '',
      data.deposit   || '',
      data.balance   || '',
      data.fullData  || ''
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, orderId: data.orderId }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── Load all orders (called by Orders panel in the app) ──
function doGet(e) {
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Orders');
    if (!sheet || sheet.getLastRow() < 2) {
      return ContentService
        .createTextOutput(JSON.stringify({ orders: [] }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var rows    = sheet.getDataRange().getValues();
    var headers = rows[0];
    var orders  = rows.slice(1).map(function(row) {
      var obj = {};
      headers.forEach(function(h, i) { obj[h] = row[i]; });
      return obj;
    });

    return ContentService
      .createTextOutput(JSON.stringify({ orders: orders }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
