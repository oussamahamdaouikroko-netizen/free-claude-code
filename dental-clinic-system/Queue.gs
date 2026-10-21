/**
 * File 3 of 8: Queue.gs — patient registration, queue management, search.
 */

// ============================= PATIENTS =============================

/**
 * Registers a new patient in the Patients sheet.
 * @param {string} name Full name (required).
 * @param {string} phone Raw phone number (normalized to 213XXXXXXXXX).
 * @param {string=} notes
 * @param {string=} forcedId Optional ID (used by sample data).
 * @return {string} patient ID.
 */
function registerPatient_(name, phone, notes, forcedId) {
  requireSetup_();
  var cleanName = String(name || '').trim();
  if (cleanName === '') {
    throw new Error('الاسم الكامل مطلوب.');
  }
  var phoneResult = normalizeDzPhone_(phone);
  if (!phoneResult.ok) {
    throw new Error(phoneResult.error);
  }
  var id = forcedId || nextId_(SHEETS.PATIENTS, 'P');
  appendRow_(SHEETS.PATIENTS, [
    id,
    cleanName,
    phoneResult.phone,
    todayStr_(),
    String(notes || '').trim(),
    ''
  ]);
  return id;
}

/**
 * Compares a stored phone (digits) with a raw query, tolerant to the local
 * "0..." format vs the stored international "213..." format.
 * @param {string} storedDigits
 * @param {string} queryDigits
 * @return {boolean}
 */
function phoneDigitsMatch_(storedDigits, queryDigits) {
  if (queryDigits === '') {
    return false;
  }
  if (storedDigits.indexOf(queryDigits) !== -1) {
    return true;
  }
  // Compare without leading zeros and without the 213 country code.
  var stored = storedDigits.replace(/^0+/, '');
  var query = queryDigits.replace(/^0+/, '');
  if (stored.indexOf('213') === 0) {
    stored = stored.slice(3);
  }
  if (query.indexOf('213') === 0) {
    query = query.slice(3);
  }
  return query !== '' && stored.indexOf(query) !== -1;
}

/**
 * Finds patients whose name contains the query or whose phone contains it.
 * @param {string} query
 * @return {Array<Object>} patient objects {id, name, phone, row}.
 */
function findPatients_(query) {
  requireSetup_();
  var cleanQuery = String(query || '').trim();
  if (cleanQuery === '') {
    return [];
  }
  var digits = cleanQuery.replace(/\D/g, '');
  var rows = readAll_(SHEETS.PATIENTS);
  var matches = [];
  rows.forEach(function (row, index) {
    var name = String(row[COL.PATIENTS.NAME]);
    var phone = String(row[COL.PATIENTS.PHONE]);
    var byName = name.indexOf(cleanQuery) !== -1;
    var byPhone = phoneDigitsMatch_(phone.replace(/\D/g, ''), digits);
    if (byName || byPhone) {
      matches.push({
        id: String(row[COL.PATIENTS.ID]),
        name: name,
        phone: phone,
        row: index + 2
      });
    }
  });
  return matches;
}

/**
 * Returns a patient by ID, or throws.
 * @param {string} patientId
 * @return {Object} patient object {id, name, phone, row}.
 */
function findPatientById_(patientId) {
  var rows = readAll_(SHEETS.PATIENTS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][COL.PATIENTS.ID]) === String(patientId)) {
      return {
        id: String(rows[i][COL.PATIENTS.ID]),
        name: String(rows[i][COL.PATIENTS.NAME]),
        phone: String(rows[i][COL.PATIENTS.PHONE]),
        row: i + 2
      };
    }
  }
  throw new Error('لم يتم العثور على مريض بالمعرف "' + patientId + '".');
}

/**
 * Updates the "last visit date" of a patient.
 * @param {string} patientId
 * @param {string} dateStr yyyy-MM-dd.
 */
function updatePatientLastVisit_(patientId, dateStr) {
  var patient = findPatientById_(patientId);
  getSheet_(SHEETS.PATIENTS).getRange(patient.row, COL.PATIENTS.LAST_VISIT + 1).setValue(dateStr);
}

