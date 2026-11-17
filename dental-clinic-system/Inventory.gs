/**
 * File 5 of 8: Inventory.gs — inventory items and purchases.
 *
 * Stock rules:
 * - A purchase always increases stock (quantities cannot become negative here).
 * - Manual edits that try to push a quantity below zero are reverted by onEdit.
 * - Stock status is computed: OUT if quantity <= 0, LOW if quantity <= minimum.
 */

// ============================= ITEMS =============================

/**
 * Computes the stock status text from quantity and minimum level.
 * @param {number} qty
 * @param {number} minLevel
 * @return {string} one of STOCK_STATUS.
 */
function computeStockStatus_(qty, minLevel) {
  if (qty <= 0) {
    return STOCK_STATUS.OUT;
  }
  if (qty <= minLevel) {
    return STOCK_STATUS.LOW;
  }
  return STOCK_STATUS.OK;
}

/**
 * Adds a new inventory item.
 * @param {Object} data {name, category, qty, minLevel, unit, supplier, forcedId}.
 * @return {string} item ID.
 */
function addInventoryItem_(data) {
  requireSetup_();
  var name = String(data.name || '').trim();
  if (name === '') {
    throw new Error('اسم الصنف مطلوب.');
  }
  var qty = parsePositiveInt_(data.qty, 'الكمية الحالية');
  var minLevel = parsePositiveInt_(data.minLevel, 'الحد الأدنى للمخزون');
  var itemId = data.forcedId || nextId_(SHEETS.INVENTORY, 'IT');
  appendRow_(SHEETS.INVENTORY, [
    itemId,
    name,
    String(data.category || '').trim(),
    qty,
    minLevel,
    String(data.unit || '').trim(),
    '',
    '',
    String(data.supplier || '').trim(),
    computeStockStatus_(qty, minLevel)
  ]);
  return itemId;
}

/**
 * Finds inventory items whose ID or name matches the query.
 * @param {string} query
 * @return {Array<Object>} {itemId, name, qty, unit, row}.
 */
function findInventoryItems_(query) {
  requireSetup_();
  var cleanQuery = String(query || '').trim();
  if (cleanQuery === '') {
    return [];
  }
  var rows = readAll_(SHEETS.INVENTORY);
  var matches = [];
  rows.forEach(function (row, index) {
    var id = String(row[COL.INVENTORY.ID]);
    var name = String(row[COL.INVENTORY.NAME]);
    if (id === cleanQuery || name === cleanQuery ||
      name.indexOf(cleanQuery) !== -1 || id.indexOf(cleanQuery) !== -1) {
      matches.push({
        itemId: id,
        name: name,
        qty: Number(row[COL.INVENTORY.QTY]) || 0,
        unit: String(row[COL.INVENTORY.UNIT]),
        supplier: String(row[COL.INVENTORY.SUPPLIER]),
        row: index + 2
      });
    }
  });
  return matches;
}

/**
 * Returns one inventory item by exact ID.
 * @param {string} itemId
 * @return {Object}
 */
function findInventoryItemById_(itemId) {
  var rows = readAll_(SHEETS.INVENTORY);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][COL.INVENTORY.ID]) === String(itemId)) {
      return {
        itemId: String(rows[i][COL.INVENTORY.ID]),
        name: String(rows[i][COL.INVENTORY.NAME]),
        qty: Number(rows[i][COL.INVENTORY.QTY]) || 0,
        unit: String(rows[i][COL.INVENTORY.UNIT]),
        supplier: String(rows[i][COL.INVENTORY.SUPPLIER]),
        row: i + 2
      };
    }
  }
  throw new Error('لم يتم العثور على صنف بالمعرف "' + itemId + '".');
}

/**
 * Recomputes the stock status of one inventory row.
 * @param {number} row
 */
function updateStockStatusForRow_(row) {
  var sheet = getSheet_(SHEETS.INVENTORY);
  var qty = Number(sheet.getRange(row, COL.INVENTORY.QTY + 1).getValue()) || 0;
  var minLevel = Number(sheet.getRange(row, COL.INVENTORY.MIN + 1).getValue()) || 0;
  sheet.getRange(row, COL.INVENTORY.STATUS + 1).setValue(computeStockStatus_(qty, minLevel));
}

/**
 * Recomputes stock status for every item.
 * @return {number} number of items processed.
 */
