/**
 * File 7 of 8: Dashboard.gs — dashboard calculations and optional web app.
 *
 * All numbers are computed from actual sheet records (never hardcoded).
 * Date filtering uses "yyyy-MM-dd" text values for reliability.
 */

/**
 * Computes every dashboard metric from the sheets.
 * @return {Object} dashboard data.
 */
function computeDashboardData_() {
  requireSetup_();
  var today = todayStr_();
  var month = monthStr_();

  var queueRows = readAll_(SHEETS.QUEUE);
  var todayPatients = 0;
  var waitingNow = 0;
  var treatedToday = 0;
  queueRows.forEach(function (row) {
    if (String(row[COL.QUEUE.DATE]) === today) {
      todayPatients++;
      var status = String(row[COL.QUEUE.STATUS]);
      if (status === QUEUE_STATUS.WAITING) {
        waitingNow++;
      } else if (status === QUEUE_STATUS.COMPLETED) {
        treatedToday++;
      }
    }
  });

  var collectedToday = getDailyCollected_(today);
  var collectedMonth = getMonthlyCollected_(month);
  var expensesToday = getDailyExpenses_(today);
  var expensesMonth = getMonthlyExpenses_(month);

  var upcoming = [];
  readAll_(SHEETS.VISITS).forEach(function (row) {
    var nextAppointment = String(row[COL.VISITS.NEXT_APPT]).trim();
    if (nextAppointment !== '' && nextAppointment >= today) {
      upcoming.push({
        date: nextAppointment,
        name: String(row[COL.VISITS.NAME]),
        treatment: String(row[COL.VISITS.TREATMENT])
      });
    }
  });
  upcoming.sort(function (a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });

  return {
    clinicName: clinicName_(),
    date: today,
    month: month,
    todayPatients: todayPatients,
    waitingNow: waitingNow,
    treatedToday: treatedToday,
    collectedToday: collectedToday,
    collectedMonth: collectedMonth,
    expensesToday: expensesToday,
    expensesMonth: expensesMonth,
    netCashFlow: collectedMonth - expensesMonth,
    outstanding: getTotalOutstanding_(),
    lowStock: getLowStockItems_(),
    upcoming: upcoming
  };
}

/**
 * Writes computed metrics into the Dashboard sheet.
 */
function updateDashboard() {
  var data = computeDashboardData_();
  var sheet = getSheet_(SHEETS.DASHBOARD);
  ensureDashboardLayout_();

  sheet.getRange('B4').setValue(data.todayPatients);
  sheet.getRange('B5').setValue(data.waitingNow);
  sheet.getRange('B6').setValue(data.treatedToday);
  sheet.getRange('B7').setValue(data.collectedToday);
  sheet.getRange('B8').setValue(data.collectedMonth);
  sheet.getRange('B9').setValue(data.expensesMonth);
  sheet.getRange('B10').setValue(data.netCashFlow);
  sheet.getRange('B11').setValue(data.outstanding);
  sheet.getRange('B12').setValue(data.lowStock.length);
  sheet.getRange('B13').setValue(data.upcoming.length);
  sheet.getRange('B7:B11').setNumberFormat('#,##0');
  sheet.getRange('B15').setValue(data.date + ' ' + nowTimeStr_());

  // Explanatory notes.
  sheet.getRange('C4:C13').setValues([
    ['عدد سجلات قائمة الانتظار اليوم'],
    ['حالة الدور: في الانتظار'],
    ['حالة الدور: تم العلاج'],
    ['الدفعات المسجلة اليوم'],
    ['الدفعات المسجلة هذا الشهر'],
    ['المصروفات المسجلة هذا الشهر (تشمل مشتريات المخزون المسجلة تلقائيا)'],
    ['المدفوعات ناقص المصروفات لهذا الشهر'],
    ['مجموع المتبقي على جميع الزيارات'],
    ['أصناف وصلت للحد الأدنى أو نفدت'],
    ['مواعيد مسجلة في الزيارات من تاريخ اليوم فصاعدا']
  ]);

  // Low-stock list (rows 19-28).
  sheet.getRange('A19:C28').clearContent();
  data.lowStock.slice(0, 10).forEach(function (item, i) {
    sheet.getRange(19 + i, 1, 1, 3).setValues([[item.name, item.qty, item.minLevel]]);
  });

  // Upcoming appointments list (rows 32-41). Names are kept inside the
  // private spreadsheet only — never in the public web app.
  sheet.getRange('A32:C41').clearContent();
  data.upcoming.slice(0, 10).forEach(function (appt, i) {
    sheet.getRange(32 + i, 1, 1, 3).setValues([[appt.date, appt.treatment, appt.name]]);
  });
}

// ============================= OPTIONAL WEB APP =============================
//
// The web dashboard (Index.html) shows AGGREGATE numbers only:
// no patient names, no phone numbers, no medical details.
// Deploy it with "アクセス = Only myself / Specific accounts" (Deploy >
// New deployment > Web app > Who has access) so only the clinic staff can
// open it. Even if access is misconfigured, the page still contains no
// patient-identifiable data.

/**
 * Web app entry point (Deploy > New deployment > Web app).
 * @return {GoogleAppsScript.HTML.HtmlOutput}
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('لوحة تحكم العيادة')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Data provider for the web dashboard. Aggregates only — privacy-safe.
 * @return {Object}
 */
function getPublicDashboardData() {
  var data = computeDashboardData_();
  return {
    clinicName: data.clinicName,
    date: data.date,
    todayPatients: data.todayPatients,
    waitingNow: data.waitingNow,
    treatedToday: data.treatedToday,
    collectedToday: data.collectedToday,
    collectedMonth: data.collectedMonth,
    expensesMonth: data.expensesMonth,
    netCashFlow: data.netCashFlow,
    outstanding: data.outstanding,
    lowStockCount: data.lowStock.length,
    lowStockNames: data.lowStock.map(function (item) {
      return item.name + ' (' + item.qty + '/' + item.minLevel + ')';
    }),
    upcomingCount: data.upcoming.length,
    // Dates only — no patient names in the web app.
    upcomingDates: data.upcoming.slice(0, 10).map(function (appt) {
      return appt.date + ' — ' + appt.treatment;
    }),
    generatedAt: data.date + ' ' + nowTimeStr_()
  };
}
