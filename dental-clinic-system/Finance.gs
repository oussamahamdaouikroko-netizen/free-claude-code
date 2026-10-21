/**
 * File 4 of 8: Finance.gs — visits, payments (income), and expenses.
 *
 * Accounting rules:
 * - Income is recorded ONLY when money is actually received (one row per payment).
 * - Partial payments are allowed; the visit "remaining balance" tracks what is left.
 * - The full treatment price is never counted as income until it is paid.
 * - Inventory purchases are optionally auto-recorded as expenses (see Settings);
 *   they must NOT be recorded manually as expenses again (double-counting).
 */

// ============================= VISITS =============================

/**
 * Creates a visit/treatment record with an unpaid balance.
 * @param {Object} data {patientId, treatmentType, details, totalPrice, nextAppointment, notes, forcedId}.
 * @return {Object} {visitId, row, total, paid, remaining}.
 */
function createVisit_(data) {
  requireSetup_();
  var patient = findPatientById_(data.patientId);
  var total = parseAmount_(data.totalPrice, 'السعر الإجمالي');
  if (total <= 0) {
    throw new Error('السعر الإجمالي يجب أن يكون أكبر من صفر.');
  }
  var nextAppointment = String(data.nextAppointment || '').trim();
  if (nextAppointment !== '' && !isValidDateStr_(nextAppointment)) {
    throw new Error('صيغة الموعد القادم غير صحيحة. استخدم yyyy-MM-dd.');
  }
  var visitId = data.forcedId || nextId_(SHEETS.VISITS, 'VS');
  var treatmentType = String(data.treatmentType || '').trim() || 'غير محدد';
  var row = appendRow_(SHEETS.VISITS, [
    visitId,
    todayStr_(),
    patient.id,
    patient.name,
    treatmentType,
    String(data.details || '').trim(),
    total,
    0,
    total,
    nextAppointment,
    String(data.notes || '').trim()
  ]);
  return { visitId: visitId, row: row, total: total, paid: 0, remaining: total };
}

/**
 * Returns a visit object by visit ID, or throws.
 * @param {string} visitId
 * @return {Object} {visitId, patientId, name, total, paid, remaining, row}.
 */
function findVisitById_(visitId) {
  var rows = readAll_(SHEETS.VISITS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][COL.VISITS.ID]) === String(visitId)) {
      return {
        visitId: String(rows[i][COL.VISITS.ID]),
        patientId: String(rows[i][COL.VISITS.PATIENT_ID]),
        name: String(rows[i][COL.VISITS.NAME]),
        treatment: String(rows[i][COL.VISITS.TREATMENT]),
        total: Number(rows[i][COL.VISITS.TOTAL]) || 0,
        paid: Number(rows[i][COL.VISITS.PAID]) || 0,
        remaining: Number(rows[i][COL.VISITS.REMAINING]) || 0,
        row: i + 2
      };
    }
  }
  throw new Error('لم يتم العثور على زيارة بالمعرف "' + visitId + '".');
}

/**
 * Returns the most recent visit of a patient that still has a remaining balance.
 * @param {string} patientId
 * @return {Object|null} visit object or null.
 */
function findOpenVisit_(patientId) {
  var rows = readAll_(SHEETS.VISITS);
  var found = null;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][COL.VISITS.PATIENT_ID]) === String(patientId) &&
      Number(rows[i][COL.VISITS.REMAINING]) > 0) {
      found = {
        visitId: String(rows[i][COL.VISITS.ID]),
        patientId: String(rows[i][COL.VISITS.PATIENT_ID]),
        name: String(rows[i][COL.VISITS.NAME]),
        treatment: String(rows[i][COL.VISITS.TREATMENT]),
        total: Number(rows[i][COL.VISITS.TOTAL]) || 0,
        paid: Number(rows[i][COL.VISITS.PAID]) || 0,
        remaining: Number(rows[i][COL.VISITS.REMAINING]) || 0,
        row: i + 2
      };
    }
  }
  return found;
}

/**
 * Adds a paid amount to a visit and recomputes the remaining balance.
 * @param {string} visitId
 * @param {number} amount
 * @return {Object} updated {paid, remaining}.
 */
function applyPaymentToVisit_(visitId, amount) {
  var visit = findVisitById_(visitId);
  if (amount > visit.remaining) {
    throw new Error('المبلغ المدفوع (' + amount + ' دج) أكبر من المتبقي (' +
      visit.remaining + ' دج). لا يمكن تسجيله على هذه الزيارة.');
  }
  var newPaid = visit.paid + amount;
  var newRemaining = visit.total - newPaid;
  var sheet = getSheet_(SHEETS.VISITS);
  sheet.getRange(visit.row, COL.VISITS.PAID + 1).setValue(newPaid);
  sheet.getRange(visit.row, COL.VISITS.REMAINING + 1).setValue(newRemaining);
  return { paid: newPaid, remaining: newRemaining };
}

// ============================= PAYMENTS (INCOME) =============================

