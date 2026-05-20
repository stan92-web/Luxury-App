/*
  ══════════════════════════════════════════════════════
  LUXURY HOUSE — Google Apps Script for Order Storage
  ══════════════════════════════════════════════════════

  HOW TO DEPLOY (first time):
  1. Go to sheets.google.com and create a new spreadsheet
     named "Luxury House Orders"
  2. Click Extensions → Apps Script
  3. Delete any existing code and paste ALL of this file
  4. Click Save (floppy disk icon)

  ── IMPORTANT: Authorise Google Drive access first ──
  5. In the editor, select function "setupDrive" from
     the dropdown (top toolbar, next to Debug button)
  6. Click Run — Google will ask to authorise access
  7. Click "Review permissions" → sign in → Allow
     (you must grant BOTH Spreadsheet AND Drive access)

  ── Then deploy as a Web App ──
  8. Click Deploy → New deployment
  9. Click the gear icon next to "Type" → select Web App
  10. Set:  Execute as → Me
            Who has access → Anyone
  11. Click Deploy → copy the Web App URL
  12. Paste it into js/data.js as the SHEETS_URL value

  The spreadsheet will auto-create an "Orders" sheet on
  first save with all the correct column headers.
  Images are saved to Google Drive → "Luxury House Quotes" folder.
  ══════════════════════════════════════════════════════
*/

// ── Run this ONCE manually to authorise Google Drive ──
// Select "setupDrive" in the dropdown and click Run.
// Google will ask for permission — click Allow.
function setupDrive() {
  var folders = DriveApp.getFoldersByName('Luxury House Quotes');
  var folder  = folders.hasNext()
    ? folders.next()
    : DriveApp.createFolder('Luxury House Quotes');
  Logger.log('Google Drive authorised. Folder ready: ' + folder.getName());
}

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
      sheet.getRange(1, 1, 1, 15).setFontWeight('bold');
    }

    var data = JSON.parse(e.postData.contents);

    var rowBase = [
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
      data.balance   || ''
    ];

    // Google Sheets cell limit is 50,000 chars — always save the row,
    // even if fullData is too large (row saves without it rather than failing).
    try {
      sheet.appendRow(rowBase.concat([data.fullData || '']));
    } catch (rowErr) {
      Logger.log('fullData too large (' + (data.fullData || '').length + ' chars) — saving row without it');
      sheet.appendRow(rowBase.concat(['']));
    }

    var driveStatus = 'no image in payload';

    // Save quote image to Google Drive → "Luxury House Quotes" folder
    if (data.imageData) {
      Logger.log('imageData received, length: ' + data.imageData.length);
      try {
        var folders = DriveApp.getFoldersByName('Luxury House Quotes');
        var folder  = folders.hasNext()
          ? folders.next()
          : DriveApp.createFolder('Luxury House Quotes');
        var label   = (data.property || data.orderId || 'Quote').replace(/[\/\\:*?"<>|]/g, '-');
        var date    = (data.savedAt || '').slice(0, 10);
        var fname   = label + (date ? ' ' + date : '') + '.jpg';
        // Strip data URL prefix — handle both jpeg and png
        var b64     = data.imageData.replace(/^data:image\/(jpeg|png);base64,/, '');
        var blob    = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', fname);
        folder.createFile(blob);
        driveStatus = 'saved: ' + fname;
        Logger.log('Drive image saved: ' + fname);
      } catch (driveErr) {
        driveStatus = 'drive error: ' + driveErr.message;
        Logger.log('Drive error: ' + driveErr.message);
      }
    } else {
      Logger.log('No imageData in payload — postData length: ' + (e.postData ? e.postData.contents.length : 0));
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, orderId: data.orderId, drive: driveStatus }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('doPost error: ' + err.message);
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

    var json = JSON.stringify({ orders: orders });
    var cb   = e && e.parameter && e.parameter.callback;
    return ContentService
      .createTextOutput(cb ? cb + '(' + json + ')' : json)
      .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
