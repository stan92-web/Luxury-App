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

// ── Shared: write one order row to the Orders sheet ──
function writeOrderRow(data) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Orders');
  if (!sheet) {
    sheet = ss.insertSheet('Orders');
    sheet.appendRow([
      'Order ID', 'Saved At', 'Version', 'Status',
      'Rep', 'Customer', 'Phone', 'Door No', 'Address',
      'Rooms', 'Total £', 'Deposit £', 'Balance £', 'Full Data'
    ]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 14).setFontWeight('bold');
  }
  var rowBase = [
    data.orderId   || '',
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
  try {
    sheet.appendRow(rowBase.concat([data.fullData || '']));
  } catch (rowErr) {
    Logger.log('fullData too large — saving row without it');
    sheet.appendRow(rowBase.concat(['']));
  }
  Logger.log('Order saved: ' + data.orderId + ' v' + data.version);
}

// ── Save via GET + JSONP (primary path — iOS Safari compatible) ──
// ── Drive image via POST (secondary path — form iframe) ─────────
function doGet(e) {
  var cb = e && e.parameter && e.parameter.callback;
  try {

    // ── Save order via GET ?action=save&data=<JSON>&callback=<cb> ──
    if (e && e.parameter && e.parameter.action === 'save') {
      var saveData = JSON.parse(e.parameter.data);
      writeOrderRow(saveData);
      var saveJson = JSON.stringify({ ok: true, orderId: saveData.orderId });
      return ContentService
        .createTextOutput(cb ? cb + '(' + saveJson + ')' : saveJson)
        .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
    }

    // ── Save Drive image via GET ?action=saveImage&orderId=..&imageData=..&callback=<cb> ──
    if (e && e.parameter && e.parameter.action === 'saveImage') {
      var imgData = e.parameter.imageData || '';
      var imgId   = e.parameter.orderId   || '';
      var imgProp = e.parameter.property  || '';
      var imgDate = (e.parameter.savedAt  || '').slice(0, 10);
      var label   = (imgProp || imgId || 'Quote').replace(/[\/\\:*?"<>|]/g, '-');
      var fname   = label + (imgDate ? ' ' + imgDate : '') + '.jpg';
      var driveMsg = 'no image';
      if (imgData) {
        try {
          var folders = DriveApp.getFoldersByName('Luxury House Quotes');
          var folder  = folders.hasNext() ? folders.next() : DriveApp.createFolder('Luxury House Quotes');
          // Accept both standard base64 and base64url (- → +, _ → /, re-pad)
          var b64 = imgData
            .replace(/^data:image\/(jpeg|png);base64,/, '')
            .replace(/-/g, '+')
            .replace(/_/g, '/');
          while (b64.length % 4) b64 += '=';
          var blob    = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', fname);
          folder.createFile(blob);
          driveMsg = 'saved: ' + fname;
          Logger.log('Drive image saved via GET: ' + fname);
        } catch (imgErr) {
          driveMsg = 'error: ' + imgErr.message;
          Logger.log('Drive image GET error: ' + imgErr.message);
        }
      }
      var imgJson = JSON.stringify({ ok: true, drive: driveMsg });
      return ContentService
        .createTextOutput(cb ? cb + '(' + imgJson + ')' : imgJson)
        .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
    }

    // ── Delete one order ?action=deleteOrder&orderId=.. ──
    if (e && e.parameter && e.parameter.action === 'deleteOrder') {
      var delId    = e.parameter.orderId || '';
      var delSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
      if (delSheet && delId) {
        var delRows  = delSheet.getDataRange().getValues();
        var delHdrs  = delRows[0];
        var delIdIdx = delHdrs.indexOf('Order ID');
        for (var di = delRows.length - 1; di >= 1; di--) {
          if (String(delRows[di][delIdIdx]) === delId) delSheet.deleteRow(di + 1);
        }
      }
      var delJson = JSON.stringify({ ok: true, deleted: delId });
      return ContentService
        .createTextOutput(cb ? cb + '(' + delJson + ')' : delJson)
        .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
    }

    // ── Save compressed fullData for an existing order ──
    // ?action=saveFullData&orderId=X&zdata=<gzip+base64url>&callback=cb
    // The browser gzips the fullData JSON and base64url-encodes it so the
    // URL stays small (~6 KB) regardless of order size.  Apps Script
    // decompresses and writes the value into the latest version row in place.
    if (e && e.parameter && e.parameter.action === 'saveFullData') {
      var sfId    = e.parameter.orderId || '';
      var sfZdata = e.parameter.zdata   || '';
      var sfOk    = false;
      if (sfId && sfZdata) {
        try {
          var sfB64   = sfZdata.replace(/-/g, '+').replace(/_/g, '/');
          while (sfB64.length % 4) sfB64 += '=';
          var sfBlob  = Utilities.newBlob(Utilities.base64Decode(sfB64), 'application/x-gzip');
          var sfFull  = Utilities.ungzip(sfBlob).getDataAsString();
          var sfSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
          if (sfSheet && sfFull) {
            var sfData  = sfSheet.getDataRange().getValues();
            var sfHdrs  = sfData[0];
            var sfIdCol = sfHdrs.indexOf('Order ID');
            var sfVCol  = sfHdrs.indexOf('Version');
            var sfFCol  = sfHdrs.indexOf('Full Data');
            var sfBest  = -1, sfBestV = -1;
            for (var sfi = 1; sfi < sfData.length; sfi++) {
              if (String(sfData[sfi][sfIdCol]) === sfId) {
                var sfV = Number(sfData[sfi][sfVCol] || 0);
                if (sfV >= sfBestV) { sfBestV = sfV; sfBest = sfi; }
              }
            }
            if (sfBest > 0 && sfFCol >= 0) {
              sfSheet.getRange(sfBest + 1, sfFCol + 1).setValue(sfFull);
              sfOk = true;
              Logger.log('saveFullData OK: ' + sfId);
            }
          }
        } catch (sfErr) { Logger.log('saveFullData error: ' + sfErr.message); }
      }
      var sfJson = JSON.stringify({ ok: sfOk, orderId: sfId });
      return ContentService
        .createTextOutput(cb ? cb + '(' + sfJson + ')' : sfJson)
        .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
    }

    // ── Fetch one order with fullData ?action=getOrder&orderId=.. ──
    if (e && e.parameter && e.parameter.action === 'getOrder') {
      var targetId  = e.parameter.orderId || '';
      var goSheet   = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
      var goJson;
      if (!goSheet || goSheet.getLastRow() < 2 || !targetId) {
        goJson = JSON.stringify({ ok: false });
      } else {
        var goRows  = goSheet.getDataRange().getValues();
        var goHdrs  = goRows[0];
        var idIdx   = goHdrs.indexOf('Order ID');
        var verIdx  = goHdrs.indexOf('Version');
        var matched = goRows.slice(1).filter(function(r) { return r[idIdx] === targetId; });
        if (!matched.length) {
          goJson = JSON.stringify({ ok: false });
        } else {
          matched.sort(function(a, b) { return Number(b[verIdx]||0) - Number(a[verIdx]||0); });
          var best = matched[0];
          var goObj = {};
          goHdrs.forEach(function(h, i) { goObj[h] = best[i]; });
          goJson = JSON.stringify({ ok: true, order: goObj });
        }
      }
      return ContentService
        .createTextOutput(cb ? cb + '(' + goJson + ')' : goJson)
        .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
    }

    // ── Load all orders (fullData stripped — fetch per order on demand) ──
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Orders');
    if (!sheet || sheet.getLastRow() < 2) {
      var emptyJson = JSON.stringify({ orders: [] });
      return ContentService
        .createTextOutput(cb ? cb + '(' + emptyJson + ')' : emptyJson)
        .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
    }

    var rows    = sheet.getDataRange().getValues();
    var headers = rows[0];
    var fdIdx   = headers.indexOf('Full Data');
    var orders  = rows.slice(1).map(function(row) {
      var obj = {};
      // fullData is omitted from the list — loaded on demand via ?action=getOrder
      // hasFullData boolean lets the client show/hide the "resave" badge correctly.
      headers.forEach(function(h, i) { obj[h] = (h === 'Full Data') ? '' : row[i]; });
      obj['hasFullData'] = fdIdx >= 0 && !!(row[fdIdx] && String(row[fdIdx]).length > 100);
      return obj;
    });

    var json = JSON.stringify({ orders: orders });
    return ContentService
      .createTextOutput(cb ? cb + '(' + json + ')' : json)
      .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('doGet error: ' + err.message);
    var errJson = JSON.stringify({ orders: [], error: err.message });
    return ContentService
      .createTextOutput(cb ? cb + '(' + errJson + ')' : errJson)
      .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
  }
}

// ── Drive image POST (form iframe, imageOnly:true payload) ──
function doPost(e) {
  try {
    // Form submissions prefix the body with "_="; strip it.
    var raw = e.postData.contents;
    if (raw.substring(0, 2) === '_=') raw = raw.substring(2);
    var data = JSON.parse(raw);

    if (!data.imageOnly) {
      // Fallback: if somehow a plain POST arrives, save it.
      writeOrderRow(data);
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true, orderId: data.orderId }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Save image to Google Drive.
    var driveMsg = 'no image';
    if (data.imageData) {
      try {
        var folders = DriveApp.getFoldersByName('Luxury House Quotes');
        var folder  = folders.hasNext() ? folders.next() : DriveApp.createFolder('Luxury House Quotes');
        var label   = (data.property || data.orderId || 'Quote').replace(/[\/\\:*?"<>|]/g, '-');
        var date    = (data.savedAt  || '').slice(0, 10);
        var fname   = label + (date ? ' ' + date : '') + '.jpg';
        var b64     = data.imageData.replace(/^data:image\/(jpeg|png);base64,/, '');
        var blob    = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', fname);
        folder.createFile(blob);
        driveMsg = 'saved: ' + fname;
        Logger.log('Drive image saved: ' + fname);
      } catch (imgErr) {
        driveMsg = 'error: ' + imgErr.message;
        Logger.log('Drive image error: ' + imgErr.message);
      }
    }
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, imageOnly: true, drive: driveMsg }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('doPost error: ' + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
