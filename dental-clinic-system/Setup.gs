/**
 * File 2 of 8: Setup.gs — one-time setup, sample data, and backups.
 */

/**
 * Creates every sheet, header row, formatting, settings, and validations.
 * Idempotent: safe to run again; never deletes existing data.
 */
function setupSystem() {
  var specs = [
    { name: SHEETS.PATIENTS, headers: HEADERS.PATIENTS },
    { name: SHEETS.QUEUE, headers: HEADERS.QUEUE },
    { name: SHEETS.VISITS, headers: HEADERS.VISITS },
    { name: SHEETS.INCOME, headers: HEADERS.INCOME },
    { name: SHEETS.EXPENSES, headers: HEADERS.EXPENSES },
    { name: SHEETS.INVENTORY, headers: HEADERS.INVENTORY },
    { name: SHEETS.PURCHASES, headers: HEADERS.PURCHASES },
    { name: SHEETS.DASHBOARD, headers: null },
    { name: SHEETS.SETTINGS, headers: HEADERS.SETTINGS }
  ];

  specs.forEach(function (spec) {
    var sheet = getOrCreateSheet_(spec.name);
    sheet.setRightToLeft(true);
    if (spec.headers) {
      ensureHeaders_(sheet, spec.headers);
      formatHeaderRow_(sheet);
      sheet.setFrozenRows(1);
    }
  });

  // Settings defaults (only fill keys that are missing).
  var settingsSheet = getSheet_(SHEETS.SETTINGS);
  if (settingsSheet.getLastRow() < 1) {
    settingsSheet.getRange(1, 1, 1, HEADERS.SETTINGS.length).setValues([HEADERS.SETTINGS]);
    formatHeaderRow_(settingsSheet);
    settingsSheet.setFrozenRows(1);
  }
  DEFAULT_SETTINGS.forEach(function (row) {
    if (!settingKeyExists_(row[0])) {
      settingsSheet.appendRow(row);
    }
  });

  // Dropdown validations for status / method columns.
  addListValidation_(SHEETS.QUEUE, COL.QUEUE.STATUS + 1,
    [QUEUE_STATUS.WAITING, QUEUE_STATUS.IN_TREATMENT, QUEUE_STATUS.COMPLETED, QUEUE_STATUS.CANCELLED]);
  addListValidation_(SHEETS.INCOME, COL.INCOME.METHOD + 1, PAYMENT_METHODS);

  // Rename the default "Sheet1" tab if it is still empty.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var defaultSheet = ss.getSheetByName('Sheet1') || ss.getSheetByName('ورقة1');
  if (defaultSheet && defaultSheet.getLastRow() === 0 && ss.getSheets().length > 1) {
    ss.deleteSheet(defaultSheet);
  }

  ensureDashboardLayout_();
  updateDashboard();
}

/**
 * Writes the header row if the sheet is empty. Does not overwrite data.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Array<string>} headers
 */
