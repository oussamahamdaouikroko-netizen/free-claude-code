/* Dental Prescriptions (Ordonnances Dentaires), Algerian Dental Medications Catalog & Certificates. */
(function () {
  'use strict';
  const { t, formatDate } = window.I18N;
  const { h, clear, emptyState, toast, errorMessage, input, select, textarea, field, modal, todayISO } = window.UI;
  const Pages = window.Pages;

  const DENTAL_CATEGORIES = [
    ['', 'rx.catAll'],
    ['dental_antibiotique', 'rx.catAntibio'],
    ['dental_antalgique', 'rx.catAntalgique'],
    ['dental_anti_inflammatoire', 'rx.catAntiInflam'],
    ['dental_bain_gel', 'rx.catBainGel'],
    ['dental_antifongique_antiviral', 'rx.catAntifongique'],
    ['dental_anesthesique_hemostatique', 'rx.catAnesthesique'],
    ['dental_gastroprotection', 'rx.catGastro'],
  ];

  const TOOTH_QUICK_CHIPS = [
    '18', '16', '21', '26', '28',
    '38', '36', '41', '46', '48',
    'Arcade sup.', 'Arcade inf.', ' Parodonte',
  ];

  const DENTAL_EXAM_CHIPS = [
    'Radiographie panoramique dentaire (OPT)',
    'Cône Beam 3D (CBCT) maxillaire / mandibulaire',
    'Cliché rétro-alvéolaire',
    'Télécrâne de profil',
    'NFS + Hémostase (TP, TCA, INR)',
    'Glycémie à jeun + HbA1c',
  ];

  const DURATION_CHIPS = ['3 jours', '5 jours', '6 jours', '7 jours', '10 jours', '14 jours'];

  let activeTab = 'compose';
  let draft = createEmptyDraft();

  function createEmptyDraft() {
    return {
      patient_id: null,
      patient_name: '',
      patient_age: '',
      patient_weight: '',
      patient_allergies: '',
      patient_chronic: '',
      tooth_ref: '',
      day: todayISO(),
      diagnosis: '',
      exams_requested: '',
      advice: '',
      print_mode: 'both',
      items: [],
    };
  }

  function computeAgeText(birthDate) {
    if (!birthDate) return '';
    const m = String(birthDate).match(/^(\d{4})/);
    if (!m) return '';
    const yr = Number.parseInt(m[1], 10);
    const cur = Number.parseInt(todayISO().slice(0, 4), 10);
    if (!yr || yr < 1900 || yr > cur) return '';
    const diff = cur - yr;
    return diff > 0 ? `${diff} ans` : '< 1 an';
  }

  function openAddCustomDrugModal(onAdded) {
    const brand = input({ placeholder: 'Ex. Birodogyl, Eludril, Surgam…', autofocus: true });
    const dci = input({ placeholder: 'Ex. Spiramycine + Métronidazole…' });
    const strength = input({ placeholder: 'Ex. 1,5 M UI / 250 mg, 0,12%…' });
    const form = input({ value: 'Comprimé', placeholder: 'Comprimé, Bain de bouche, Gel buccal…' });
    const category = select(
      DENTAL_CATEGORIES.slice(1).map(([val, key]) => ({ value: val, label: t(key) })),
    );
    const keywordsAr = input({ placeholder: 'كلمات بحث بالعربية (اختياري)…' });
    const defaultDosage = input({ placeholder: 'Ex. 1 comprimé × 2 / jour' });
    const defaultDuration = input({ placeholder: 'Ex. 6 jours' });
    const err = h('div', { class: 'error-text' });

    modal({
      title: t('rx.addCustomDrug'),
      body: h(
        'div',
        { class: 'col' },
        h('div', { class: 'grid two' }, field(t('rx.drugName'), brand), field(t('rx.dci'), dci)),
        h('div', { class: 'grid three' }, field(t('rx.formStrength'), form), field(t('rx.dosage'), strength), field(t('rx.catAll'), category)),
        h('div', { class: 'grid two' }, field(t('rx.dosage'), defaultDosage), field(t('rx.duration'), defaultDuration)),
        field(t('common.arabic'), keywordsAr),
        err,
      ),
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        {
          label: t('common.save'),
          kind: 'primary',
          onClick: async () => {
            err.textContent = '';
            try {
              const med = await window.API.invoke('prescriptions:medication-create', {
                brand: brand.value.trim(),
                dci: dci.value.trim(),
                strength: strength.value.trim(),
                form: form.value.trim(),
                specialty: category.value,
                keywords_ar: keywordsAr.value.trim(),
                default_dosage: defaultDosage.value.trim(),
                default_duration: defaultDuration.value.trim(),
              });
              toast(t('common.saved'), 'ok');
              if (onAdded) onAdded(med);
              return true;
            } catch (e) {
              err.textContent = errorMessage(e);
              return false;
            }
          },
        },
      ],
    });
  }

  async function openRxPreviewModal(rxId, initialFormat = 'A4', initialMode = 'both') {
    let format = initialFormat;
    let printMode = initialMode;
    const frame = h('iframe', { class: 'rx-preview-frame', sandbox: 'allow-same-origin' });
    const formatSel = select(
      [
        { value: 'A4', label: t('rx.formatA4') },
        { value: 'A5', label: t('rx.formatA5') },
      ],
      { value: format, style: { maxWidth: '200px' } },
    );
    const modeSel = select(
      [
        { value: 'both', label: t('rx.modeBoth') },
        { value: 'brand', label: t('rx.modeBrand') },
        { value: 'dci', label: t('rx.modeDci') },
      ],
      { value: printMode, style: { maxWidth: '220px' } },
    );

    const loadPreview = async () => {
      try {
        const res = await window.API.invoke('print:prescription-preview', {
          id: rxId,
          format,
          print_mode: printMode,
        });
        frame.srcdoc = res.html || '';
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    };

    formatSel.addEventListener('change', () => {
      format = formatSel.value;
      loadPreview();
    });
    modeSel.addEventListener('change', () => {
      printMode = modeSel.value;
      loadPreview();
    });

    modal({
      title: t('rx.previewTitle'),
      wide: true,
      body: h(
        'div',
        { class: 'col' },
        h('div', { class: 'row wrap', style: { gap: '10px' } }, formatSel, modeSel),
        frame,
      ),
      actions: [
        { label: t('common.close'), kind: 'ghost' },
        {
          label: '🖨️ ' + t('rx.printNow'),
          kind: 'primary',
          close: false,
          onClick: async () => {
            try {
              await window.API.invoke('print:prescription', {
                id: rxId,
                format,
                print_mode: printMode,
              });
            } catch (err) {
              if (err.code === 'PRINT_UNAVAILABLE') {
                if (frame.contentWindow) frame.contentWindow.print();
                return false;
              }
              toast(errorMessage(err), 'error');
            }
            return false;
          },
        },
      ],
    });

    await loadPreview();
  }

  async function openCertPreviewModal(certId) {
    const frame = h('iframe', { class: 'rx-preview-frame', sandbox: 'allow-same-origin' });
    modal({
      title: t('cert.previewTitle'),
      wide: true,
      body: frame,
      actions: [
        { label: t('common.close'), kind: 'ghost' },
        {
          label: '🖨️ ' + t('rx.printNow'),
          kind: 'primary',
          close: false,
          onClick: async () => {
            try {
              await window.API.invoke('print:certificate', { id: certId });
            } catch (err) {
              if (err.code === 'PRINT_UNAVAILABLE') {
                if (frame.contentWindow) frame.contentWindow.print();
                return false;
              }
              toast(errorMessage(err), 'error');
            }
            return false;
          },
        },
      ],
    });
    try {
      const res = await window.API.invoke('print:certificate-preview', { id: certId });
      frame.srcdoc = res.html || '';
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  function promptSafetyOverride() {
    return new Promise((resolve) => {
      let decided = false;
      const reasonInput = input({ placeholder: t('safety.overridePlaceholder'), autofocus: true });
      const err = h('div', { class: 'error-text' });
      const finish = (val) => {
        if (decided) return;
        decided = true;
        resolve(val);
      };
      modal({
        title: t('common.confirm'),
        body: h('div', { class: 'col' }, h('p', {}, t('safety.overridePrompt')), reasonInput, err),
        actions: [
          { label: t('common.cancel'), kind: 'ghost', onClick: () => finish(null) },
          {
            label: t('common.confirm'),
            kind: 'danger',
            onClick: () => {
              if (!reasonInput.value.trim()) {
                err.textContent = t('common.required');
                return false;
              }
              finish(reasonInput.value.trim());
              return true;
            },
          },
        ],
        onClose: () => finish(null),
      });
    });
  }

  /* ======================================================================== */
  /*  TAB 1: Compose Dental Prescription                                      */
  /* ======================================================================== */
  async function renderCompose(host, ctx, shared) {
    const { patientsList, templates, medStats } = shared;
    const s = window.App.settings || {};

    const headerStrip = h(
      'div',
      { class: 'rx-header-strip mb' },
      h(
        'div',
        {},
        h('div', { class: 'small muted' }, t('rx.headerPreview')),
        h('div', { style: { fontWeight: '800', fontSize: '1.05rem', color: 'var(--teal-900)' } }, `🦷 ${s.clinic_name || 'DentaRDV'}`),
        h(
          'div',
          { class: 'small', style: { marginTop: '2px' } },
          `${s.doctor_name || '—'} · `,
          h('strong', { style: { color: 'var(--teal-700)' } }, s.doctor_specialty || 'Chirurgien-Dentiste'),
          s.doctor_ordre ? ` · OMD: ${s.doctor_ordre}` : '',
        ),
      ),
      h(
        'div',
        { class: 'row wrap', style: { gap: '8px' } },
        h('span', { class: 'badge ok' }, t('rx.dentalOnlyBadge', { n: medStats?.total || 620 })),
        h('button', { class: 'btn sm ghost', onClick: () => ctx.navigate('settings') }, '⚙️ ', t('rx.editHeader')),
      ),
    );

    const patientPicker = select(
      [{ value: '', label: t('agenda.choosePatient') }].concat(
        patientsList.map((p) => ({
          value: String(p.id),
          label: `${p.full_name}${p.phone ? ` · ${p.phone}` : ''}`,
        })),
      ),
      { value: draft.patient_id ? String(draft.patient_id) : '' },
    );

    const nameInput = input({ value: draft.patient_name, placeholder: t('rx.walkInName') });
    const ageInput = input({ value: draft.patient_age, placeholder: t('rx.agePlaceholder') });
    const weightInput = input({ value: draft.patient_weight, placeholder: t('rx.weightPlaceholder') });
    const toothInput = input({ value: draft.tooth_ref, placeholder: t('rx.toothPlaceholder') });
    const dateInput = input({ type: 'date', value: draft.day || todayISO() });
    const diagInput = input({ value: draft.diagnosis, placeholder: t('rx.diagnosisPlaceholder') });
    const printModeSel = select(
      [
        { value: 'both', label: t('rx.modeBoth') },
        { value: 'brand', label: t('rx.modeBrand') },
        { value: 'dci', label: t('rx.modeDci') },
      ],
      { value: draft.print_mode || 'both' },
    );

    patientPicker.addEventListener('change', () => {
      const chosen = patientsList.find((p) => String(p.id) === patientPicker.value);
      if (chosen) {
        draft.patient_id = chosen.id;
        draft.patient_name = chosen.full_name;
        draft.patient_age = computeAgeText(chosen.birth_date);
        draft.patient_allergies = chosen.allergies || '';
        draft.patient_chronic = chosen.chronic_conditions || '';
      } else {
        draft.patient_id = null;
        draft.patient_allergies = '';
        draft.patient_chronic = '';
      }
      ctx.refresh();
    });

    nameInput.addEventListener('input', () => { draft.patient_name = nameInput.value; });
    ageInput.addEventListener('input', () => { draft.patient_age = ageInput.value; refreshSafety(); });
    weightInput.addEventListener('input', () => { draft.patient_weight = weightInput.value; refreshSafety(); });
    toothInput.addEventListener('input', () => { draft.tooth_ref = toothInput.value; });
    dateInput.addEventListener('change', () => { draft.day = dateInput.value; });
    diagInput.addEventListener('input', () => { draft.diagnosis = diagInput.value; });
    printModeSel.addEventListener('change', () => { draft.print_mode = printModeSel.value; });

    const toothChips = h(
      'div',
      { class: 'chip-row', style: { marginTop: '6px' } },
      TOOTH_QUICK_CHIPS.map((chip) =>
        h(
          'button',
          {
            type: 'button',
            class: 'chip-btn',
            onClick: () => {
              const cur = toothInput.value.trim();
              const val = chip.trim();
              toothInput.value = cur ? `${cur}, ${val}` : val;
              draft.tooth_ref = toothInput.value;
            },
          },
          chip.trim(),
        ),
      ),
    );

    // Pre-visit WhatsApp intake review banner (Law 18-07 — never auto-applied without dentist click)
    const intakeBannerHost = h('div', {});
    if (draft.patient_id) {
      window.API.invoke('intake:for-patient', { patient_id: draft.patient_id })
        .then((res) => {
          const latestIntake = res?.pending || res?.latest;
          if (!latestIntake || latestIntake.status === 'rejected' || !intakeBannerHost.isConnected) return;
          const parts = [];
          if (latestIntake.effective_age_years !== null && latestIntake.effective_age_years !== undefined) {
            parts.push(
              latestIntake.effective_age_years < 2
                ? t('intake.ageUnitMonths', { n: Math.round(latestIntake.effective_age_years * 12) })
                : t('intake.ageUnitYears', { n: Math.round(latestIntake.effective_age_years * 10) / 10 }),
            );
          }
          if (latestIntake.weight_kg) parts.push(`${latestIntake.weight_kg} kg`);
          if (latestIntake.chief_complaint) parts.push(latestIntake.chief_complaint);
          const summary = parts.join(' · ') || '—';
          const isPending = latestIntake.status !== 'applied';

          intakeBannerHost.replaceChildren(
            h(
              'div',
              {
                class: 'card row wrap between mb',
                style: {
                  padding: '10px 14px',
                  border: isPending ? '1.5px solid var(--warn)' : '1px solid var(--teal-700)',
                  background: isPending ? 'var(--warn-soft)' : 'var(--teal-50)',
                  gap: '10px',
                },
              },
              h(
                'div',
                { class: 'row wrap', style: { gap: '8px' } },
                window.Icons ? window.Icons.el('clipboard', { size: 17 }) : '',
                h('span', { class: 'small strong' }, t(isPending ? 'intake.rxBannerPending' : 'intake.rxBannerApplied', { summary })),
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: `btn sm ${isPending ? 'primary' : 'soft'}`,
                  onClick: async () => {
                    try {
                      if (isPending) {
                        const out = await window.API.invoke('intake:confirm', { id: latestIntake.id });
                        const prefill = out.prescription_prefill || {};
                        if (prefill.patient_age && !draft.patient_age) draft.patient_age = prefill.patient_age;
                        if (prefill.patient_weight) draft.patient_weight = prefill.patient_weight;
                        if (prefill.chief_complaint && !draft.diagnosis) draft.diagnosis = prefill.chief_complaint;
                        toast(t('intake.appliedToast'), 'ok');
                      } else {
                        if (latestIntake.effective_age_years && !draft.patient_age) {
                          draft.patient_age = `${Math.round(latestIntake.effective_age_years)} ans`;
                        }
                        if (latestIntake.weight_kg) draft.patient_weight = `${latestIntake.weight_kg} kg`;
                        if (latestIntake.chief_complaint && !draft.diagnosis) draft.diagnosis = latestIntake.chief_complaint;
                      }
                      ctx.refresh();
                    } catch (err) {
                      toast(errorMessage(err), 'error');
                    }
                  },
                },
                t(isPending ? 'intake.rxConfirmImportBtn' : 'intake.rxImportBtn'),
              ),
            ),
          );
        })
        .catch(() => {});
    }

    // Clinical safety alerts host
    let latestSafetyEval = { alerts: [], requires_override: false };
    const safetyAlertHost = h('div', { class: 'col mb', style: { gap: '8px' } });

    const severityLabel = (sev) => {
      if (sev === 'contraindicated') return t('safety.sevContraindicated');
      if (sev === 'avoid') return t('safety.sevAvoid');
      if (sev === 'caution') return t('safety.sevCaution');
      return t('safety.sevMonitor');
    };

    async function refreshSafety() {
      clear(safetyAlertHost);
      if (draft.patient_allergies) {
        safetyAlertHost.append(
          h('div', { class: 'allergy-alert' }, '🚫 ', t('rx.allergyBanner', { allergies: draft.patient_allergies })),
        );
      }
      if (draft.items.length === 0) {
        latestSafetyEval = { alerts: [], requires_override: false };
        return;
      }
      try {
        const res = await window.API.invoke('safety:evaluate', {
          patient_id: draft.patient_id,
          patient_weight: draft.patient_weight,
          patient_age: draft.patient_age,
          patient_allergies: draft.patient_allergies,
          patient_chronic: draft.patient_chronic,
          items: draft.items,
        });
        latestSafetyEval = res;
        if (!safetyAlertHost.isConnected) return;
        const isAr = window.App?.language === 'ar';
        if (res.alerts.length > 0) {
          safetyAlertHost.append(
            h(
              'div',
              { class: 'small muted', style: { padding: '2px 6px' } },
              window.Icons ? window.Icons.el('shield', { size: 14 }) : '',
              ' ',
              t('safety.disclaimerBanner'),
            ),
          );
        }
        for (const a of res.alerts) {
          const isSevere = a.severity === 'contraindicated' || a.severity === 'avoid';
          safetyAlertHost.append(
            h(
              'div',
              {
                class: isSevere ? 'allergy-alert' : 'card row wrap between',
                style: isSevere
                  ? { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }
                  : { padding: '8px 12px', border: '1px solid var(--warn)', gap: '8px' },
              },
              h(
                'div',
                { class: 'row wrap', style: { gap: '8px' } },
                h('span', { class: `badge ${isSevere ? 'danger' : 'warn'}` }, severityLabel(a.severity)),
                h('span', {}, isAr ? a.message_ar || a.message_fr : a.message_fr),
              ),
              !a.verified ? h('span', { class: 'badge warn' }, t('safety.unverifiedRuleTag')) : null,
            ),
          );
        }
      } catch (_err) {
        /* ignore transient safety eval error */
      }
    }

    const examsArea = textarea({ value: draft.exams_requested, placeholder: t('rx.examsPlaceholder') });
    const adviceArea = textarea({ value: draft.advice, placeholder: t('rx.advicePlaceholder') });
    examsArea.addEventListener('input', () => { draft.exams_requested = examsArea.value; });
    adviceArea.addEventListener('input', () => { draft.advice = adviceArea.value; });

    const examChips = h(
      'div',
      { class: 'chip-row', style: { marginTop: '6px' } },
      DENTAL_EXAM_CHIPS.map((ex) =>
        h(
          'button',
          {
            type: 'button',
            class: 'chip-btn',
            onClick: () => {
              const cur = examsArea.value.trim();
              examsArea.value = cur ? `${cur}\n• ${ex}` : `• ${ex}`;
              draft.exams_requested = examsArea.value;
            },
          },
          ex,
        ),
      ),
    );

    // Quick dental protocol chips
    const templateChips = h(
      'div',
      { class: 'chip-row mb' },
      templates.map((tpl) =>
        h(
          'button',
          {
            type: 'button',
            class: 'chip-btn',
            onClick: () => {
              draft.items = (tpl.items || []).map((it) => ({ ...it, substitutable: 1 }));
              if (tpl.exams_requested && !draft.exams_requested) {
                draft.exams_requested = tpl.exams_requested;
                examsArea.value = draft.exams_requested;
              }
              if (tpl.advice && !draft.advice) {
                draft.advice = tpl.advice;
                adviceArea.value = draft.advice;
              }
              renderItemsList();
            },
          },
          `📋 ${window.App.language === 'ar' ? tpl.title_ar || tpl.title_fr : tpl.title_fr}`,
        ),
      ),
    );

    // Prescribed items container
    const itemsHost = h('div', { class: 'col' });
    const countTitle = h('h3', { style: { margin: '0', fontSize: '1rem' } }, t('rx.selectedDrugs', { n: draft.items.length }));

    function renderItemsList() {
      countTitle.textContent = t('rx.selectedDrugs', { n: draft.items.length });
      refreshSafety();
      clear(itemsHost);
      if (draft.items.length === 0) {
        itemsHost.append(h('div', { class: 'muted small', style: { padding: '14px 4px' } }, t('rx.noDrugsYet')));
        return;
      }

      draft.items.forEach((item, index) => {
        const drugField = input({ value: item.drug_name || '', placeholder: t('rx.drugName') });
        const formField = input({ value: item.form_strength || '', placeholder: t('rx.formStrength') });
        const dosageField = input({ value: item.dosage || '', placeholder: t('rx.dosage') });
        const timingField = input({ value: item.timing || '', placeholder: t('rx.timing') });
        const durationField = input({ value: item.duration || '', placeholder: t('rx.duration') });
        const qtyField = input({ value: item.quantity || '', placeholder: '1 boîte / 1 flacon' });

        drugField.addEventListener('input', () => { item.drug_name = drugField.value; refreshSafety(); });
        formField.addEventListener('input', () => { item.form_strength = formField.value; });
        dosageField.addEventListener('input', () => { item.dosage = dosageField.value; });
        timingField.addEventListener('input', () => { item.timing = timingField.value; });
        durationField.addEventListener('input', () => { item.duration = durationField.value; refreshSafety(); });
        qtyField.addEventListener('input', () => { item.quantity = qtyField.value; });

        const doseCalcBox = h('div', {});
        const calcBtn = h(
          'button',
          {
            type: 'button',
            class: 'btn sm soft',
            onClick: async () => {
              clear(doseCalcBox);
              try {
                const calc = await window.API.invoke('safety:pediatric-dose', {
                  dci: item.dci || item.drug_name,
                  drug_name: item.drug_name,
                  form_strength: item.form_strength,
                  weight_kg: weightInput.value || draft.patient_weight,
                  patient_age: ageInput.value || draft.patient_age,
                });
                if (!calc.matched) {
                  doseCalcBox.append(h('div', { class: 'muted small', style: { marginTop: '6px' } }, t('safety.noDoseRule')));
                  return;
                }
                const isAr = window.App?.language === 'ar';
                doseCalcBox.append(
                  h(
                    'div',
                    {
                      class: 'card row wrap between',
                      style: { padding: '8px 12px', marginTop: '6px', background: 'var(--teal-50)', gap: '8px' },
                    },
                    h(
                      'div',
                      { class: 'col', style: { gap: '3px' } },
                      h('div', { class: 'small strong' }, isAr ? calc.formula_ar : calc.formula_fr),
                      h(
                        'div',
                        { class: 'row wrap', style: { gap: '6px' } },
                        h('span', { class: `badge ${calc.verified ? 'ok' : 'warn'}` }, t(calc.verified ? 'safety.verifiedRuleTag' : 'safety.unverifiedRuleTag')),
                        calc.notes_fr || calc.notes_ar
                          ? h('span', { class: 'muted small' }, isAr ? calc.notes_ar || calc.notes_fr : calc.notes_fr)
                          : null,
                      ),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        class: 'btn sm primary',
                        onClick: () => {
                          item.dosage = calc.suggested_dosage_fr;
                          dosageField.value = calc.suggested_dosage_fr;
                          if (calc.max_duration_days && !item.duration) {
                            item.duration = `${calc.max_duration_days} jours`;
                            durationField.value = item.duration;
                          }
                        },
                      },
                      t('safety.applyCalcBtn'),
                    ),
                  ),
                );
              } catch (err) {
                toast(errorMessage(err), 'error');
              }
            },
          },
          window.Icons ? window.Icons.el('scale', { size: 14 }) : '',
          ' ',
          t('safety.pediatricBtn'),
        );

        const subBtn = h(
          'button',
          {
            type: 'button',
            class: 'btn sm ghost',
            onClick: async () => {
              try {
                const { substitutes = [] } = await window.API.invoke('prescriptions:substitutes', {
                  medication_id: item.medication_id,
                  dci: item.dci,
                });
                const subDialog = modal({
                  title: `${t('nom.substituteModalTitle')} — ${item.dci || item.drug_name}`,
                  wide: true,
                  body:
                    substitutes.length === 0
                      ? h('div', { class: 'muted small' }, t('nom.noSubstitutes'))
                      : h(
                          'div',
                          { class: 'col', style: { gap: '8px' } },
                          substitutes.map((med) =>
                            h(
                              'div',
                              { class: 'card row wrap between', style: { padding: '8px 12px', gap: '8px' } },
                              h(
                                'div',
                                { class: 'col', style: { gap: '2px' } },
                                h(
                                  'div',
                                  { class: 'row wrap', style: { gap: '6px' } },
                                  h('strong', {}, `${med.brand}${med.strength ? ` · ${med.strength}` : ''}`),
                                  med.is_generic ? h('span', { class: 'badge ok' }, t('nom.genericBadge')) : null,
                                  med.reimbursable
                                    ? h('span', { class: 'badge ok' }, t('nom.reimbBadge', { rate: med.reimbursement_rate || 80 }))
                                    : null,
                                ),
                                h('div', { class: 'muted small' }, [med.form, med.dci].filter(Boolean).join(' · ')),
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  class: 'btn sm primary',
                                  onClick: () => {
                                    item.medication_id = med.id;
                                    item.drug_name = med.brand;
                                    item.dci = med.dci || item.dci;
                                    item.form_strength = [med.form, med.strength].filter(Boolean).join(' · ');
                                    item.schedule = med.schedule || '';
                                    subDialog.close();
                                    renderItemsList();
                                  },
                                },
                                t('nom.replaceBtn'),
                              ),
                            ),
                          ),
                        ),
                  actions: [{ label: t('common.close'), kind: 'ghost' }],
                });
              } catch (err) {
                toast(errorMessage(err), 'error');
              }
            },
          },
          window.Icons ? window.Icons.el('repeat', { size: 14 }) : '',
          ' ',
          t('nom.substituteBtn'),
        );

        const timingChips = [
          t('rx.timingAfterMeal'),
          t('rx.timingDuringMeal'),
          t('rx.timingIfPain'),
          t('rx.timingAfter24h'),
          t('rx.timingBedtime'),
        ].map((lbl) =>
          h(
            'button',
            {
              type: 'button',
              class: 'chip-btn',
              onClick: () => {
                item.timing = lbl;
                timingField.value = lbl;
              },
            },
            lbl,
          ),
        );

        const durationChips = DURATION_CHIPS.map((lbl) =>
          h(
            'button',
            {
              type: 'button',
              class: 'chip-btn',
              onClick: () => {
                item.duration = lbl;
                durationField.value = lbl;
              },
            },
            lbl,
          ),
        );

        const nonSubChk = h('input', { type: 'checkbox', checked: item.substitutable === 0 || item.substitutable === false });
        nonSubChk.addEventListener('change', () => {
          item.substitutable = nonSubChk.checked ? 0 : 1;
        });

        itemsHost.append(
          h(
            'div',
            { class: 'rx-item-card' },
            h(
              'div',
              { class: 'rx-item-head' },
              h(
                'div',
                { class: 'row', style: { gap: '8px', flex: '1' } },
                h('span', { class: 'rx-item-num' }, String(index + 1)),
                h('strong', {}, item.drug_name || t('rx.drugName')),
                item.dci ? h('span', { class: 'muted small' }, `(${item.dci})`) : null,
              ),
              h(
                'div',
                { class: 'row wrap', style: { gap: '6px' } },
                subBtn,
                calcBtn,
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn icon sm ghost',
                    title: t('common.delete'),
                    onClick: () => {
                      draft.items.splice(index, 1);
                      renderItemsList();
                    },
                  },
                  '✕',
                ),
              ),
            ),
            doseCalcBox,
            h('div', { class: 'grid two' }, field(t('rx.drugName'), drugField), field(t('rx.formStrength'), formField)),
            h('div', { class: 'grid three' }, field(t('rx.dosage'), dosageField), field(t('rx.timing'), timingField), field(t('rx.duration'), durationField)),
            h('div', { class: 'row wrap between', style: { gap: '8px' } }, h('div', { class: 'chip-row' }, timingChips), h('div', { class: 'chip-row' }, durationChips)),
            h(
              'div',
              { class: 'grid two', style: { alignItems: 'end' } },
              field(t('rx.quantity'), qtyField),
              h('label', { class: 'row', style: { gap: '6px', cursor: 'pointer', paddingBottom: '8px' } }, nonSubChk, h('span', { class: 'small' }, t('nom.nonSubstitutable'))),
            ),
          ),
        );
      });
    }

    // Dental-only Algerian Drug Search Box
    let activeCat = '';
    const drugQuery = input({ placeholder: t('rx.searchDrug') });
    const catSelect = select(
      DENTAL_CATEGORIES.map(([val, key]) => ({ value: val, label: t(key) })),
      { style: { maxWidth: '240px' } },
    );
    const drugResultsHost = h('div', { class: 'drug-results' });

    async function runDrugSearch() {
      try {
        const meds = await window.API.invoke('prescriptions:medications', {
          query: drugQuery.value.trim(),
          specialty: activeCat,
          limit: 30,
        });
        clear(drugResultsHost);
        if (meds.length === 0) {
          drugResultsHost.append(h('div', { class: 'muted small', style: { padding: '12px 14px' } }, t('common.searchEmpty')));
          return;
        }
        for (const med of meds) {
          drugResultsHost.append(
            h(
              'button',
              {
                type: 'button',
                class: 'drug-option',
                onClick: () => {
                  draft.items.push({
                    medication_id: med.id,
                    drug_name: med.brand,
                    dci: med.dci || '',
                    form_strength: [med.form, med.strength].filter(Boolean).join(' · '),
                    dosage: med.default_dosage || '',
                    timing: '',
                    duration: med.default_duration || '',
                    quantity: '',
                    note: '',
                    substitutable: 1,
                    schedule: med.schedule || '',
                  });
                  renderItemsList();
                },
              },
              h(
                'div',
                {},
                h(
                  'div',
                  { class: 'drug-brand' },
                  `🦷 ${med.brand}${med.strength ? ` · ${med.strength}` : ''}`,
                  med.is_generic ? ` [${t('nom.genericBadge')}]` : '',
                ),
                h(
                  'div',
                  { class: 'drug-sub' },
                  [med.dci, med.form, med.default_dosage].filter(Boolean).join(' · '),
                ),
              ),
              h('span', { class: 'badge soft' }, '＋'),
            ),
          );
        }
      } catch (err) {
        clear(drugResultsHost).append(h('div', { class: 'error-text', style: { padding: '8px' } }, errorMessage(err)));
      }
    }

    drugQuery.addEventListener('input', window.UI.debounce(runDrugSearch, 180));
    catSelect.addEventListener('change', () => {
      activeCat = catSelect.value;
      runDrugSearch();
    });

    async function submitPrescription({ preview }) {
      try {
        let overrideReason = '';
        if (latestSafetyEval.requires_override) {
          const reason = await promptSafetyOverride();
          if (!reason) return;
          overrideReason = reason;
        }
        const payload = {
          patient_id: draft.patient_id,
          patient_name: draft.patient_name.trim(),
          patient_age: draft.patient_age.trim(),
          patient_weight: draft.patient_weight.trim(),
          tooth_ref: draft.tooth_ref.trim(),
          day: draft.day,
          diagnosis: draft.diagnosis.trim(),
          exams_requested: draft.exams_requested.trim(),
          advice: draft.advice.trim(),
          print_mode: draft.print_mode,
          safety_override_reason: overrideReason,
          items: draft.items,
        };
        const created = await window.API.invoke('prescriptions:create', payload);
        toast(t('common.saved'), 'ok');
        draft = createEmptyDraft();
        if (preview && created?.id) {
          await openRxPreviewModal(created.id, 'A4', created.print_mode || 'both');
        }
        ctx.refresh();
      } catch (err) {
        if (err.code === 'SAFETY_OVERRIDE_REQUIRED') {
          const reason = await promptSafetyOverride();
          if (reason) {
            latestSafetyEval.requires_override = false;
            const retryPayload = {
              patient_id: draft.patient_id,
              patient_name: draft.patient_name.trim(),
              patient_age: draft.patient_age.trim(),
              patient_weight: draft.patient_weight.trim(),
              tooth_ref: draft.tooth_ref.trim(),
              day: draft.day,
              diagnosis: draft.diagnosis.trim(),
              exams_requested: draft.exams_requested.trim(),
              advice: draft.advice.trim(),
              print_mode: draft.print_mode,
              safety_override_reason: reason,
              items: draft.items,
            };
            try {
              const created = await window.API.invoke('prescriptions:create', retryPayload);
              toast(t('common.saved'), 'ok');
              draft = createEmptyDraft();
              if (preview && created?.id) await openRxPreviewModal(created.id, 'A4', created.print_mode || 'both');
              ctx.refresh();
            } catch (err2) {
              toast(errorMessage(err2), 'error');
            }
          }
          return;
        }
        toast(errorMessage(err), 'error');
      }
    }

    const saveAsTemplateBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn sm ghost',
        onClick: () => {
          if (draft.items.length === 0) {
            toast(t('error.PRESCRIPTION_EMPTY'), 'error');
            return;
          }
          const tFr = input({ placeholder: t('rx.templateTitleFr'), autofocus: true });
          const tAr = input({ placeholder: t('rx.templateTitleAr') });
          const err = h('div', { class: 'error-text' });
          modal({
            title: t('rx.saveAsTemplate'),
            body: h('div', { class: 'col' }, field(t('rx.templateTitleFr'), tFr), field(t('rx.templateTitleAr'), tAr), err),
            actions: [
              { label: t('common.cancel'), kind: 'ghost' },
              {
                label: t('common.save'),
                kind: 'primary',
                onClick: async () => {
                  try {
                    await window.API.invoke('prescriptions:template-create', {
                      title_fr: tFr.value.trim(),
                      title_ar: tAr.value.trim(),
                      items: draft.items,
                      exams_requested: draft.exams_requested,
                      advice: draft.advice,
                    });
                    toast(t('common.saved'), 'ok');
                    ctx.refresh();
                    return true;
                  } catch (e) {
                    err.textContent = errorMessage(e);
                    return false;
                  }
                },
              },
            ],
          });
        },
      },
      '💾 ',
      t('rx.saveAsTemplate'),
    );

    host.append(
      headerStrip,
      intakeBannerHost,
      h(
        'div',
        { class: 'card mb' },
        h(
          'div',
          { class: 'grid three' },
          field(t('agenda.selectPatient'), patientPicker),
          field(t('rx.walkInName'), nameInput),
          field(t('common.date'), dateInput),
        ),
        h(
          'div',
          { class: 'grid four', style: { marginTop: '10px' } },
          field(t('patients.birth') + ' / Âge', ageInput),
          field('Poids (kg)', weightInput),
          field(t('rx.toothRef'), toothInput),
          field(t('rx.printMode'), printModeSel),
        ),
        toothChips,
        h('div', { style: { marginTop: '10px' } }, field(t('rx.diagnosis'), diagInput)),
      ),
      safetyAlertHost,
      templates.length > 0 ? templateChips : null,
      h(
        'div',
        { class: 'grid two', style: { alignItems: 'start' } },
        h(
          'div',
          { class: 'card col' },
          h(
            'div',
            { class: 'row wrap between' },
            h('h3', { style: { margin: '0', fontSize: '1rem' } }, t('settings.dentalCatalogTitle')),
            h('button', { type: 'button', class: 'btn sm soft', onClick: () => openAddCustomDrugModal(() => runDrugSearch()) }, '＋ ', t('rx.addCustomDrug')),
          ),
          h('div', { class: 'row wrap', style: { gap: '8px' } }, h('div', { style: { flex: '1', minWidth: '180px' } }, drugQuery), catSelect),
          drugResultsHost,
        ),
        h(
          'div',
          { class: 'col' },
          h(
            'div',
            { class: 'card col' },
            h('div', { class: 'row between' }, countTitle, saveAsTemplateBtn),
            itemsHost,
          ),
          h(
            'div',
            { class: 'card col' },
            field(t('rx.exams'), examsArea),
            examChips,
            field(t('rx.advice'), adviceArea),
            h(
              'div',
              { class: 'row wrap between mt-s' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn ghost',
                  onClick: () => {
                    draft = createEmptyDraft();
                    ctx.refresh();
                  },
                },
                t('rx.resetDraft'),
              ),
              h(
                'div',
                { class: 'row wrap', style: { gap: '8px' } },
                h('button', { type: 'button', class: 'btn', onClick: () => submitPrescription({ preview: false }) }, '💾 ', t('rx.saveOnly')),
                h('button', { type: 'button', class: 'btn primary', onClick: () => submitPrescription({ preview: true }) }, '🖨️ ', t('rx.saveAndPreview')),
              ),
            ),
          ),
        ),
      ),
    );

    renderItemsList();
    await runDrugSearch();
  }

  /* ======================================================================== */
  /*  TAB 2: Prescriptions History                                            */
  /* ======================================================================== */
  async function renderHistory(host, ctx) {
    const searchInput = input({ placeholder: t('patients.search'), style: { maxWidth: '340px' } });
    const tableHost = h('div', { class: 'card' });

    const load = async () => {
      try {
        const rows = await window.API.invoke('prescriptions:list', { search: searchInput.value.trim(), limit: 200 });
        clear(tableHost);
        if (rows.length === 0) {
          tableHost.append(emptyState(t('rx.historyEmpty'), 'prescription'));
          return;
        }
        tableHost.append(
          h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'list' },
              h(
                'thead',
                {},
                h(
                  'tr',
                  {},
                  h('th', {}, 'N°'),
                  h('th', {}, t('common.date')),
                  h('th', {}, t('common.patient')),
                  h('th', {}, t('rx.toothRef')),
                  h('th', {}, t('rx.diagnosis')),
                  h('th', {}, t('common.details')),
                  h('th', { class: 'actions' }, t('common.actions')),
                ),
              ),
              h(
                'tbody',
                {},
                rows.map((rx) =>
                  h(
                    'tr',
                    {},
                    h('td', { class: 'num' }, `#${rx.id}`),
                    h('td', {}, formatDate(rx.day)),
                    h(
                      'td',
                      {},
                      rx.patient_id
                        ? h('button', { class: 'btn ghost sm', style: { padding: '0', minHeight: 'auto', fontWeight: '700' }, onClick: () => window.openPatientFile(rx.patient_id) }, rx.patient_name)
                        : h('strong', {}, rx.patient_name),
                    ),
                    h('td', {}, rx.tooth_ref || '—'),
                    h('td', {}, rx.diagnosis || '—'),
                    h('td', {}, h('span', { class: 'badge soft' }, t('rx.itemsCount', { n: rx.items_count || 0 }))),
                    h(
                      'td',
                      { class: 'actions' },
                      h('button', { class: 'btn icon sm', title: t('rx.previewTitle'), onClick: () => openRxPreviewModal(rx.id, 'A4', rx.print_mode || 'both') }, '🖨️'),
                      h(
                        'button',
                        {
                          class: 'btn icon sm',
                          title: t('rx.reuseDraft'),
                          onClick: async () => {
                            const full = await window.API.invoke('prescriptions:get', { id: rx.id });
                            draft = {
                              ...createEmptyDraft(),
                              patient_id: full.patient_id,
                              patient_name: full.patient_name,
                              patient_age: full.patient_age || '',
                              patient_weight: full.patient_weight || '',
                              tooth_ref: full.tooth_ref || '',
                              diagnosis: full.diagnosis || '',
                              exams_requested: full.exams_requested || '',
                              advice: full.advice || '',
                              print_mode: full.print_mode || 'both',
                              items: (full.items || []).map((it) => ({ ...it })),
                            };
                            activeTab = 'compose';
                            ctx.refresh();
                          },
                        },
                        '↩️',
                      ),
                      h(
                        'button',
                        {
                          class: 'btn icon sm',
                          title: t('common.delete'),
                          onClick: async () => {
                            const ok = await window.UI.confirmDialog(t('rx.deleteConfirm'));
                            if (!ok) return;
                            try {
                              await window.API.invoke('prescriptions:remove', { id: rx.id });
                              toast(t('common.deleted'), 'ok');
                              load();
                            } catch (err) {
                              toast(errorMessage(err), 'error');
                            }
                          },
                        },
                        '🗑️',
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      } catch (err) {
        clear(tableHost).append(h('div', { class: 'error-text' }, errorMessage(err)));
      }
    };

    searchInput.addEventListener('input', window.UI.debounce(load, 200));
    host.append(h('div', { class: 'row mb' }, searchInput), tableHost);
    await load();
  }

  /* ======================================================================== */
  /*  TAB 3: Dental Protocol Templates                                        */
  /* ======================================================================== */
  function renderTemplates(host, ctx, templates) {
    if (templates.length === 0) {
      host.append(h('div', { class: 'card' }, emptyState(t('rx.noTemplates'), 'prescription')));
      return;
    }
    const isAr = window.App.language === 'ar';
    host.append(
      h(
        'div',
        { class: 'grid two' },
        templates.map((tpl) =>
          h(
            'div',
            { class: 'card col' },
            h(
              'div',
              { class: 'row between' },
              h('strong', {}, isAr ? tpl.title_ar || tpl.title_fr : tpl.title_fr),
              h('span', { class: 'badge ok' }, t('rx.itemsCount', { n: (tpl.items || []).length })),
            ),
            h(
              'div',
              { class: 'col', style: { gap: '4px' } },
              (tpl.items || []).map((it, i) =>
                h('div', { class: 'small' }, `${i + 1}. `, h('strong', {}, it.drug_name), it.form_strength ? ` (${it.form_strength})` : '', it.dosage ? ` — ${it.dosage}` : ''),
              ),
            ),
            tpl.advice ? h('div', { class: 'muted small' }, `💡 ${tpl.advice}`) : null,
            h(
              'div',
              { class: 'row between mt-s' },
              h(
                'button',
                {
                  class: 'btn sm primary',
                  onClick: () => {
                    draft.items = (tpl.items || []).map((it) => ({ ...it, substitutable: 1 }));
                    if (tpl.exams_requested) draft.exams_requested = tpl.exams_requested;
                    if (tpl.advice) draft.advice = tpl.advice;
                    activeTab = 'compose';
                    ctx.refresh();
                  },
                },
                t('rx.applyTemplate'),
              ),
              h(
                'button',
                {
                  class: 'btn icon sm ghost',
                  title: t('common.delete'),
                  onClick: async () => {
                    const ok = await window.UI.confirmDialog(t('common.delete') + ' ?');
                    if (!ok) return;
                    try {
                      await window.API.invoke('prescriptions:template-remove', { id: tpl.id });
                      toast(t('common.deleted'), 'ok');
                      ctx.refresh();
                    } catch (err) {
                      toast(errorMessage(err), 'error');
                    }
                  },
                },
                '🗑️',
              ),
            ),
          ),
        ),
      ),
    );
  }

  /* ======================================================================== */
  /*  TAB 4: Dental Medical Certificates                                      */
  /* ======================================================================== */
  async function renderCertificates(host, ctx, patientsList) {
    const openCreateCertModal = () => {
      const patientSel = select(
        [{ value: '', label: t('agenda.choosePatient') }].concat(
          patientsList.map((p) => ({ value: String(p.id), label: p.full_name })),
        ),
      );
      const pName = input({ placeholder: t('rx.walkInName') });
      const pAge = input({ placeholder: t('rx.agePlaceholder') });
      const kindSel = select([
        { value: 'arret_travail', label: t('cert.arret_travail') },
        { value: 'aptitude', label: t('cert.aptitude') },
        { value: 'scolaire', label: t('cert.scolaire') },
        { value: 'general', label: t('cert.general') },
      ]);
      const restDays = input({ type: 'number', min: '0', max: '90', value: '2' });
      const startDay = input({ type: 'date', value: todayISO() });
      const content = textarea({ placeholder: t('cert.content') });
      const err = h('div', { class: 'error-text' });

      patientSel.addEventListener('change', () => {
        const chosen = patientsList.find((p) => String(p.id) === patientSel.value);
        if (chosen) {
          pName.value = chosen.full_name;
          pAge.value = computeAgeText(chosen.birth_date);
        }
      });

      modal({
        title: t('cert.new'),
        body: h(
          'div',
          { class: 'col' },
          h('div', { class: 'grid two' }, field(t('agenda.selectPatient'), patientSel), field(t('rx.walkInName'), pName)),
          h('div', { class: 'grid two' }, field(t('cert.kind'), kindSel), field('Âge', pAge)),
          h('div', { class: 'grid two' }, field(t('cert.restDays'), restDays), field(t('cert.startDay'), startDay)),
          field(t('cert.content'), content),
          err,
        ),
        actions: [
          { label: t('common.cancel'), kind: 'ghost' },
          {
            label: '🖨️ ' + t('common.save'),
            kind: 'primary',
            onClick: async () => {
              err.textContent = '';
              try {
                const cert = await window.API.invoke('prescriptions:certificate-create', {
                  patient_id: patientSel.value ? Number(patientSel.value) : null,
                  patient_name: pName.value.trim(),
                  patient_age: pAge.value.trim(),
                  kind: kindSel.value,
                  rest_days: Number(restDays.value) || 0,
                  start_day: startDay.value,
                  day: todayISO(),
                  content: content.value.trim(),
                });
                toast(t('common.saved'), 'ok');
                await openCertPreviewModal(cert.id);
                ctx.refresh();
                return true;
              } catch (e) {
                err.textContent = errorMessage(e);
                return false;
              }
            },
          },
        ],
      });
    };

    const certs = await window.API.invoke('prescriptions:certificates', { limit: 100 }).catch(() => []);
    host.append(
      h(
        'div',
        { class: 'row between mb' },
        h('div', {}),
        h('button', { class: 'btn primary', onClick: openCreateCertModal }, '＋ ', t('cert.new')),
      ),
      h(
        'div',
        { class: 'card' },
        certs.length === 0
          ? emptyState(t('cert.empty'), 'certificate')
          : h(
              'div',
              { class: 'table-wrap' },
              h(
                'table',
                { class: 'list' },
                h('thead', {}, h('tr', {}, h('th', {}, 'N°'), h('th', {}, t('common.date')), h('th', {}, t('common.patient')), h('th', {}, t('cert.kind')), h('th', { class: 'actions' }, ''))),
                h(
                  'tbody',
                  {},
                  certs.map((c) =>
                    h(
                      'tr',
                      {},
                      h('td', { class: 'num' }, `#${c.id}`),
                      h('td', {}, formatDate(c.day)),
                      h('td', { class: 'strong' }, c.patient_name),
                      h('td', {}, t(`cert.${c.kind}`)),
                      h(
                        'td',
                        { class: 'actions' },
                        h('button', { class: 'btn icon sm', title: t('cert.previewTitle'), onClick: () => openCertPreviewModal(c.id) }, '🖨️'),
                        h(
                          'button',
                          {
                            class: 'btn icon sm',
                            title: t('common.delete'),
                            onClick: async () => {
                              const ok = await window.UI.confirmDialog(t('cert.deleteConfirm'));
                              if (!ok) return;
                              await window.API.invoke('prescriptions:certificate-remove', { id: c.id });
                              toast(t('common.deleted'), 'ok');
                              ctx.refresh();
                            },
                          },
                          '🗑️',
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
      ),
    );
  }

  /* ======================================================================== */
  /*  Public helper to jump from Patient File / Agenda into composer          */
  /* ======================================================================== */
  window.openPrescriptionComposer = function openPrescriptionComposer(patient) {
    draft = createEmptyDraft();
    if (patient) {
      draft.patient_id = patient.id || null;
      draft.patient_name = patient.full_name || '';
      draft.patient_age = computeAgeText(patient.birth_date);
      draft.patient_allergies = patient.allergies || '';
      draft.patient_chronic = patient.chronic_conditions || '';
    }
    activeTab = 'compose';
    if (window.UI.closeModal) window.UI.closeModal();
    if (window.App) window.App.navigate('prescriptions');
  };

  window.openRxPreviewModal = openRxPreviewModal;
  window.openCertPreviewModal = openCertPreviewModal;

  Pages.prescriptions = {
    async render(root, ctx) {
      const tabs = h(
        'div',
        { class: 'tabs' },
        [
          ['compose', 'rx.tabCompose'],
          ['history', 'rx.tabHistory'],
          ['templates', 'rx.tabTemplates'],
          ['certificates', 'rx.tabCertificates'],
        ].map(([key, labelKey]) =>
          h(
            'button',
            {
              class: activeTab === key ? 'active' : '',
              onClick: () => {
                activeTab = key;
                ctx.refresh();
              },
            },
            t(labelKey),
          ),
        ),
      );

      ctx.setHeader(t('rx.title'), t('rx.subtitle'), tabs);

      const host = h('div', {});
      clear(root).append(host);

      try {
        const [patientsList, templates, medStats] = await Promise.all([
          window.API.invoke('patients:list', { limit: 800 }),
          window.API.invoke('prescriptions:templates').catch(() => []),
          window.API.invoke('prescriptions:medication-stats').catch(() => ({ total: 620 })),
        ]);
        if (activeTab === 'compose') await renderCompose(host, ctx, { patientsList, templates, medStats });
        else if (activeTab === 'history') await renderHistory(host, ctx);
        else if (activeTab === 'templates') renderTemplates(host, ctx, templates);
        else if (activeTab === 'certificates') await renderCertificates(host, ctx, patientsList);
      } catch (err) {
        clear(host).append(h('div', { class: 'card error-text' }, errorMessage(err)));
      }
    },
  };
})();
