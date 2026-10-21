/**
 * File 6 of 8: WhatsApp.gs — Arabic message templates and wa.me links.
 *
 * IMPORTANT: This system NEVER sends WhatsApp messages automatically.
 * It only prepares a click-to-chat link (https://wa.me/...). Opening the link
 * opens WhatsApp with a pre-filled draft; the user must press Send manually.
 * This is the only 100% free and safe method (no unofficial APIs, no risk of
 * blocking the clinic's WhatsApp number).
 */

/**
 * All message templates. Placeholders: {name} {clinic} {date} {time} {amount}.
 * @return {Array<Object>} [{label, template, fields}] in display order.
 */
function getWhatsAppTemplates_() {
  return [
    {
      label: 'تأكيد الموعد',
      fields: ['date', 'time'],
      template: 'مرحبًا {name}، نؤكد موعدكم في {clinic} يوم {date} على الساعة {time}. ' +
        'يرجى تأكيد الحضور. شكرًا لكم.'
    },
    {
      label: 'تذكير قبل الموعد بساعة',
      fields: ['time'],
      template: 'مرحبًا {name}، نذكّركم بموعدكم في {clinic} اليوم على الساعة {time}. ' +
        'يرجى تأكيد الحضور. شكرًا لكم.'
    },
    {
      label: 'إشعار باقتراب الدور',
      fields: [],
      template: 'مرحبًا {name}، اقترب دوركم في {clinic}. ' +
        'يرجى الاستعداد للحضور إلى قاعة العلاج.'
    },
    {
      label: 'إشعار جاهزية الطبيب',
      fields: [],
      template: 'مرحبًا {name}، الطبيب جاهز لاستقبالكم الآن في {clinic}. تفضلوا بالدخول.'
    },
    {
      label: 'تغيير الموعد',
      fields: ['date', 'time'],
      template: 'مرحبًا {name}، نعتذر عن تغيير موعدكم في {clinic}. ' +
        'الموعد الجديد يوم {date} على الساعة {time}. نرجو التأكيد. شكرًا لكم.'
    },
    {
      label: 'تذكير بالدفع',
      fields: ['amount'],
      template: 'مرحبًا {name}، نذكّركم بوجود مبلغ متبقي قدره {amount} دج على حسابكم في {clinic}. ' +
        'يمكنكم السداد عند الزيارة القادمة. شكرًا لكم.'
    }
  ];
}

/**
 * Replaces {placeholders} in a template.
 * @param {string} template
 * @param {Object} params
 * @return {string}
 */
function renderTemplate_(template, params) {
  var result = String(template);
  Object.keys(params || {}).forEach(function (key) {
    result = result.split('{' + key + '}').join(String(params[key]));
  });
  return result;
}

/**
 * Builds a WhatsApp click-to-chat link.
 * @param {string} phone Raw or normalized phone number.
 * @param {string} message Plain-text message (URL-encoded automatically).
 * @return {{ok: boolean, link?: string, error?: string}}
 */
function buildWhatsAppLink_(phone, message) {
  var normalized = normalizeDzPhone_(phone);
  if (!normalized.ok) {
    return { ok: false, error: normalized.error };
  }
  var text = String(message || '').trim();
  if (text === '') {
    return { ok: false, error: 'نص الرسالة فارغ.' };
  }
  return {
    ok: true,
    link: 'https://wa.me/' + normalized.phone + '?text=' + encodeURIComponent(text)
  };
}

/**
 * Collects extra template parameters from the user.
 * @param {Array<string>} fields
 * @param {Object} patient
 * @return {Object} params
 */
function collectTemplateParams_(fields, patient) {
  var params = {
    name: patient.name,
    clinic: clinicName_()
  };
  fields.forEach(function (field) {
    if (field === 'date') {
      var dateStr = prompt_('إرسال رسالة واتساب',
        'التاريخ (yyyy-MM-dd):', todayStr_());
      if (!isValidDateStr_(dateStr)) {
        throw new Error('صيغة التاريخ غير صحيحة. استخدم yyyy-MM-dd مثل 2026-12-01.');
      }
      params.date = dateStr;
    } else if (field === 'time') {
      var timeStr = prompt_('إرسال رسالة واتساب',
        'الوقت (HH:mm مثل 14:30):', '10:00');
      if (!isValidTimeStr_(timeStr)) {
        throw new Error('صيغة الوقت غير صحيحة. استخدم HH:mm مثل 14:30.');
      }
      params.time = timeStr;
    } else if (field === 'amount') {
      var openVisit = findOpenVisit_(patient.id);
      var defaultAmount = openVisit ? String(openVisit.remaining) : '';
      var amountRaw = prompt_('إرسال رسالة واتساب',
        'المبلغ المتبقي (دج):', defaultAmount);
      var amount = parseAmount_(amountRaw, 'المبلغ المتبقي');
      if (amount < 0) {
        throw new Error('المبلغ لا يمكن أن يكون سالبا.');
      }
      params.amount = String(amount);
    }
  });
  return params;
}

/**
 * UI: picks a patient and a template, then opens the WhatsApp link.
 */
function uiSendWhatsApp() {
  var patient = uiPickPatient_('إرسال رسالة واتساب');
  var templates = getWhatsAppTemplates_();
  var labels = templates.map(function (t) {
    return t.label;
  });
  var label = promptChoice_('إرسال رسالة واتساب', 'اختر نوع الرسالة:', labels);
  var template = templates[labels.indexOf(label)];

  var params = collectTemplateParams_(template.fields, patient);
  var message = renderTemplate_(template.template, params);
  var result = buildWhatsAppLink_(patient.phone, message);
  if (!result.ok) {
    throw new Error(result.error);
  }

  // Mark today's queue row (if any) with the notification status.
  var queueRows = todayQueue_();
  for (var i = 0; i < queueRows.length; i++) {
    if (queueRows[i].patientId === patient.id) {
      setQueueNotifyStatus_(queueRows[i].queueId, 'تم فتح الرابط ' + nowTimeStr_());
      break;
    }
  }

  openUrl_(result.link, 'فتح WhatsApp',
    'ملاحظة هامة: فتح الرابط لا يرسل الرسالة تلقائيا. يجب الضغط على زر الإرسال داخل WhatsApp.');
}
