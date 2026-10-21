/**
 * Dental Clinic Management System - Google Apps Script
 * File 1 of 8: Code.gs — configuration, menu, and shared utilities.
 *
 * Architecture:
 *   Code.gs       - config constants, menu, shared helpers (this file)
 *   Setup.gs      - creates sheets/headers, sample data, backups
 *   Queue.gs      - patient registration, queue management, search
 *   Finance.gs    - visits, payments (income), expenses
 *   Inventory.gs  - inventory items and purchases
 *   WhatsApp.gs   - Arabic message templates and wa.me click-to-chat links
 *   Dashboard.gs  - dashboard calculations + optional web app (Index.html)
 *   Tests.gs      - self-test with sample records
 *
 * The user interface is Arabic (RTL). Code comments are English.
 * Zero cost: Google Sheets + Apps Script only. WhatsApp is manual (links).
 */

// ============================= CONFIGURATION =============================

const SHEETS = {
  PATIENTS: 'المرضى',
  QUEUE: 'قائمة الانتظار',
  VISITS: 'الزيارات والعلاجات',
  INCOME: 'الدفعات',
  EXPENSES: 'المصروفات',
  INVENTORY: 'المخزون',
  PURCHASES: 'مشتريات المخزون',
  DASHBOARD: 'لوحة التحكم',
  SETTINGS: 'الإعدادات'
};

// Headers must match exactly what setupSystem() writes to each sheet.
const HEADERS = {
  PATIENTS: ['المعرف', 'الاسم الكامل', 'رقم واتساب', 'تاريخ التسجيل', 'ملاحظات', 'تاريخ آخر زيارة'],
  QUEUE: ['المعرف', 'التاريخ', 'معرف المريض', 'اسم المريض', 'رقم الهاتف', 'وقت الوصول',
    'رقم الدور', 'نوع العلاج', 'حالة الدور', 'الوقت المتوقع للدور', 'حالة آخر إشعار'],
  VISITS: ['المعرف', 'التاريخ', 'معرف المريض', 'اسم المريض', 'نوع العلاج', 'تفاصيل العلاج',
    'السعر الإجمالي (دج)', 'المبلغ المدفوع (دج)', 'المبلغ المتبقي (دج)', 'الموعد القادم', 'ملاحظات الطبيب'],
  INCOME: ['المعرف', 'التاريخ', 'معرف المريض', 'اسم المريض', 'المبلغ المدفوع (دج)',
    'طريقة الدفع', 'العلاج المرتبط', 'ملاحظات'],
  EXPENSES: ['المعرف', 'التاريخ', 'فئة المصروف', 'الوصف', 'المبلغ (دج)', 'المورد', 'ملاحظات'],
  INVENTORY: ['المعرف', 'اسم الصنف', 'الفئة', 'الكمية الحالية', 'الحد الأدنى للمخزون', 'الوحدة',
    'تاريخ آخر شراء', 'سعر آخر شراء', 'المورد', 'حالة المخزون'],
  PURCHASES: ['المعرف', 'التاريخ', 'معرف الصنف', 'اسم الصنف', 'الكمية المشتراة',
    'سعر الوحدة', 'التكلفة الإجمالية', 'المورد', 'ملاحظات'],
  SETTINGS: ['المفتاح', 'القيمة', 'الوصف']
};

// 0-based column indexes. Keep in sync with HEADERS above.
const COL = {
  PATIENTS: { ID: 0, NAME: 1, PHONE: 2, REG_DATE: 3, NOTES: 4, LAST_VISIT: 5 },
  QUEUE: { ID: 0, DATE: 1, PATIENT_ID: 2, NAME: 3, PHONE: 4, ARRIVAL: 5, NUMBER: 6,
    TREATMENT: 7, STATUS: 8, TURN_TIME: 9, NOTIFY: 10 },
  VISITS: { ID: 0, DATE: 1, PATIENT_ID: 2, NAME: 3, TREATMENT: 4, DETAILS: 5,
    TOTAL: 6, PAID: 7, REMAINING: 8, NEXT_APPT: 9, NOTES: 10 },
  INCOME: { ID: 0, DATE: 1, PATIENT_ID: 2, NAME: 3, AMOUNT: 4, METHOD: 5, TREATMENT: 6, NOTES: 7 },
  EXPENSES: { ID: 0, DATE: 1, CATEGORY: 2, DESC: 3, AMOUNT: 4, SUPPLIER: 5, NOTES: 6 },
  INVENTORY: { ID: 0, NAME: 1, CATEGORY: 2, QTY: 3, MIN: 4, UNIT: 5,
    LAST_DATE: 6, LAST_PRICE: 7, SUPPLIER: 8, STATUS: 9 },
  PURCHASES: { ID: 0, DATE: 1, ITEM_ID: 2, ITEM_NAME: 3, QTY: 4, UNIT_PRICE: 5,
    TOTAL: 6, SUPPLIER: 7, NOTES: 8 }
};