/**
 * UI: prompts for patient data and registers the patient.
 */
function uiRegisterPatient() {
  requireSetup_();
  var name = prompt_('تسجيل مريض جديد', 'الاسم الكامل:');
  if (name === '') {
    throw new Error('الاسم الكامل مطلوب.');
  }
  var phone = prompt_('تسجيل مريض جديد',
    'رقم الهاتف (واتساب):\nمثال: 0555123456 أو +213555123456');
  var notes = prompt_('تسجيل مريض جديد', 'ملاحظات (اختياري):', '');

  // Warn when the phone already belongs to another patient.
  var normalized = normalizeDzPhone_(phone);
  if (normalized.ok) {
    var existing = findPatients_(normalized.phone);
    if (existing.length > 0) {
      var ui = SpreadsheetApp.getUi();
      var answer = ui.alert('تنبيه',
        'يوجد مريض مسجل بنفس الرقم: ' + existing[0].name + '\nهل تريد التسجيل على أي حال؟',
        ui.ButtonSet.YES_NO);
      if (answer !== ui.Button.YES) {
        throw new Error('تم إلغاء العملية.');
      }
    }
  }

  var id = registerPatient_(name, phone, notes);
  alert_('تسجيل مريض جديد', 'تم تسجيل المريض بنجاح.\nالمعرف: ' + id);
  return id;
}

// ============================= QUEUE =============================

/**
 * Returns the next queue number for a given day (1-based).
 * @param {string} dateStr yyyy-MM-dd.
 * @return {number}
 */
function nextQueueNumber_(dateStr) {
  var rows = readAll_(SHEETS.QUEUE);
  var max = 0;
  rows.forEach(function (row) {
    if (String(row[COL.QUEUE.DATE]) === dateStr) {
      var n = parseInt(row[COL.QUEUE.NUMBER], 10);
      if (!isNaN(n) && n > max) {
        max = n;
      }
    }
  });
  return max + 1;
}

/**
 * Estimates the turn time "HH:mm" for a patient who is `aheadCount` turns away.
 * Uses the configurable average treatment duration (Settings sheet).
 * @param {number} aheadCount
 * @return {string}
 */
function estimateTurnTimeStr_(aheadCount) {
  var d = new Date();
  d.setMinutes(d.getMinutes() + aheadCount * avgTreatmentMinutes_());
  return Utilities.formatDate(d, getSpreadsheetTz_(), 'HH:mm');
}

/**
 * Adds a patient to the queue for today.
 * Queue numbers are unique per day; duplicates are rejected.
 * @param {string} patientId
 * @param {string} treatmentType
 * @param {Object=} options {forcedId, forcedNumber, arrivalTime}.
 * @return {Object} {queueId, queueNumber}.
 */
function addToQueue_(patientId, treatmentType, options) {
  requireSetup_();
  options = options || {};
  var patient = findPatientById_(patientId);
  var dateStr = todayStr_();
  var queueNumber = options.forcedNumber || nextQueueNumber_(dateStr);

  // Prevent duplicate queue numbers for the same day.
  var rows = readAll_(SHEETS.QUEUE);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][COL.QUEUE.DATE]) === dateStr &&
      parseInt(rows[i][COL.QUEUE.NUMBER], 10) === parseInt(queueNumber, 10)) {
      throw new Error('رقم الدور ' + queueNumber + ' مستخدم مسبقا اليوم. لا يمكن تكراره.');
    }
  }

  // Count patients ahead of this one (waiting or in treatment) for the estimate.
  var ahead = 0;
  rows.forEach(function (row) {
    if (String(row[COL.QUEUE.DATE]) === dateStr &&
      (String(row[COL.QUEUE.STATUS]) === QUEUE_STATUS.WAITING ||
        String(row[COL.QUEUE.STATUS]) === QUEUE_STATUS.IN_TREATMENT)) {
      ahead++;
    }
  });

  var queueId = options.forcedId || ('Q-' + dateStr.replace(/-/g, '') + '-' + queueNumber);
  appendRow_(SHEETS.QUEUE, [
    queueId,
    dateStr,
    patient.id,
    patient.name,
    patient.phone,
    options.arrivalTime || nowTimeStr_(),
    queueNumber,
    String(treatmentType || '').trim(),
    QUEUE_STATUS.WAITING,
    estimateTurnTimeStr_(ahead),
    'لم يُرسل'
  ]);
  return { queueId: queueId, queueNumber: queueNumber };
}