function ensureHeaders_(sheet, headers) {
  if (sheet.getLastRow() < 1 || String(sheet.getRange(1, 1).getValue()).trim() === '') {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

/**
 * Formats row 1 as a bold, colored header.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function formatHeaderRow_(sheet) {
  sheet.getRange(1, 1, 1, sheet.getLastColumn() || 1)
    .setBackground('#0f766e')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
}

/**
 * Adds a dropdown list validation to one column (header row excluded).
 * @param {string} sheetName
 * @param {number} column 1-based column index.
 * @param {Array<string>} values
 */
function addListValidation_(sheetName, column, values) {
  var sheet = getSheet_(sheetName);
  // Reserve validation for future rows too (appendRow does not copy it).
  var lastRow = Math.max(sheet.getLastRow(), 2) + 500;
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(values, true)
    .setAllowInvalid(true)
    .build();
  sheet.getRange(2, column, lastRow - 1, 1).setDataValidation(rule);
}

/**
 * @param {string} key
 * @return {boolean}
 */
function settingKeyExists_(key) {
  var rows = readAll_(SHEETS.SETTINGS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === key) {
      return true;
    }
  }
  return false;
}

/**
 * Creates the static Dashboard labels (values are written by updateDashboard).
 */
function ensureDashboardLayout_() {
  var sheet = getSheet_(SHEETS.DASHBOARD);
  if (sheet.getLastRow() > 0 && String(sheet.getRange(1, 1).getValue()).trim() !== '') {
    return;
  }
  sheet.getRange('A1').setValue('لوحة تحكم عيادة الأسنان').setFontSize(14).setFontWeight('bold');
  sheet.getRange('A3:C3').setValues([['المؤشر', 'القيمة', 'ملاحظات']])
    .setBackground('#0f766e').setFontColor('#ffffff').setFontWeight('bold');
  var labels = [
    'عدد مرضى اليوم',
    'المرضى في الانتظار الآن',
    'المرضى الذين تم علاجهم اليوم',
    'مدفوعات اليوم (دج)',
    'مدفوعات هذا الشهر (دج)',
    'مصروفات هذا الشهر (دج)',
    'التدفق النقدي المقدر (دج)',
    'إجمالي المبالغ المتبقية على المرضى (دج)',
    'مستلزمات منخفضة المخزون',
    'المواعيد القادمة'
  ];
  labels.forEach(function (label, i) {
    sheet.getRange(4 + i, 1).setValue(label);
  });
  sheet.getRange('A15').setValue('آخر تحديث').setFontWeight('bold');
  sheet.getRange('A17').setValue('المستلزمات التي تحتاج إعادة شراء').setFontWeight('bold');
  sheet.getRange('A18:C18').setValues([['اسم الصنف', 'الكمية الحالية', 'الحد الأدنى']])
    .setBackground('#ccfbf1').setFontWeight('bold');
  sheet.getRange('A30').setValue('المواعيد القادمة').setFontWeight('bold');
  sheet.getRange('A31:C31').setValues([['التاريخ', 'نوع العلاج', 'اسم المريض']])
    .setBackground('#ccfbf1').setFontWeight('bold');
  sheet.setRightToLeft(true);
  sheet.setColumnWidth(1, 320);
  sheet.setColumnWidth(2, 160);
  sheet.setColumnWidth(3, 220);
}

// ============================= BACKUP =============================

/**
 * Copies the whole spreadsheet into a "Dental Clinic Backups" Drive folder.
 * Free: uses DriveApp with the user's own Google account storage.
 * @return {string} Arabic confirmation message.
 */
function exportBackup() {
  requireSetup_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var folderName = 'نسخ احتياطية - عيادة الأسنان';
  var folders = DriveApp.getFoldersByName(folderName);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);
  var stamp = Utilities.formatDate(new Date(), getSpreadsheetTz_(), 'yyyy-MM-dd_HHmm');
  var copy = ss.copy('نسخة احتياطية ' + stamp);
  // Move the copy from "My Drive" root into the backup folder.
  var file = DriveApp.getFileById(copy.getId());
  folder.addFile(file);
  DriveApp.getRootFolder().removeFile(file);
  return 'تم إنشاء نسخة احتياطية كاملة داخل مجلد "' + folderName + '" باسم "نسخة احتياطية ' + stamp + '".';
}

// ============================= SAMPLE DATA =============================

/**
 * Inserts sample records for testing. Every generated ID starts with "TEST-"
 * so clearSampleData() can remove them without touching real records.
 */