// Queue statuses. These exact strings are used in code, validation and filters.
const QUEUE_STATUS = {
  WAITING: 'في الانتظار',
  IN_TREATMENT: 'قيد العلاج',
  COMPLETED: 'تم العلاج',
  CANCELLED: 'ملغى'
};

// Stock statuses (computed from quantity vs minimum level).
const STOCK_STATUS = {
  OK: 'متوفر',
  LOW: 'منخفض',
  OUT: 'نفد المخزون'
};

const PAYMENT_METHODS = ['نقدًا', 'الذهبية (بريدي موب)', 'بطاقة CIB', 'شيك', 'أخرى'];

const YES = 'نعم';
const NO = 'لا';

// Settings sheet keys (configurable by the user in the sheet).
const SETTINGS = {
  CLINIC_NAME: 'اسم العيادة',
  AVG_DURATION: 'متوسط مدة العلاج (دقيقة)',
  DAY_START: 'بداية الدوام',
  AUTO_EXPENSE: 'تسجيل مشتريات المخزون تلقائيا في المصروفات',
  PURCHASE_CATEGORY: 'فئة مصروف شراء المستلزمات'
};

const DEFAULT_SETTINGS = [
  [SETTINGS.CLINIC_NAME, 'عيادة طب الأسنان', 'الاسم المستخدم في الرسائل واللوحة'],
  [SETTINGS.AVG_DURATION, '30', 'متوسط مدة العلاج بالدقائق، يُستخدم لتقدير وقت الدور'],
  [SETTINGS.DAY_START, '08:30', 'بداية الدوام بصيغة HH:mm'],
  [SETTINGS.AUTO_EXPENSE, YES, 'نعم: كل شراء مخزون يُسجل تلقائيا كمصروف (لا تُسجّله مرة أخرى يدويا)'],
  [SETTINGS.PURCHASE_CATEGORY, 'مستلزمات طبية', 'فئة المصروف التي تُسجّل تحتها مشتريات المخزون']
];

const MENU_NAME = 'إدارة العيادة';

// ============================= MENU =============================

/**
 * Simple trigger: builds the clinic menu when the spreadsheet opens.
 */
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu(MENU_NAME)
    .addItem('إعداد النظام', 'menuSetupSystem')
    .addSeparator()
    .addItem('تسجيل مريض جديد', 'menuRegisterPatient')
    .addItem('إضافة إلى قائمة الانتظار', 'menuAddToQueue')
    .addItem('بدء العلاج', 'menuStartTreatment')
    .addItem('إنهاء العلاج', 'menuCompleteTreatment')
    .addSeparator()
    .addItem('تسجيل دفعة', 'menuRecordPayment')
    .addItem('تسجيل مصروف', 'menuRecordExpense')
    .addItem('تسجيل شراء مستلزمات', 'menuRecordPurchase')
    .addSeparator()
    .addItem('تحديث لوحة التحكم', 'menuUpdateDashboard')
    .addItem('تصدير نسخة احتياطية', 'menuExportBackup')
    .addSeparator()
    .addItem('بحث عن مريض', 'menuSearchPatient')
    .addItem('إرسال رسالة واتساب', 'menuSendWhatsApp')
    .addItem('إضافة صنف للمخزون', 'menuAddInventoryItem')
    .addItem('تحديث حالة المخزون', 'menuRefreshStockStatus')
    .addSeparator()
    .addItem('بيانات تجريبية (للاختبار)', 'menuLoadSampleData')
    .addItem('مسح البيانات التجريبية', 'menuClearSampleData')
    .addItem('تشغيل الاختبارات', 'menuRunTests')
    .addToUi();
}

