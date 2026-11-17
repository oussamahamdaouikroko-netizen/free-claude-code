/**
 * File 8 of 8: Tests.gs — self-test with sample records.
 *
 * runTests() creates temporary records whose IDs start with "TEST-X-",
 * runs assertions, then deletes those records. It never touches real data.
 * Run it from the menu: "تشغيل الاختبارات".
 */

/**
 * Deletes every row whose ID starts with the given prefix.
 * @param {string} prefix e.g. "TEST-X-".
 * @return {number} number of deleted rows.
 */
function clearRowsWithPrefix_(prefix) {
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
      if (String(ids[i][0]).indexOf(prefix) === 0) {
        sheet.deleteRow(i + 2);
        total++;
      }
    }
  });
  return total;
}

/**
 * Runs all self-tests and returns an Arabic report string.
 * @return {string}
 */
function runTests() {
  requireSetup_();
  clearRowsWithPrefix_('TEST-X-');

  var results = [];

  /**
   * Runs one named test; failures are captured with their message.
   * @param {string} name
   * @param {Function} fn
   */
  function check(name, fn) {
    try {
      fn();
      results.push('✓ ' + name);
    } catch (err) {
      results.push('✗ ' + name + ' — ' + (err && err.message ? err.message : err));
    }
  }

  function assertEqual(actual, expected, label) {
    if (actual !== expected) {
      throw new Error(label + ': القيمة المتوقعة ' + expected + ' لكن النتيجة ' + actual);
    }
  }

  function assertThrows(fn, label) {
    var threw = false;
    try {
      fn();
    } catch (e) {
      threw = true;
    }
    if (!threw) {
      throw new Error(label + ': كان من المتوقع حدوث خطأ لكن العملية نجحت');
    }
  }

  // ---------- Phone normalization ----------
  check('تطبيع رقم الهاتف 0555123456', function () {
    assertEqual(normalizeDzPhone_('0555123456').phone, '213555123456', 'نتيجة التطبيع');
  });
  check('تطبيع رقم الهاتف +213 555 12 34 56', function () {
    assertEqual(normalizeDzPhone_('+213 555 12 34 56').phone, '213555123456', 'نتيجة التطبيع');
  });
  check('تطبيع رقم الهاتف 00213555123456', function () {
    assertEqual(normalizeDzPhone_('00213555123456').phone, '213555123456', 'نتيجة التطبيع');
  });
  check('رفض رقم قصير غير صالح', function () {
    assertEqual(normalizeDzPhone_('0555123').ok, false, 'نتيجة التحقق');
  });
  check('رفض رقم أرضي / غير جوال', function () {
    assertEqual(normalizeDzPhone_('0215551234').ok, false, 'نتيجة التحقق');
  });

  // ---------- Patient registration & search ----------
  check('تسجيل مريض جديد', function () {
    var id = registerPatient_('مريض اختبار', '0555000000', '', 'TEST-X-P-001');
    assertEqual(id, 'TEST-X-P-001', 'معرف المريض');
  });
  check('البحث عن مريض بالرقم', function () {
    var matches = findPatients_('0555000000');
    if (matches.length < 1) {
      throw new Error('لم يتم العثور على المريض');
    }
    assertEqual(matches[0].id, 'TEST-X-P-001', 'معرف المريض');
  });

  // ---------- Queue ----------
  check('ترقيم قائمة الانتظار بدون تكرار', function () {
    var expected = nextQueueNumber_(todayStr_());
    var r1 = addToQueue_('TEST-X-P-001', 'اختبار', { forcedId: 'TEST-X-Q-001' });
    var r2 = addToQueue_('TEST-X-P-001', 'اختبار', { forcedId: 'TEST-X-Q-002' });
    assertEqual(r1.queueNumber, expected, 'رقم الدور الأول');
    assertEqual(r2.queueNumber, expected + 1, 'رقم الدور الثاني');
  });
  check('منع تكرار رقم الدور', function () {
    var used = nextQueueNumber_(todayStr_()) - 1;
    assertThrows(function () {
      addToQueue_('TEST-X-P-001', 'اختبار', { forcedId: 'TEST-X-Q-003', forcedNumber: used });
    }, 'رقم دور مكرر');
  });
  check('صيغة وقت الدور المتوقع', function () {
    if (!/^\d{2}:\d{2}$/.test(estimateTurnTimeStr_(1))) {
      throw new Error('الصيغة المتوقعة HH:mm');
    }
  });
  check('تغيير حالة الدور', function () {
    setQueueStatus_('TEST-X-Q-001', QUEUE_STATUS.IN_TREATMENT);
    var rows = todayQueue_(QUEUE_STATUS.IN_TREATMENT);
    var found = rows.some(function (r) {
      return r.queueId === 'TEST-X-Q-001';
    });
    if (!found) {
      throw new Error('لم يتم تحديث حالة الدور');
    }
    setQueueStatus_('TEST-X-Q-001', QUEUE_STATUS.COMPLETED);
  });

  // ---------- Visits & payments ----------
  check('إنشاء زيارة وحساب المتبقي', function () {
    var v = createVisit_({
      forcedId: 'TEST-X-V-001',
      patientId: 'TEST-X-P-001',
      treatmentType: 'اختبار',
      details: '',
      totalPrice: 10000,
      nextAppointment: '2027-06-01',
      notes: ''
    });
    assertEqual(v.remaining, 10000, 'المتبقي بعد الإنشاء');
    var visit = findVisitById_('TEST-X-V-001');
    assertEqual(visit.total, 10000, 'السعر الإجمالي');
    assertEqual(visit.paid, 0, 'المدفوع');
  });
  check('دفعة جزئية تخفض المتبقي', function () {
    var result = recordPayment_({
      forcedId: 'TEST-X-T-001',
      patientId: 'TEST-X-P-001',
      amount: 4000,
      method: 'نقدًا',
      visitId: 'TEST-X-V-001',
      notes: ''
    });
    assertEqual(result.remaining, 6000, 'المتبقي بعد الدفعة الأولى');
  });
  check('رفض دفعة أكبر من المتبقي', function () {
    assertThrows(function () {
      recordPayment_({
        forcedId: 'TEST-X-T-002',
        patientId: 'TEST-X-P-001',
        amount: 9000,
        method: 'نقدًا',
        visitId: 'TEST-X-V-001',
        notes: ''
      });
    }, 'دفعة أكبر من المتبقي');
  });
  check('كشف الدفعة المكررة (إزدواج النموذج)', function () {
    var first = recordPayment_({
      forcedId: 'TEST-X-T-003',
      patientId: 'TEST-X-P-001',
      amount: 3000,
      method: 'نقدًا',
      visitId: 'TEST-X-V-001',
      notes: ''
    });
    assertEqual(first.duplicate, false, 'الدفعة الأولى');
    var second = recordPayment_({
      patientId: 'TEST-X-P-001',
      amount: 3000,
      method: 'نقدًا',
      visitId: 'TEST-X-V-001',
      notes: ''
    });
    assertEqual(second.duplicate, true, 'الدفعة المكررة');
  });
  check('إجبار تسجيل دفعة مكررة بتأكيد المستخدم', function () {
    var result = recordPayment_({
      forcedId: 'TEST-X-T-004',
      patientId: 'TEST-X-P-001',
      amount: 3000,
      method: 'نقدًا',
      visitId: 'TEST-X-V-001',
      notes: '',
      force: true
    });
    assertEqual(result.remaining, 0, 'المتبقي بعد السداد الكامل');
    assertEqual(findVisitById_('TEST-X-V-001').paid, 10000, 'مجموع المدفوعات');
  });

  // ---------- WhatsApp ----------
  check('بناء رابط WhatsApp', function () {
    var result = buildWhatsAppLink_('0555123456', 'مرحبا');
    if (!result.ok) {
      throw new Error(result.error);
    }
    assertEqual(result.link,
      'https://wa.me/213555123456?text=' + encodeURIComponent('مرحبا'),
      'الرابط');
  });
  check('رفض رابط WhatsApp برقم غير صالح', function () {
    assertEqual(buildWhatsAppLink_('123', 'مرحبا').ok, false, 'نتيجة التحقق');
  });
  check('استبدال متغيرات القالب', function () {
    assertEqual(renderTemplate_('مرحبا {name} في {clinic}', { name: 'أحمد', clinic: 'العيادة' }),
      'مرحبا أحمد في العيادة', 'النص الناتج');
  });

  // ---------- Inventory ----------
  check('إضافة صنف وتحديد الحالة', function () {
    addInventoryItem_({
      forcedId: 'TEST-X-I-001',
      name: 'صنف اختبار',
      category: 'اختبار',
      qty: 5,
      minLevel: 10,
      unit: 'قطعة',
      supplier: ''
    });
    var lowItems = getLowStockItems_();
    var found = lowItems.some(function (item) {
      return item.name === 'صنف اختبار';
    });
    if (!found) {
      throw new Error('الصنف غير موجود في قائمة إعادة الطلب');
    }
  });
  check('الشراء يزيد المخزون ويسجل مصروفا', function () {
    var result = recordPurchase_({
      forcedId: 'TEST-X-PU-001',
      forcedExpenseId: 'TEST-X-E-001',
      itemId: 'TEST-X-I-001',
      quantity: 3,
      unitPrice: 100,
      supplier: 'مورد',
      notes: ''
    });
    assertEqual(result.newQty, 8, 'الكمية بعد الشراء');
    assertEqual(result.totalCost, 300, 'التكلفة الإجمالية');
    if (getSetting_(SETTINGS.AUTO_EXPENSE, YES) === YES) {
      if (result.expenseId !== 'TEST-X-E-001') {
        throw new Error('لم يتم تسجيل المصروف التلقائي');
      }
    }
  });
  check('رفض كمية شراء سالبة', function () {
    assertThrows(function () {
      recordPurchase_({
        itemId: 'TEST-X-I-001',
        quantity: -5,
        unitPrice: 100,
        supplier: '',
        notes: ''
      });
    }, 'كمية سالبة');
  });

  // ---------- Dashboard ----------
  check('حسابات لوحة التحكم أرقام صحيحة', function () {
    var data = computeDashboardData_();
    ['todayPatients', 'waitingNow', 'treatedToday', 'collectedToday',
      'collectedMonth', 'expensesMonth', 'netCashFlow', 'outstanding'
    ].forEach(function (key) {
      if (typeof data[key] !== 'number' || isNaN(data[key])) {
        throw new Error('الحقل ' + key + ' ليس رقما');
      }
    });
    if (!Array.isArray(data.lowStock) || !Array.isArray(data.upcoming)) {
      throw new Error('قوائم اللوحة غير صحيحة');
    }
  });

  // Cleanup temporary test records.
  clearRowsWithPrefix_('TEST-X-');
  refreshAllStockStatuses();
  updateDashboard();

  var failed = results.filter(function (line) {
    return line.indexOf('✗') === 0;
  }).length;
  var summary = 'الاختبارات: ' + (results.length - failed) + ' نجحت، ' + failed + ' فشلت.';

  // Log test names only (no patient data in logs).
  Logger.log(summary);
  results.forEach(function (line) {
    Logger.log(line);
  });

  return summary + '\n\n' + results.join('\n');
}