function loadSampleData() {
  requireSetup_();

  // Guard against loading the sample set twice (duplicate TEST- IDs).
  var patientsSheet = getSheet_(SHEETS.PATIENTS);
  var lastPatientRow = patientsSheet.getLastRow();
  if (lastPatientRow > 1) {
    var patientIds = patientsSheet.getRange(2, 1, lastPatientRow - 1, 1).getValues();
    for (var i = 0; i < patientIds.length; i++) {
      if (String(patientIds[i][0]).indexOf('TEST-') === 0) {
        throw new Error('البيانات التجريبية موجودة مسبقا. يمكنك مسحها أولا من "مسح البيانات التجريبية".');
      }
    }
  }

  var p1 = registerPatient_( 'أحمد بن علي', '0555111222', 'مريض تجريبي', 'TEST-P-001');
  var p2 = registerPatient_( 'فاطمة زهراء مراد', '0666333444', '', 'TEST-P-002');
  var p3 = registerPatient_( 'محمد الأمين بوعلام', '0777555666', 'حساسية من البنسلين', 'TEST-P-003');

  addToQueue_(p1, 'تنظيف الأسنان', { forcedId: 'TEST-Q-001' });
  addToQueue_(p2, 'حشوة تجميلية', { forcedId: 'TEST-Q-002' });
  addToQueue_(p3, 'خلع ضرس', { forcedId: 'TEST-Q-003' });

  createVisit_({
    forcedId: 'TEST-V-001',
    patientId: p1,
    treatmentType: 'تنظيف الأسنان',
    details: 'تنظيف وتلميع',
    totalPrice: 2500,
    nextAppointment: '2027-01-15',
    notes: 'زيارة تجريبية'
  });
  createVisit_({
    forcedId: 'TEST-V-002',
    patientId: p2,
    treatmentType: 'حشوة تجميلية',
    details: 'حشوة ضرس واحد',
    totalPrice: 4000,
    nextAppointment: '',
    notes: ''
  });

  recordPayment_({
    forcedId: 'TEST-T-001',
    patientId: p1,
    amount: 2500,
    method: 'نقدًا',
    visitId: 'TEST-V-001',
    notes: 'دفعة تجريبية'
  });
  recordPayment_({
    forcedId: 'TEST-T-002',
    patientId: p2,
    amount: 1500,
    method: 'الذهبية (بريدي موب)',
    visitId: 'TEST-V-002',
    notes: 'دفعة جزئية تجريبية'
  });

  recordExpense_({
    forcedId: 'TEST-E-001',
    category: 'كهرباء وماء',
    description: 'فاتورة تجريبية',
    amount: 3000,
    supplier: 'شركة تجريبية',
    notes: ''
  });

  addInventoryItem_({
    forcedId: 'TEST-I-001',
    name: 'قفازات طبية',
    category: 'مواد وقاية',
    qty: 10,
    minLevel: 20,
    unit: 'علبة',
    supplier: 'مورد تجريبي'
  });
  addInventoryItem_({
    forcedId: 'TEST-I-002',
    name: 'مخدر موضعي',
    category: 'أدوية',
    qty: 50,
    minLevel: 10,
    unit: 'أنبوب',
    supplier: 'مورد تجريبي'
  });

  recordPurchase_({
    forcedId: 'TEST-PU-001',
    forcedExpenseId: 'TEST-E-002',
    itemId: 'TEST-I-001',
    quantity: 5,
    unitPrice: 800,
    supplier: 'مورد تجريبي',
    notes: 'شراء تجريبي'
  });

  refreshAllStockStatuses();
  updateDashboard();
}

/**
 * Deletes every row whose ID (column A) starts with "TEST-".
 * @return {number} number of deleted rows.
 */
function clearSampleData() {
  requireSetup_();
  var total = 0;
  var sheetNames = [
    SHEETS.PATIENTS, SHEETS.QUEUE, SHEETS.VISITS, SHEETS.INCOME,
    SHEETS.EXPENSES, SHEETS.INVENTORY, SHEETS.PURCHASES
  ];
  sheetNames.forEach(function (name) {
    var sheet = getSheet_(name);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return;
    }
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = ids.length - 1; i >= 0; i--) {
      if (String(ids[i][0]).indexOf('TEST-') === 0) {
        sheet.deleteRow(i + 2);
        total++;
      }
    }
  });
  refreshAllStockStatuses();
  updateDashboard();
  return total;
}