// Thin UI wrappers (safe to call from the menu; every error shows an Arabic alert).

function menuSetupSystem() {
  runUi_(function () {
    setupSystem();
    alert_('إعداد النظام', 'تم إنشاء جميع الأوراق والإعدادات بنجاح.');
  });
}

function menuRegisterPatient() {
  runUi_(uiRegisterPatient);
}

function menuAddToQueue() {
  runUi_(uiAddToQueue);
}

function menuStartTreatment() {
  runUi_(uiStartTreatment);
}

function menuCompleteTreatment() {
  runUi_(uiCompleteTreatment);
}

function menuRecordPayment() {
  runUi_(uiRecordPayment);
}

function menuRecordExpense() {
  runUi_(uiRecordExpense);
}

function menuRecordPurchase() {
  runUi_(uiRecordPurchase);
}

function menuUpdateDashboard() {
  runUi_(function () {
    updateDashboard();
    alert_('لوحة التحكم', 'تم تحديث لوحة التحكم بنجاح.');
  });
}

function menuExportBackup() {
  runUi_(function () {
    var result = exportBackup();
    alert_('نسخة احتياطية', result);
  });
}

function menuSearchPatient() {
  runUi_(uiSearchPatient);
}

function menuSendWhatsApp() {
  runUi_(uiSendWhatsApp);
}

function menuAddInventoryItem() {
  runUi_(uiAddInventoryItem);
}

function menuRefreshStockStatus() {
  runUi_(function () {
    var count = refreshAllStockStatuses();
    alert_('المخزون', 'تم تحديث حالة المخزون لـ ' + count + ' صنف.');
  });
}

function menuLoadSampleData() {
  runUi_(function () {
    loadSampleData();
    alert_('بيانات تجريبية', 'تم إدخال بيانات تجريبية (المعرفات تبدأ بـ TEST-). يمكن مسحها من قائمة "مسح البيانات التجريبية".');
  });
}

function menuClearSampleData() {
  runUi_(function () {
    var count = clearSampleData();
    alert_('بيانات تجريبية', 'تم مسح ' + count + ' صف تجريبي.');
  });
}

function menuRunTests() {
  runUi_(function () {
    var report = runTests();
    alert_('نتائج الاختبارات', report);
  });
}

// ============================= SHARED HELPERS =============================

/**
 * Runs a UI flow and converts any thrown error into an Arabic alert.
 * @param {Function} fn
 */
function runUi_(fn) {
  try {
    fn();
  } catch (err) {
    alert_('خطأ', String(err && err.message ? err.message : err));
  }
}

/**
 * Returns a sheet by name or throws an Arabic error.
 * @param {string} name
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getSheet_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) {
    throw new Error('الورقة "' + name + '" غير موجودة. يرجى تشغيل "إعداد النظام" أولا.');
  }
  return sheet;
}

/**
 * Returns a sheet by name or creates it (used by setup only).
 * @param {string} name
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getOrCreateSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  return sheet;
}

/**
 * Throws if the system has not been set up yet.
 */
function requireSetup_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PATIENTS);
  if (!sheet || sheet.getLastRow() < 1 || sheet.getRange(1, 1).getValue() !== HEADERS.PATIENTS[0]) {
    throw new Error('النظام غير جاهز. اضغط على "إدارة العيادة" ثم "إعداد النظام" أولا.');
  }
}

/**
 * Appends one row to a sheet and returns the new row number.
 * @param {string} sheetName
 * @param {Array} values
 * @return {number}
 */
function appendRow_(sheetName, values) {
  var sheet = getSheet_(sheetName);
  sheet.appendRow(values);
  return sheet.getLastRow();
}

/**
 * Reads all data rows of a sheet (excludes the header row).
 * @param {string} sheetName
 * @return {Array<Array>}
 */
function readAll_(sheetName) {
  var sheet = getSheet_(sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }
  return sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
}

/**
 * Generates the next sequential ID like "P-0001" for a sheet's ID column.
 * IDs not matching ^prefix-digits$ (e.g. sample "TEST-..." ids) are ignored.
 * @param {string} sheetName
 * @param {string} prefix
 * @return {string}
 */