function refreshAllStockStatuses() {
  var sheet = getSheet_(SHEETS.INVENTORY);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return 0;
  }
  var quantities = sheet.getRange(2, COL.INVENTORY.QTY + 1, lastRow - 1, 1).getValues();
  var minimums = sheet.getRange(2, COL.INVENTORY.MIN + 1, lastRow - 1, 1).getValues();
  var statuses = [];
  for (var i = 0; i < quantities.length; i++) {
    statuses.push([computeStockStatus_(Number(quantities[i][0]) || 0, Number(minimums[i][0]) || 0)]);
  }
  sheet.getRange(2, COL.INVENTORY.STATUS + 1, statuses.length, 1).setValues(statuses);
  return statuses.length;
}

/**
 * Returns items that need reordering (status LOW or OUT).
 * @return {Array<Object>} {name, qty, minLevel}.
 */
function getLowStockItems_() {
  var rows = readAll_(SHEETS.INVENTORY);
  var result = [];
  rows.forEach(function (row) {
    var qty = Number(row[COL.INVENTORY.QTY]) || 0;
    var minLevel = Number(row[COL.INVENTORY.MIN]) || 0;
    if (computeStockStatus_(qty, minLevel) !== STOCK_STATUS.OK) {
      result.push({
        name: String(row[COL.INVENTORY.NAME]),
        qty: qty,
        minLevel: minLevel
      });
    }
  });
  return result;
}

// ============================= PURCHASES =============================

/**
 * Records a purchase, increases stock, and optionally records an expense.
 *
 * Double-counting protection: when the Settings option
 * "تسجيل مشتريات المخزون تلقائيا في المصروفات" is "نعم", the purchase is
 * automatically written to the Expenses sheet with a "[شراء مخزون: ...]"
 * note. In that case the receptionist must NOT record the same purchase
 * manually in the Expenses sheet.
 *
 * @param {Object} data {itemId, quantity, unitPrice, supplier, notes, forcedId, forcedExpenseId}.
 * @return {Object} {purchaseId, totalCost, newQty, expenseId}.
 */
function recordPurchase_(data) {
  requireSetup_();
  var item = findInventoryItemById_(data.itemId);
  var quantity = parsePositiveInt_(data.quantity, 'الكمية المشتراة');
  if (quantity <= 0) {
    throw new Error('الكمية المشتراة يجب أن تكون أكبر من صفر.');
  }
  var unitPrice = parseAmount_(data.unitPrice, 'سعر الوحدة');
  if (unitPrice < 0) {
    throw new Error('سعر الوحدة لا يمكن أن يكون سالبا.');
  }
  var totalCost = quantity * unitPrice;
  var newQty = item.qty + quantity;
  if (newQty < 0) {
    // Defensive guard: a purchase can never reduce stock below zero.
    throw new Error('الكمية الناتجة سالبة. تم إلغاء العملية لحماية المخزون.');
  }

  var purchaseId = data.forcedId || nextId_(SHEETS.PURCHASES, 'PU');
  appendRow_(SHEETS.PURCHASES, [
    purchaseId,
    todayStr_(),
    item.itemId,
    item.name,
    quantity,
    unitPrice,
    totalCost,
    String(data.supplier || item.supplier || '').trim(),
    String(data.notes || '').trim()
  ]);

  // Update the item: quantity, last purchase date/price, supplier, status.
  var sheet = getSheet_(SHEETS.INVENTORY);
  sheet.getRange(item.row, COL.INVENTORY.QTY + 1).setValue(newQty);
  sheet.getRange(item.row, COL.INVENTORY.LAST_DATE + 1).setValue(todayStr_());
  sheet.getRange(item.row, COL.INVENTORY.LAST_PRICE + 1).setValue(unitPrice);
  var supplier = String(data.supplier || item.supplier || '').trim();
  if (supplier !== '') {
    sheet.getRange(item.row, COL.INVENTORY.SUPPLIER + 1).setValue(supplier);
  }
  updateStockStatusForRow_(item.row);

  // Optional: record the purchase as an expense exactly once.
  // forcedExpenseId keeps sample/test rows easy to delete in one pass.
  var expenseId = null;
  if (getSetting_(SETTINGS.AUTO_EXPENSE, YES) === YES) {
    expenseId = recordExpense_({
      forcedId: data.forcedExpenseId,
      category: getSetting_(SETTINGS.PURCHASE_CATEGORY, 'مستلزمات طبية'),
      description: 'شراء مستلزمات: ' + item.name + ' (' + quantity + ' ' + item.unit + ')',
      amount: totalCost,
      supplier: supplier,
      notes: '[شراء مخزون: ' + purchaseId + ']'
    });
  }

  return { purchaseId: purchaseId, totalCost: totalCost, newQty: newQty, expenseId: expenseId };
}

// ============================= UI =============================

/**
 * UI: adds a new inventory item.
 * @return {string} item ID.
 */