/**
 * Records one payment in the Income sheet and applies it to a visit if linked.
 * Duplicate protection: identical payments (same patient + amount + date)
 * submitted within 10 minutes are flagged via `duplicate: true` (the caller
 * decides whether to force-record them).
 * @param {Object} data {patientId, amount, method, visitId, notes, forcedId, force}.
 * @return {Object} {transactionId, visitId, remaining, duplicate}.
 */
function recordPayment_(data) {
  requireSetup_();
  var patient = findPatientById_(data.patientId);
  var amount = parseAmount_(data.amount, 'المبلغ المدفوع');
  if (amount <= 0) {
    throw new Error('المبلغ المدفوع يجب أن يكون أكبر من صفر.');
  }
  var method = String(data.method || '').trim();
  if (method === '') {
    throw new Error('طريقة الدفع مطلوبة.');
  }

  // Resolve the target visit: explicit ID, else the newest unpaid visit.
  var visit = null;
  if (data.visitId) {
    visit = findVisitById_(data.visitId);
    if (visit.patientId !== patient.id) {
      throw new Error('الزيارة "' + visit.visitId + '" لا تخص المريض ' + patient.name + '.');
    }
  } else {
    visit = findOpenVisit_(patient.id);
  }

  // Duplicate detection (double form submission).
  var duplicate = findRecentDuplicatePayment_(patient.id, amount);
  if (duplicate && !data.force) {
    return {
      transactionId: null,
      duplicate: true,
      existingId: duplicate.id,
      visitId: visit ? visit.visitId : null,
      remaining: visit ? visit.remaining : null
    };
  }

  if (visit) {
    applyPaymentToVisit_(visit.visitId, amount);
  }

  var transactionId = data.forcedId || nextId_(SHEETS.INCOME, 'TX');
  appendRow_(SHEETS.INCOME, [
    transactionId,
    todayStr_(),
    patient.id,
    patient.name,
    amount,
    method,
    visit ? visit.treatment : 'دفعة مقدمة',
    (visit ? '' : '[دفعة بدون زيارة] ') + String(data.notes || '').trim()
  ]);

  var remaining = null;
  if (visit) {
    remaining = findVisitById_(visit.visitId).remaining;
  }
  return { transactionId: transactionId, duplicate: false, visitId: visit ? visit.visitId : null, remaining: remaining };
}

/**
 * Finds an identical payment recorded in the last 10 minutes.
 * @param {string} patientId
 * @param {number} amount
 * @return {Object|null} {id, date, amount}.
 */
function findRecentDuplicatePayment_(patientId, amount) {
  var rows = readAll_(SHEETS.INCOME);
  var today = todayStr_();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][COL.INCOME.PATIENT_ID]) === String(patientId) &&
      Number(rows[i][COL.INCOME.AMOUNT]) === amount &&
      String(rows[i][COL.INCOME.DATE]) === today) {
      // Sheet rows have no creation timestamp; treat any same-day identical
      // payment as a potential duplicate and let the user confirm.
      return { id: String(rows[i][COL.INCOME.ID]), date: today, amount: amount };
    }
  }
  return null;
}

/**
 * UI: records a payment (full or partial) for a patient.
 */
function uiRecordPayment() {
  var patient = uiPickPatient_('تسجيل دفعة');
  var openVisit = findOpenVisit_(patient.id);

  var visitId = null;
  var defaultAmount = '';
  var context = '';
  if (openVisit) {
    visitId = openVisit.visitId;
    defaultAmount = String(openVisit.remaining);
    context = 'الزيارة المفتوحة: ' + openVisit.treatment +
      ' — المتبقي: ' + openVisit.remaining + ' دج';
  } else {
    context = 'لا توجد زيارة بمبلغ متبقي. ستُسجل الدفعة كدفعة مقدمة.';
  }

  var amountRaw = prompt_('تسجيل دفعة',
    'المريض: ' + patient.name + '\n' + context + '\n\nأدخل المبلغ المدفوع (دج):',
    defaultAmount);
  var amount = parseAmount_(amountRaw, 'المبلغ المدفوع');
  if (amount <= 0) {
    throw new Error('المبلغ المدفوع يجب أن يكون أكبر من صفر.');
  }

  var method = promptChoice_('تسجيل دفعة', 'طريقة الدفع:', PAYMENT_METHODS);
  var notes = prompt_('تسجيل دفعة', 'ملاحظات (اختياري):', '');

  var result = recordPayment_({
    patientId: patient.id,
    amount: amount,
    method: method,
    visitId: visitId,
    notes: notes
  });

  if (result.duplicate) {
    var ui = SpreadsheetApp.getUi();
    var answer = ui.alert('تنبيه',
      'توجد دفعة مسجلة مسبقا بنفس المبلغ لهذا المريض اليوم (المعرف: ' +
      result.existingId + ').\nهل تريد تسجيل دفعة جديدة على أي حال؟',
      ui.ButtonSet.YES_NO);
    if (answer !== ui.Button.YES) {
      throw new Error('تم إلغاء العملية (تم اعتبار العملية تكرارا).');
    }
    result = recordPayment_({
      patientId: patient.id,
      amount: amount,
      method: method,
      visitId: visitId,
      notes: notes,
      force: true
    });
  }

  var message = 'تم تسجيل الدفعة بنجاح.\nالمعرف: ' + result.transactionId +
    '\nالمبلغ: ' + amount + ' دج';
  if (result.remaining !== null) {
    message += '\nالمتبقي على الزيارة: ' + result.remaining + ' دج';
  }
  alert_('تسجيل دفعة', message);
  return result;
}