function nextId_(sheetName, prefix) {
  var sheet = getSheet_(sheetName);
  var lastRow = sheet.getLastRow();
  var max = 0;
  if (lastRow > 1) {
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    var re = new RegExp('^' + prefix + '-(\\d+)$');
    for (var i = 0; i < ids.length; i++) {
      var m = String(ids[i][0]).match(re);
      if (m) {
        var n = parseInt(m[1], 10);
        if (n > max) {
          max = n;
        }
      }
    }
  }
  return prefix + '-' + ('0000' + (max + 1)).slice(-4);
}

/**
 * Spreadsheet timezone, defaulting to Algeria.
 * @return {string}
 */
function getSpreadsheetTz_() {
  try {
    return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'Africa/Algiers';
  } catch (e) {
    return 'Africa/Algiers';
  }
}

/**
 * Today's date as "yyyy-MM-dd" (stored as text for reliable filtering).
 * @return {string}
 */
function todayStr_() {
  return Utilities.formatDate(new Date(), getSpreadsheetTz_(), 'yyyy-MM-dd');
}

/**
 * Current month as "yyyy-MM".
 * @return {string}
 */
function monthStr_() {
  return todayStr_().slice(0, 7);
}

/**
 * Current time as "HH:mm".
 * @return {string}
 */
function nowTimeStr_() {
  return Utilities.formatDate(new Date(), getSpreadsheetTz_(), 'HH:mm');
}

/**
 * Validates a "yyyy-MM-dd" date string.
 * @param {string} dateStr
 * @return {boolean}
 */
function isValidDateStr_(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) {
    return false;
  }
  var parts = String(dateStr).split('-');
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return d.getFullYear() === Number(parts[0]) &&
    d.getMonth() === Number(parts[1]) - 1 &&
    d.getDate() === Number(parts[2]);
}

/**
 * Validates a "HH:mm" time string.
 * @param {string} timeStr
 * @return {boolean}
 */
function isValidTimeStr_(timeStr) {
  if (!/^\d{2}:\d{2}$/.test(String(timeStr))) {
    return false;
  }
  var parts = String(timeStr).split(':');
  return Number(parts[0]) <= 23 && Number(parts[1]) <= 59;
}

/**
 * Parses a positive money amount. Returns the number or throws.
 * @param {*} raw
 * @param {string} label Arabic field label for the error message.
 * @return {number}
 */
function parseAmount_(raw, label) {
  var cleaned = String(raw).replace(/\s/g, '').replace(/دج/g, '').replace(/,/g, '.');
  if (cleaned === '') {
    throw new Error('القيمة المدخلة في "' + label + '" فارغة. أدخل رقما فقط.');
  }
  var value = Number(cleaned);
  if (!isFinite(value) || isNaN(value)) {
    throw new Error('القيمة المدخلة في "' + label + '" غير صحيحة. أدخل رقما فقط.');
  }
  return value;
}

/**
 * Parses a positive integer (stock quantities).
 * @param {*} raw
 * @param {string} label
 * @return {number}
 */
function parsePositiveInt_(raw, label) {
  var value = parseAmount_(raw, label);
  if (value < 0 || value !== Math.floor(value)) {
    throw new Error('القيمة المدخلة في "' + label + '" يجب أن تكون عددا صحيحا غير سالب.');
  }
  return value;
}

/**
 * Normalizes an Algerian phone number to international format "213XXXXXXXXX".
 * Accepted inputs: 0555123456, +213555123456, 213555123456, 00213555123456,
 * and spaced/dashed variants. Valid mobile numbers are 213 + 9 digits
 * starting with 5, 6 or 7 (Algerian mobile prefixes 05 / 06 / 07).
 * @param {*} raw
 * @return {{ok: boolean, phone?: string, error?: string}}
 */
function normalizeDzPhone_(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { ok: false, error: 'رقم الهاتف فارغ.' };
  }
  var digits = String(raw).replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (digits.indexOf('00') === 0) {
    digits = digits.slice(2);
  }
  if (digits.length === 10 && digits.charAt(0) === '0') {
    digits = '213' + digits.slice(1);
  } else if (digits.length === 9) {
    digits = '213' + digits;
  }
  if (!/^213[567]\d{8}$/.test(digits)) {
    return {
      ok: false,
      error: 'صيغة رقم الهاتف غير صحيحة. اكتب الرقم هكذا: 0555123456 أو +213555123456 (رقم جزائري يبدأ بـ 05 أو 06 أو 07).'
    };
  }
  return { ok: true, phone: digits };
}