/**
 * Returns today's queue rows matching an optional status.
 * @param {string=} status
 * @return {Array<Object>} {queueId, patientId, name, number, status, row}.
 */
function todayQueue_(status) {
  var rows = readAll_(SHEETS.QUEUE);
  var dateStr = todayStr_();
  var result = [];
  rows.forEach(function (row, index) {
    if (String(row[COL.QUEUE.DATE]) === dateStr &&
      (!status || String(row[COL.QUEUE.STATUS]) === status)) {
      result.push({
        queueId: String(row[COL.QUEUE.ID]),
        patientId: String(row[COL.QUEUE.PATIENT_ID]),
        name: String(row[COL.QUEUE.NAME]),
        phone: String(row[COL.QUEUE.PHONE]),
        number: parseInt(row[COL.QUEUE.NUMBER], 10),
        treatment: String(row[COL.QUEUE.TREATMENT]),
        status: String(row[COL.QUEUE.STATUS]),
        row: index + 2
      });
    }
  });
  return result;
}

/**
 * Changes the status of a queue row by its queue ID.
 * @param {string} queueId
 * @param {string} status One of QUEUE_STATUS values.
 */
function setQueueStatus_(queueId, status) {
  var rows = readAll_(SHEETS.QUEUE);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][COL.QUEUE.ID]) === String(queueId)) {
      getSheet_(SHEETS.QUEUE).getRange(i + 2, COL.QUEUE.STATUS + 1).setValue(status);
      return;
    }
  }
  throw new Error('لم يتم العثور على سجل دور بالمعرف "' + queueId + '".');
}

/**
 * Updates the "last notification status" of a queue row.
 * @param {string} queueId
 * @param {string} statusText
 */
function setQueueNotifyStatus_(queueId, statusText) {
  var rows = readAll_(SHEETS.QUEUE);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][COL.QUEUE.ID]) === String(queueId)) {
      getSheet_(SHEETS.QUEUE).getRange(i + 2, COL.QUEUE.NOTIFY + 1).setValue(statusText);
      return;
    }
  }
}

// ============================= QUEUE UI =============================

/**
 * Shared UI helper: asks for a name/phone query and returns one patient.
 * @param {string} title
 * @return {Object} patient object.
 */
function uiPickPatient_(title) {
  var query = prompt_(title, 'اكتب اسم المريض أو رقم هاتفه:');
  var matches = findPatients_(query);
  if (matches.length === 0) {
    throw new Error('لا يوجد مريض مطابق لـ "' + query + '". يمكنك تسجيله أولا من "تسجيل مريض جديد".');
  }
  if (matches.length === 1) {
    return matches[0];
  }
  var options = matches.slice(0, 10).map(function (p) {
    return p.name + ' — ' + p.phone + ' (' + p.id + ')';
  });
  var choice = promptChoice_(title, 'عدة مرضى مطابقين. اختر المريض:', options);
  return matches[options.indexOf(choice)];
}

/**
 * Shared UI helper: picks one queue row from a list.
 * @param {string} title
 * @param {Array<Object>} queueRows
 * @return {Object} queue row object.
 */
function uiPickQueueRow_(title, queueRows) {
  if (queueRows.length === 0) {
    throw new Error('لا توجد سجلات مطابقة في قائمة انتظار اليوم.');
  }
  if (queueRows.length === 1) {
    return queueRows[0];
  }
  var options = queueRows.map(function (q) {
    return 'رقم الدور ' + q.number + ' — ' + q.name + ' (' + q.treatment + ')';
  });
  var choice = promptChoice_(title, 'اختر المريض من القائمة:', options);
  return queueRows[options.indexOf(choice)];
}