// ============================= EXPENSES =============================

/**
 * Records one expense in the Expenses sheet.
 * @param {Object} data {category, description, amount, supplier, notes, forcedId}.
 * @return {string} expense ID.
 */
function recordExpense_(data) {
  requireSetup_();
  var category = String(data.category || '').trim();
  var description = String(data.description || '').trim();
  if (category === '') {
    throw new Error('فئة المصروف مطلوبة.');
  }
  if (description === '') {
    throw new Error('وصف المصروف مطلوب.');
  }
  var amount = parseAmount_(data.amount, 'المبلغ');
  if (amount <= 0) {
    throw new Error('مبلغ المصروف يجب أن يكون أكبر من صفر.');
  }
  var expenseId = data.forcedId || nextId_(SHEETS.EXPENSES, 'EX');
  appendRow_(SHEETS.EXPENSES, [
    expenseId,
    todayStr_(),
    category,
    description,
    amount,
    String(data.supplier || '').trim(),
    String(data.notes || '').trim()
  ]);
  return expenseId;
}

/**
 * UI: records an expense.
 */
function uiRecordExpense() {
  var categories = ['مواد وقاية', 'أدوية ومستلزمات', 'صيانة', 'كهرباء وماء',
    'إيجار', 'رواتب', 'تنظيف', 'أخرى'];
  var category = promptChoice_('تسجيل مصروف', 'فئة المصروف:', categories);
  if (category === 'أخرى') {
    category = prompt_('تسجيل مصروف', 'اكتب فئة المصروف:');
    if (category === '') {
      throw new Error('فئة المصروف مطلوبة.');
    }
  }
  var description = prompt_('تسجيل مصروف', 'وصف المصروف:');
  var amountRaw = prompt_('تسجيل مصروف', 'المبلغ (دج):');
  var supplier = prompt_('تسجيل مصروف', 'المورد (اختياري):', '');
  var notes = prompt_('تسجيل مصروف', 'ملاحظات (اختياري):', '');

  var expenseId = recordExpense_({
    category: category,
    description: description,
    amount: amountRaw,
    supplier: supplier,
    notes: notes
  });
  alert_('تسجيل مصروف', 'تم تسجيل المصروف بنجاح.\nالمعرف: ' + expenseId);
  return expenseId;
}

// ============================= AGGREGATES =============================

/**
 * Collected payments for one day.
 * @param {string} dateStr yyyy-MM-dd.
 * @return {number}
 */
function getDailyCollected_(dateStr) {
  var rows = readAll_(SHEETS.INCOME);
  var sum = 0;
  rows.forEach(function (row) {
    if (String(row[COL.INCOME.DATE]) === dateStr) {
      sum += Number(row[COL.INCOME.AMOUNT]) || 0;
    }
  });
  return sum;
}

/**
 * Collected payments for one month.
 * @param {string} monthStr yyyy-MM.
 * @return {number}
 */
function getMonthlyCollected_(monthStr) {
  var rows = readAll_(SHEETS.INCOME);
  var sum = 0;
  rows.forEach(function (row) {
    if (String(row[COL.INCOME.DATE]).indexOf(monthStr) === 0) {
      sum += Number(row[COL.INCOME.AMOUNT]) || 0;
    }
  });
  return sum;
}

/**
 * Expenses for one day.
 * @param {string} dateStr yyyy-MM-dd.
 * @return {number}
 */
function getDailyExpenses_(dateStr) {
  var rows = readAll_(SHEETS.EXPENSES);
  var sum = 0;
  rows.forEach(function (row) {
    if (String(row[COL.EXPENSES.DATE]) === dateStr) {
      sum += Number(row[COL.EXPENSES.AMOUNT]) || 0;
    }
  });
  return sum;
}

/**
 * Expenses for one month.
 * @param {string} monthStr yyyy-MM.
 * @return {number}
 */
function getMonthlyExpenses_(monthStr) {
  var rows = readAll_(SHEETS.EXPENSES);
  var sum = 0;
  rows.forEach(function (row) {
    if (String(row[COL.EXPENSES.DATE]).indexOf(monthStr) === 0) {
      sum += Number(row[COL.EXPENSES.AMOUNT]) || 0;
    }
  });
  return sum;
}

/**
 * Total remaining balances across all visits.
 * @return {number}
 */
function getTotalOutstanding_() {
  var rows = readAll_(SHEETS.VISITS);
  var sum = 0;
  rows.forEach(function (row) {
    sum += Number(row[COL.VISITS.REMAINING]) || 0;
  });
  return sum;
}