/**
 * Escapes text for safe insertion into HTML.
 * @param {*} s
 * @return {string}
 */
function escapeHtml_(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Shows an Arabic alert dialog.
 * @param {string} title
 * @param {string} message
 */
function alert_(title, message) {
  SpreadsheetApp.getUi().alert(title, message, SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * Prompts the user for text. Returns the trimmed answer.
 * Throws if the user cancels.
 * @param {string} title
 * @param {string} message
 * @param {string=} defaultText
 * @return {string}
 */
function prompt_(title, message, defaultText) {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt(title, message, ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) {
    throw new Error('تم إلغاء العملية.');
  }
  return response.getResponseText().trim();
}

/**
 * Prompts the user to pick one option from a numbered list.
 * Retries up to 3 times, then throws.
 * @param {string} title
 * @param {string} message Arabic question (options are appended automatically).
 * @param {Array<string>} options
 * @return {string} the chosen option
 */
function promptChoice_(title, message, options) {
  var fullMessage = message + '\n' + options.map(function (o, i) {
    return (i + 1) + ') ' + o;
  }).join('\n') + '\n\nأدخل الرقم المناسب:';
  for (var attempt = 0; attempt < 3; attempt++) {
    var answer = prompt_(title, fullMessage);
    var index = parseInt(answer, 10);
    if (!isNaN(index) && index >= 1 && index <= options.length) {
      return options[index - 1];
    }
    alert_('خطأ', 'الاختيار غير صحيح. أدخل رقما بين 1 و ' + options.length + '.');
  }
  throw new Error('تم إلغاء العملية بعد عدة محاولات غير صحيحة.');
}

/**
 * Shows a toast message in the spreadsheet.
 * @param {string} message
 */
function toast_(message) {
  SpreadsheetApp.getActiveSpreadsheet().toast(message, MENU_NAME, 5);
}

/**
 * Opens a URL in the user's browser from the spreadsheet UI.
 * Shows a fallback clickable link in case the popup is blocked.
 * @param {string} url
 * @param {string} title
 * @param {string=} note Extra Arabic note shown under the link.
 */
function openUrl_(url, title, note) {
  var safeUrl = escapeHtml_(url);
  var safeNote = note ? '<p style="color:#555;font-size:12px">' + escapeHtml_(note) + '</p>' : '';
  var html = '<!DOCTYPE html><html dir="rtl"><head><base target="_blank">' +
    '<style>body{font-family:Tahoma,Arial,sans-serif;text-align:center;padding:20px;color:#1f2937}' +
    'a.btn{display:inline-block;margin:12px 0;padding:10px 22px;background:#0f766e;color:#fff;' +
    'text-decoration:none;border-radius:8px;font-size:16px}</style></head><body>' +
    '<p>اضغط على الزر لفتح الرابط:</p>' +
    '<a class="btn" href="' + safeUrl + '">' + escapeHtml_(title) + '</a>' +
    safeNote +
    '</body></html>';
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(440).setHeight(260),
    title
  );
}

/**
 * Reads a key from the Settings sheet (falls back to the default value).
 * @param {string} key
 * @param {string} defaultValue
 * @return {string}
 */
function getSetting_(key, defaultValue) {
  try {
    var rows = readAll_(SHEETS.SETTINGS);
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][0]).trim() === key) {
        var value = String(rows[i][1]).trim();
        return value === '' ? defaultValue : value;
      }
    }
  } catch (e) {
    // Settings sheet not created yet: fall through to the default.
  }
  return defaultValue;
}

/**
 * Returns the clinic name from settings.
 * @return {string}
 */
function clinicName_() {
  return getSetting_(SETTINGS.CLINIC_NAME, 'عيادة طب الأسنان');
}

/**
 * Returns the average treatment duration in minutes (minimum 1).
 * @return {number}
 */
function avgTreatmentMinutes_() {
  var value = parseInt(getSetting_(SETTINGS.AVG_DURATION, '30'), 10);
  return isNaN(value) || value < 1 ? 30 : value;
}