/**
 * UI: adds a patient to today's queue.
 */
function uiAddToQueue() {
  var patient = uiPickPatient_('إضافة إلى قائمة الانتظار');
  var treatment = prompt_('إضافة إلى قائمة الانتظار',
    'نوع العلاج (اختياري):\nمثال: تنظيف، حشوة، خلع، تركيبة...');
  var result = addToQueue_(patient.id, treatment);
  alert_('إضافة إلى قائمة الانتظار',
    'تمت إضافة ' + patient.name + ' إلى قائمة الانتظار.\nرقم الدور: ' + result.queueNumber);
  return result;
}

/**
 * UI: marks a waiting patient as "in treatment".
 */
function uiStartTreatment() {
  var waiting = todayQueue_(QUEUE_STATUS.WAITING);
  var target = uiPickQueueRow_('بدء العلاج', waiting);
  setQueueStatus_(target.queueId, QUEUE_STATUS.IN_TREATMENT);
  alert_('بدء العلاج', 'بدأ علاج ' + target.name + ' (رقم الدور ' + target.number + ').');
  return target;
}

/**
 * UI: marks a patient as treated, then records the visit details.
 * Creates a Visits row so payments can be tracked against it.
 */
function uiCompleteTreatment() {
  var inTreatment = todayQueue_(QUEUE_STATUS.IN_TREATMENT);
  var target = uiPickQueueRow_('إنهاء العلاج', inTreatment);
  setQueueStatus_(target.queueId, QUEUE_STATUS.COMPLETED);
  updatePatientLastVisit_(target.patientId, todayStr_());

  var details = prompt_('إنهاء العلاج', 'تفاصيل العلاج (اختياري):', '');
  var totalRaw = prompt_('إنهاء العلاج', 'السعر الإجمالي (دج):', '0');
  var totalPrice = parseAmount_(totalRaw, 'السعر الإجمالي');
  if (totalPrice <= 0) {
    throw new Error('السعر الإجمالي يجب أن يكون أكبر من صفر.');
  }
  var nextAppointment = prompt_('إنهاء العلاج',
    'الموعد القادم (اختياري) بصيغة yyyy-MM-dd:', '').trim();
  if (nextAppointment !== '' && !isValidDateStr_(nextAppointment)) {
    throw new Error('صيغة الموعد القادم غير صحيحة. استخدم yyyy-MM-dd مثل 2026-12-01.');
  }
  var notes = prompt_('إنهاء العلاج', 'ملاحظات الطبيب (اختياري):', '');

  var visit = createVisit_({
    patientId: target.patientId,
    treatmentType: target.treatment,
    details: details,
    totalPrice: totalPrice,
    nextAppointment: nextAppointment,
    notes: notes
  });

  alert_('إنهاء العلاج',
    'تم إنهاء علاج ' + target.name + ' وتسجيل الزيارة.\n' +
    'معرف الزيارة: ' + visit.visitId + '\n' +
    'المبلغ المتبقي: ' + visit.remaining + ' دج\n\n' +
    'يمكنك تسجيل الدفعة من "تسجيل دفعة".');
  return visit;
}

/**
 * UI: searches patients by name or phone and shows the matches.
 */
function uiSearchPatient() {
  var query = prompt_('بحث عن مريض', 'اكتب جزءا من الاسم أو رقم الهاتف:');
  var matches = findPatients_(query);
  if (matches.length === 0) {
    alert_('بحث عن مريض', 'لا توجد نتائج مطابقة لـ "' + query + '".');
    return;
  }
  var lines = matches.slice(0, 15).map(function (p) {
    return p.id + ' | ' + p.name + ' | ' + p.phone;
  });
  alert_('بحث عن مريض',
    'النتائج (' + matches.length + '):\n\n' + lines.join('\n') +
    (matches.length > 15 ? '\n... ونتائج أخرى.' : ''));
}