function uiAddInventoryItem() {
  var name = prompt_('إضافة صنف للمخزون', 'اسم الصنف:');
  if (name === '') {
    throw new Error('اسم الصنف مطلوب.');
  }
  var category = prompt_('إضافة صنف للمخزون', 'الفئة (مثال: مواد وقاية، أدوية، أدوات):', '');
  var qtyRaw = prompt_('إضافة صنف للمخزون', 'الكمية الحالية:', '0');
  var minRaw = prompt_('إضافة صنف للمخزون', 'الحد الأدنى للمخزون (يظهر تنبيه عند الوصول إليه):', '5');
  var unit = prompt_('إضافة صنف للمخزون', 'الوحدة (مثال: علبة، أنبوب، قطعة):', '');
  var supplier = prompt_('إضافة صنف للمخزون', 'المورد (اختياري):', '');

  var itemId = addInventoryItem_({
    name: name,
    category: category,
    qty: qtyRaw,
    minLevel: minRaw,
    unit: unit,
    supplier: supplier
  });
  alert_('إضافة صنف للمخزون', 'تمت إضافة الصنف بنجاح.\nالمعرف: ' + itemId);
  return itemId;
}

/**
 * UI: records a purchase and increases stock.
 */
function uiRecordPurchase() {
  var query = prompt_('تسجيل شراء مستلزمات', 'اسم الصنف أو معرفه:');
  var matches = findInventoryItems_(query);
  var item;

  if (matches.length === 0) {
    var ui = SpreadsheetApp.getUi();
    var answer = ui.alert('الصنف غير موجود',
      'لا يوجد صنف مطابق لـ "' + query + '". هل تريد إضافه صنف جديد؟',
      ui.ButtonSet.YES_NO);
    if (answer !== ui.Button.YES) {
      throw new Error('تم إلغاء العملية.');
    }
    var newItemId = uiAddInventoryItem();
    item = findInventoryItemById_(newItemId);
  } else if (matches.length === 1) {
    item = matches[0];
  } else {
    var options = matches.slice(0, 10).map(function (m) {
      return m.name + ' (' + m.itemId + ') — الكمية: ' + m.qty + ' ' + m.unit;
    });
    var choice = promptChoice_('تسجيل شراء مستلزمات', 'عدة صنوف مطابقة. اختر الصنف:', options);
    item = matches[options.indexOf(choice)];
  }

  var qtyRaw = prompt_('تسجيل شراء مستلزمات',
    'الصنف: ' + item.name + ' — الكمية الحالية: ' + item.qty + ' ' + item.unit +
    '\n\nالكمية المشتراة:');
  var priceRaw = prompt_('تسجيل شراء مستلزمات', 'سعر الوحدة (دج):');
  var supplier = prompt_('تسجيل شراء مستلزمات', 'المورد:', item.supplier || '');
  var notes = prompt_('تسجيل شراء مستلزمات', 'ملاحظات (اختياري):', '');

  var result = recordPurchase_({
    itemId: item.itemId,
    quantity: qtyRaw,
    unitPrice: priceRaw,
    supplier: supplier,
    notes: notes
  });

  var message = 'تم تسجيل الشراء بنجاح.\nالمعرف: ' + result.purchaseId +
    '\nالتكلفة الإجمالية: ' + result.totalCost + ' دج' +
    '\nالكمية الجديدة: ' + result.newQty;
  if (result.expenseId) {
    message += '\nتم تسجيل المصروف تلقائيا (المعرف: ' + result.expenseId +
      '). لا تُسجّله مرة أخرى في المصروفات.';
  }
  alert_('تسجيل شراء مستلزمات', message);
  return result;
}

// ============================= EDIT GUARD =============================

/**
 * Simple trigger: reverts manual edits that make stock negative, and
 * refreshes the stock status when quantity or minimum level changes.
 * @param {Object} e
 */
function onEdit(e) {
  try {
    var range = e.range;
    var sheet = range.getSheet();
    if (sheet.getName() !== SHEETS.INVENTORY || range.getRow() < 2) {
      return;
    }
    var column = range.getColumn();
    if (column === COL.INVENTORY.QTY + 1) {
      var value = Number(range.getValue());
      if (isNaN(value) || value < 0) {
        range.setValue(e.oldValue || 0);
        SpreadsheetApp.getActiveSpreadsheet().toast(
          'لا يمكن أن تكون كمية المخزون سالبة. تم التراجع عن التعديل.', MENU_NAME, 6);
        return;
      }
    }
    if (column === COL.INVENTORY.QTY + 1 || column === COL.INVENTORY.MIN + 1) {
      updateStockStatusForRow_(range.getRow());
    }
  } catch (err) {
    // Never break the spreadsheet UI because of the guard trigger.
  }
}
