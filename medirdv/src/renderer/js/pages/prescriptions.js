/* Prescriptions (Ordonnances médicales), Algerian Medications Catalog & Certificates. */
(function () {
  'use strict';
  const { t, formatDate } = window.I18N;
  const { h, clear, emptyState, toast, errorMessage, input, select, textarea, field, modal, todayISO } = window.UI;
  const Pages = window.Pages;

  const SPECIALTY_FILTERS = [
    ['', 'rx.specAll'],
    ['general', 'rx.specGeneral'],
    ['cardio', 'rx.specCardio'],
    ['ophtalmo', 'rx.specOphtalmo'],
    ['ortho', 'rx.specOrtho'],
    ['infectieux', 'rx.specInfectieux'],
    ['gastro', 'rx.specGastro'],
    ['endocrino', 'rx.specEndocrino'],
    ['pneumo', 'rx.specPneumo'],
    ['orl', 'rx.specOrl'],
    ['pediatrie', 'rx.specPediatrie'],
    ['dermato', 'rx.specDermato'],
    ['gyneco', 'rx.specGyneco'],
    ['neuro', 'rx.specNeuro'],
    ['uro', 'rx.specUro'],
  ];

  const EXAM_CHIPS = [
    'FNS complète',
    'Glycémie à jeun + HbA1c',
    'Bilan lipidique (CT, HDL, LDL, TG)',
    'Urée + Créatininémie',
    'Bilan hépatique (ASAT, ALAT)',
    'TSH us + FT4',
    'CRP + VS',
    'Vitamine D (25-OH)',
    'Ferritinémie',
    'ECBU + Antibiogramme',
    'ECG de repos',
    'Téléthorax F',
    'Échographie abdomino-pelvienne',
  ];

  const DURATION_CHIPS = ['3 jours', '5 jours', '7 jours', '10 jours', '15 jours', '1 mois', 'QSP 3 mois'];

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
      department_id: null,
      day: todayISO(),
      diagnosis: '',
      vitals_bp: '',
      vitals_hr: '',
      vitals_temp: '',
      vitals_spo2: '',
      vitals_glycemia: '',
      exams_requested: '',
      advice: '',
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

  function fold(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function detectClientAllergyConflicts(allergiesText, items) {
    const folded = fold(allergiesText);
    if (!folded) return [];
    const tokens = folded.split(/[,;/+·\s]+/).filter((w) => w.length >= 3);
    const penic = folded.includes('penicill') || folded.includes('بنسلين') || folded.includes('بنسيلين');
    const nsaid = folded.includes('ains') || folded.includes('aspirin') || folded.includes('اسبرين');
    const out = [];
    for (const item of items) {
      const df = fold(`${item.drug_name || ''} ${item.dci || ''}`);
      if (!df) continue;
      let hit = tokens.find((tok) => df.includes(tok));
      if (!hit && penic && (df.includes('amoxicill') || df.includes('augmentin') || df.includes('clamoxyl'))) {
        hit = 'Pénicilline';
      }
      if (!hit && nsaid && (df.includes('ibuprofen') || df.includes('ketoprofen') || df.includes('diclofenac') || df.includes('acetylsalicyl'))) {
        hit = 'AINS / Aspirine';
      }
      if (hit) out.push({ drug: item.drug_name || item.dci, allergy: hit });
    }
    return out;
  }

  function openAddCustomDrugModal(onAdded) {
    const brand = input({ placeholder: 'Ex. Paralgan, Tahor, Tobradex…', autofocus: true });
    const dci = input({ placeholder: 'Ex. Paracétamol, Atorvastatine…' });
    const strength = input({ placeholder: 'Ex. 1000 mg, 0,3%…' });
    const form = input({ value: 'Comprimé', placeholder: 'Comprimé, Sirop, Collyre…' });
    const specialty = select(SPECIALTY_FILTERS.slice(1).map(([val, key]) => ({ value: val, label: t(key) })));
    const keywordsAr = input({ placeholder: 'كلمات بحث بالعربية (اختياري)…' });
    const defaultDosage = input({ placeholder: 'Ex. 1 comprimé × 3 / jour' });
    const defaultDuration = input({ placeholder: 'Ex. 5 jours / QSP 3 mois' });
    const err = h('div', { class: 'error-text' });

    modal({
      title: t('rx.addCustomDrug'),
      body: h(
        'div',
        { class: 'col' },
        h('div', { class: 'grid two' }, field(t('rx.drugName'), brand), field(t('rx.dci'), dci)),
        h('div', { class: 'grid three' }, field(t('rx.formStrength'), form), field('Dosage', strength), field(t('dept.specialty'), specialty)),
        h('div', { class: 'grid two' }, field(t('rx.dosage'), defaultDosage), field(t('rx.duration'), defaultDuration)),
        field('العربية', keywordsAr),
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
              const med = await window.API.invoke('medications:create', {
                brand: brand.value.trim(),
                dci: dci.value.trim(),
                strength: strength.value.trim(),
                form: form.value.trim(),
                specialty: specialty.value,
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

  /* ======================================================================== */
  /*  TAB 1: Compose Prescription (Nouvelle Ordonnance / وصفة طبية جديدة)     */
  /* ======================================================================== */
  async function renderCompose(host, ctx, shared) {
    const { patientsList, depts, templates } = shared;
    const s = window.App.settings || {};

    const selectedDept = depts.find((d) => Number(d.id) === Number(draft.department_id)) || null;
    const effectiveDoctor = selectedDept?.doctor_name || s.doctor_name || '—';
    const effectiveSpecialty = selectedDept?.specialty || s.doctor_specialty || '—';

    // Header strip showing Clinic Name, Location, Doctor Name & Specialty
    const headerStrip = h(
      'div',
      { class: 'rx-header-strip' },
      h(
        'div',
        {},
        h('div', { class: 'small muted' }, t('rx.headerPreview')),
        h('div', { style: { fontWeight: '800', fontSize: '1.05rem', color: 'var(--teal-900)' } }, s.clinic_name || 'MediRDV'),
        h(
          'div',
          { class: 'small', style: { marginTop: '2px' } },
          `${effectiveDoctor} · `,
          h('strong', { style: { color: 'var(--teal-700)' } }, effectiveSpecialty),
          s.clinic_address ? ` · 📍 ${s.clinic_address}` : '',
        ),
      ),
      h(
        'button',
        { class: 'btn sm ghost', onClick: () => ctx.navigate('settings') },
        '⚙️ ' + t('rx.editHeader'),
      ),
    );

    // Patient picker + walk-in inputs
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
    const dateInput = input({ type: 'date', value: draft.day || todayISO() });

    const deptSelect = select(
      [{ value: '', label: t('dept.none') }].concat(
        depts.map((d) => ({
          value: String(d.id),
          label: `${window.App.language === 'ar' ? d.name_ar || d.name_fr : d.name_fr}${d.doctor_name ? ` — ${d.doctor_name}` : ''}`,
        })),
      ),
      { value: draft.department_id ? String(draft.department_id) : '' },
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
    ageInput.addEventListener('input', () => { draft.patient_age = ageInput.value; });
    weightInput.addEventListener('input', () => { draft.patient_weight = weightInput.value; });
    dateInput.addEventListener('change', () => { draft.day = dateInput.value; });
    deptSelect.addEventListener('change', () => {
      draft.department_id = deptSelect.value ? Number(deptSelect.value) : null;
      ctx.refresh();
    });

    // Vitals & Diagnosis
    const diagInput = input({ value: draft.diagnosis, placeholder: t('rx.diagnosis') });
    const bpInput = input({ value: draft.vitals_bp, placeholder: '120/80' });
    const hrInput = input({ value: draft.vitals_hr, placeholder: '72' });
    const tempInput = input({ value: draft.vitals_temp, placeholder: '37.0' });
    const spo2Input = input({ value: draft.vitals_spo2, placeholder: '98%' });
    const glyInput = input({ value: draft.vitals_glycemia, placeholder: '0,95' });

    diagInput.addEventListener('input', () => { draft.diagnosis = diagInput.value; });
    bpInput.addEventListener('input', () => { draft.vitals_bp = bpInput.value; });
    hrInput.addEventListener('input', () => { draft.vitals_hr = hrInput.value; });
    tempInput.addEventListener('input', () => { draft.vitals_temp = tempInput.value; });
    spo2Input.addEventListener('input', () => { draft.vitals_spo2 = spo2Input.value; });
    glyInput.addEventListener('input', () => { draft.vitals_glycemia = glyInput.value; });

    // Allergy alerts container
    const allergyAlertHost = h('div', { class: 'col', style: { gap: '8px' } });
    const refreshAllergyWarnings = () => {
      clear(allergyAlertHost);
      if (draft.patient_allergies) {
        allergyAlertHost.append(
          h('div', { class: 'allergy-alert' }, '⚠️ ', t('rx.allergyBanner', { allergies: draft.patient_allergies })),
        );
      }
      const conflicts = detectClientAllergyConflicts(draft.patient_allergies, draft.items);
      for (const c of conflicts) {
        allergyAlertHost.append(
          h('div', { class: 'allergy-alert' }, '🚫 ', t('rx.allergyConflict', { drug: c.drug, allergy: c.allergy })),
        );
      }
    };

    // Prescribed items list
    const itemsHost = h('div', { class: 'col' });
    const countTitle = h('h3', { style: { margin: '0', fontSize: '1rem' } }, t('rx.selectedDrugs', { n: draft.items.length }));

    function renderItemsList() {
      countTitle.textContent = t('rx.selectedDrugs', { n: draft.items.length });
      refreshAllergyWarnings();
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
        const qtyField = input({ value: item.quantity || '', placeholder: 'Ex. 1 boîte / QSP' });

        drugField.addEventListener('input', () => { item.drug_name = drugField.value; refreshAllergyWarnings(); });
        formField.addEventListener('input', () => { item.form_strength = formField.value; });
        dosageField.addEventListener('input', () => { item.dosage = dosageField.value; });
        timingField.addEventListener('input', () => { item.timing = timingField.value; });
        durationField.addEventListener('input', () => { item.duration = durationField.value; });
        qtyField.addEventListener('input', () => { item.quantity = qtyField.value; });

        const timingChips = [
          t('rx.timingAfterMeal'),
          t('rx.timingDuringMeal'),
          t('rx.timingFasting'),
          t('rx.timingBedtime'),
          t('rx.timingIfPain'),
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
            h('div', { class: 'grid two' }, field(t('rx.drugName'), drugField), field(t('rx.formStrength'), formField)),
            h('div', { class: 'grid three' }, field(t('rx.dosage'), dosageField), field(t('rx.timing'), timingField), field(t('rx.duration'), durationField)),
            h('div', { class: 'row wrap between', style: { gap: '8px' } }, h('div', { class: 'chip-row' }, timingChips), h('div', { class: 'chip-row' }, durationChips)),
            field(t('rx.quantity'), qtyField),
          ),
        );
      });
    }

    // Algerian Drug Search Box
    let activeSpec = '';
    const drugQuery = input({ placeholder: t('rx.searchDrug') });
    const drugResultsHost = h('div', { class: 'drug-results' });

    async function runDrugSearch() {
      try {
        const meds = await window.API.invoke('medications:search', {
          query: drugQuery.value.trim(),
          specialty: activeSpec,
          limit: 25,
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
                  });
                  renderItemsList();
                },
              },
              h(
                'div',
                {},
                h('div', { class: 'drug-brand' }, `${med.brand} ${med.strength ? `· ${med.strength}` : ''}`),
                h('div', { class: 'drug-sub' }, `${med.form}${med.dci ? ` — DCI : ${med.dci}` : ''}`),
              ),
              h('span', { class: 'btn sm soft' }, '＋ ' + t('common.add')),
            ),
          );
        }
      } catch (e) {
        clear(drugResultsHost);
      }
    }

    drugQuery.addEventListener('input', runDrugSearch);

    const specFilterBar = h(
      'div',
      { class: 'chip-row', style: { marginBottom: '8px' } },
      SPECIALTY_FILTERS.slice(0, 10).map(([specKey, labelKey]) =>
        h(
          'button',
          {
            type: 'button',
            class: `chip-btn ${activeSpec === specKey ? 'active' : ''}`,
            onClick: (ev) => {
              activeSpec = specKey;
              for (const b of ev.currentTarget.parentElement.querySelectorAll('.chip-btn')) {
                b.style.background = '';
                b.style.color = '';
              }
              ev.currentTarget.style.background = 'var(--teal-700)';
              ev.currentTarget.style.color = '#fff';
              runDrugSearch();
            },
          },
          t(labelKey),
        ),
      ),
    );

    // Templates strip
    const templateButtons = templates.map((tpl) =>
      h(
        'button',
        {
          type: 'button',
          class: 'chip-btn',
          onClick: () => {
            draft.items = (tpl.items || []).map((it) => ({ ...it }));
            if (tpl.exams_requested && !draft.exams_requested) draft.exams_requested = tpl.exams_requested;
            if (tpl.advice && !draft.advice) draft.advice = tpl.advice;
            examsArea.value = draft.exams_requested;
            adviceArea.value = draft.advice;
            renderItemsList();
          },
        },
        '📋 ' + (window.App.language === 'ar' ? tpl.title_ar || tpl.title_fr : tpl.title_fr),
      ),
    );

    // Exams & Advice
    const examsArea = textarea({ value: draft.exams_requested, placeholder: t('rx.exams') });
    const adviceArea = textarea({ value: draft.advice, placeholder: t('rx.advice') });
    examsArea.addEventListener('input', () => { draft.exams_requested = examsArea.value; });
    adviceArea.addEventListener('input', () => { draft.advice = adviceArea.value; });

    const examChips = EXAM_CHIPS.map((ex) =>
      h(
        'button',
        {
          type: 'button',
          class: 'chip-btn',
          onClick: () => {
            const cur = examsArea.value.trim();
            examsArea.value = cur ? `${cur} · ${ex}` : ex;
            draft.exams_requested = examsArea.value;
          },
        },
        '+ ' + ex,
      ),
    );

    // Save / Print handlers
    const submitPrescription = async (andPrint) => {
      try {
        const created = await window.API.invoke('prescriptions:create', {
          patient_id: draft.patient_id,
          department_id: draft.department_id,
          day: draft.day,
          patient_name: draft.patient_name.trim(),
          patient_age: draft.patient_age.trim(),
          patient_weight: draft.patient_weight.trim(),
          diagnosis: draft.diagnosis.trim(),
          vitals_bp: draft.vitals_bp.trim(),
          vitals_hr: draft.vitals_hr.trim(),
          vitals_temp: draft.vitals_temp.trim(),
          vitals_spo2: draft.vitals_spo2.trim(),
          vitals_glycemia: draft.vitals_glycemia.trim(),
          exams_requested: draft.exams_requested.trim(),
          advice: draft.advice.trim(),
          items: draft.items,
        });
        toast(t('rx.savedToast'), 'ok');
        draft = createEmptyDraft();
        if (andPrint) {
          await window.Components.printPrescription(created.id, { previewFirst: true });
        }
        ctx.refresh();
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    };

    const saveAsTemplateBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn sm ghost',
        onClick: () => {
          const titleIn = input({ placeholder: t('rx.templateTitlePrompt'), autofocus: true });
          modal({
            title: t('rx.saveAsTemplate'),
            body: field(t('rx.templateTitlePrompt'), titleIn),
            actions: [
              { label: t('common.cancel'), kind: 'ghost' },
              {
                label: t('common.save'),
                kind: 'primary',
                onClick: async () => {
                  try {
                    await window.API.invoke('prescriptions:template-create', {
                      title_fr: titleIn.value.trim(),
                      title_ar: titleIn.value.trim(),
                      items: draft.items,
                      exams_requested: draft.exams_requested,
                      advice: draft.advice,
                    });
                    toast(t('common.saved'), 'ok');
                    ctx.refresh();
                    return true;
                  } catch (e) {
                    toast(errorMessage(e), 'error');
                    return false;
                  }
                },
              },
            ],
          });
        },
      },
      '⭐ ' + t('rx.saveAsTemplate'),
    );

    renderItemsList();
    runDrugSearch();

    host.append(
      headerStrip,
      allergyAlertHost,
      h(
        'div',
        { class: 'grid rx-composer-grid', style: { gridTemplateColumns: 'minmax(0, 1.05fr) minmax(0, 1.35fr)', alignItems: 'start' } },
        // Left column: Patient, Vitals & Algerian Drug Search
        h(
          'div',
          { class: 'col' },
          h(
            'div',
            { class: 'card col' },
            h('h2', { class: 'card-title' }, t('rx.patientSection')),
            field(t('agenda.selectPatient'), patientPicker),
            depts.length > 0 ? field(t('dept.select'), deptSelect) : null,
            h('div', { class: 'grid two' }, field(t('rx.walkInName'), nameInput), field(t('common.date'), dateInput)),
            h('div', { class: 'grid two' }, field(t('rx.age'), ageInput), field(t('rx.weight'), weightInput)),
            draft.patient_chronic
              ? h('div', { class: 'badge warn' }, `${t('patients.chronic')} : ${draft.patient_chronic}`)
              : null,
            field(t('rx.diagnosis'), diagInput),
            h('div', { class: 'small strong muted' }, t('rx.vitals')),
            h(
              'div',
              { class: 'grid three' },
              field(t('rx.bp'), bpInput),
              field(t('rx.hr'), hrInput),
              field(t('rx.temp'), tempInput),
              field(t('rx.spo2'), spo2Input),
              field(t('rx.glycemia'), glyInput),
            ),
          ),
          h(
            'div',
            { class: 'card col' },
            h(
              'div',
              { class: 'row between wrap' },
              h('h2', { class: 'card-title', style: { margin: '0' } }, '💊 ' + t('rx.tabCatalog', { n: shared.medStats.total })),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn sm soft',
                  onClick: () =>
                    openAddCustomDrugModal((med) => {
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
                      });
                      renderItemsList();
                      runDrugSearch();
                    }),
                },
                '＋ ' + t('rx.addCustomDrug'),
              ),
            ),
            specFilterBar,
            drugQuery,
            drugResultsHost,
          ),
        ),
        // Right column: Templates + Prescribed Drugs + Exams/Advice + Print
        h(
          'div',
          { class: 'col' },
          h(
            'div',
            { class: 'card col' },
            h(
              'div',
              { class: 'row between wrap' },
              h('span', { class: 'small strong muted' }, t('rx.templates')),
              saveAsTemplateBtn,
            ),
            h('div', { class: 'chip-row' }, templateButtons),
          ),
          h(
            'div',
            { class: 'card col' },
            h(
              'div',
              { class: 'row between wrap' },
              countTitle,
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn sm',
                  onClick: () => {
                    draft.items.push({
                      medication_id: null,
                      drug_name: '',
                      dci: '',
                      form_strength: '',
                      dosage: '',
                      timing: '',
                      duration: '',
                      quantity: '',
                      note: '',
                    });
                    renderItemsList();
                  },
                },
                '＋ ' + t('rx.addFreeLine'),
              ),
            ),
            itemsHost,
          ),
          h(
            'div',
            { class: 'card col' },
            field(t('rx.exams'), examsArea),
            h('div', { class: 'chip-row' }, examChips),
            field(t('rx.advice'), adviceArea),
            h(
              'div',
              { class: 'row wrap', style: { justifyContent: 'flex-end', gap: '10px', marginTop: '6px' } },
              h('button', { type: 'button', class: 'btn lg', onClick: () => submitPrescription(false) }, '💾 ', t('rx.saveOnly')),
              h('button', { type: 'button', class: 'btn primary lg', onClick: () => submitPrescription(true) }, '🖨️ ', t('rx.saveAndPrint')),
            ),
          ),
        ),
      ),
    );
  }

  /* ======================================================================== */
  /*  TAB 2: Prescriptions History (Historique / سجل الوصفات)                  */
  /* ======================================================================== */
  async function renderHistory(host, ctx) {
    const searchIn = input({ placeholder: t('common.search'), style: { maxWidth: '320px' } });
    const tableWrap = h('div', { class: 'card' }, t('common.loading'));

    async function loadList() {
      const list = await window.API.invoke('prescriptions:list', { search: searchIn.value.trim(), limit: 150 });
      clear(tableWrap);
      if (list.length === 0) {
        tableWrap.append(emptyState(t('rx.emptyHistory'), 'prescription'));
        return;
      }
      tableWrap.append(
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
                h('th', {}, t('dept.doctor')),
                h('th', {}, t('rx.drugName')),
                h('th', { class: 'actions' }, t('common.actions')),
              ),
            ),
            h(
              'tbody',
              {},
              list.map((rx) =>
                h(
                  'tr',
                  {},
                  h('td', { class: 'strong' }, `#${rx.id}`),
                  h('td', {}, formatDate(rx.day)),
                  h('td', { class: 'strong' }, rx.patient_name),
                  h('td', { class: 'small muted' }, [rx.doctor_name, window.Components.departmentLabel(rx)].filter(Boolean).join(' · ') || '—'),
                  h('td', { class: 'small' }, rx.items_summary || rx.exams_requested || '—'),
                  h(
                    'td',
                    { class: 'actions' },
                    h(
                      'button',
                      {
                        class: 'btn sm primary',
                        onClick: () => window.Components.printPrescription(rx.id, { previewFirst: true }),
                      },
                      '🖨️ ' + t('common.print'),
                    ),
                    h(
                      'button',
                      {
                        class: 'btn sm soft',
                        onClick: async () => {
                          const full = await window.API.invoke('prescriptions:get', { id: rx.id });
                          draft = {
                            ...createEmptyDraft(),
                            patient_id: full.patient_id,
                            patient_name: full.patient_name,
                            patient_age: full.patient_age || '',
                            patient_weight: full.patient_weight || '',
                            patient_allergies: full.patient_allergies || '',
                            patient_chronic: full.patient_chronic_conditions || '',
                            department_id: full.department_id,
                            diagnosis: full.diagnosis || '',
                            exams_requested: full.exams_requested || '',
                            advice: full.advice || '',
                            items: (full.items || []).map((it) => ({ ...it })),
                          };
                          activeTab = 'compose';
                          toast(t('rx.renewedToast'), 'ok');
                          ctx.refresh();
                        },
                      },
                      '↻ ' + t('rx.renew'),
                    ),
                    h(
                      'button',
                      {
                        class: 'btn icon sm ghost',
                        title: t('common.delete'),
                        onClick: async () => {
                          const ok = await window.UI.confirmDialog(t('common.delete') + ' ?');
                          if (!ok) return;
                          await window.API.invoke('prescriptions:remove', { id: rx.id });
                          toast(t('common.deleted'), 'ok');
                          loadList();
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
    }

    searchIn.addEventListener('input', loadList);
    host.append(h('div', { class: 'row between mb' }, searchIn), tableWrap);
    await loadList();
  }

  /* ======================================================================== */
  /*  TAB 3: Algerian Medications Catalog (أدوية الجزائر)                       */
  /* ======================================================================== */
  async function renderCatalog(host, ctx) {
    let spec = '';
    const qInput = input({ placeholder: t('rx.searchDrug'), style: { maxWidth: '420px' } });
    const listCard = h('div', { class: 'card' }, t('common.loading'));

    async function refreshCatalog() {
      const meds = await window.API.invoke('medications:search', {
        query: qInput.value.trim(),
        specialty: spec,
        limit: 180,
      });
      clear(listCard);
      if (meds.length === 0) {
        listCard.append(emptyState(t('common.searchEmpty'), 'pill'));
        return;
      }
      listCard.append(
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
                h('th', {}, t('rx.drugName')),
                h('th', {}, t('rx.dci')),
                h('th', {}, t('rx.formStrength')),
                h('th', {}, t('rx.dosage')),
                h('th', { class: 'actions' }, ''),
              ),
            ),
            h(
              'tbody',
              {},
              meds.map((m) =>
                h(
                  'tr',
                  {},
                  h('td', { class: 'strong' }, m.brand),
                  h('td', {}, m.dci || '—'),
                  h('td', { class: 'small' }, [m.form, m.strength].filter(Boolean).join(' · ')),
                  h('td', { class: 'small muted' }, [m.default_dosage, m.default_duration].filter(Boolean).join(' — ')),
                  h(
                    'td',
                    { class: 'actions' },
                    h(
                      'button',
                      {
                        class: 'btn sm soft',
                        onClick: () => {
                          draft.items.push({
                            medication_id: m.id,
                            drug_name: m.brand,
                            dci: m.dci || '',
                            form_strength: [m.form, m.strength].filter(Boolean).join(' · '),
                            dosage: m.default_dosage || '',
                            timing: '',
                            duration: m.default_duration || '',
                            quantity: '',
                            note: '',
                          });
                          activeTab = 'compose';
                          ctx.refresh();
                        },
                      },
                      '＋ ' + t('rx.tabCompose'),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }

    qInput.addEventListener('input', refreshCatalog);
    const specBar = h(
      'div',
      { class: 'dept-tabs' },
      SPECIALTY_FILTERS.map(([val, key]) =>
        h(
          'button',
          {
            type: 'button',
            class: `dept-tab ${spec === val ? 'active' : ''}`,
            onClick: (ev) => {
              spec = val;
              for (const b of ev.currentTarget.parentElement.querySelectorAll('.dept-tab')) b.classList.remove('active');
              ev.currentTarget.classList.add('active');
              refreshCatalog();
            },
          },
          t(key),
        ),
      ),
    );

    host.append(
      h(
        'div',
        { class: 'row between wrap mb' },
        qInput,
        h('button', { class: 'btn primary', onClick: () => openAddCustomDrugModal(() => refreshCatalog()) }, '＋ ', t('rx.addCustomDrug')),
      ),
      specBar,
      listCard,
    );
    await refreshCatalog();
  }

  /* ======================================================================== */
  /*  TAB 4: Medical Certificates (الشهادات الطبية والعطل المرضية)             */
  /* ======================================================================== */
  async function renderCertificates(host, ctx, shared) {
    const patientPicker = select(
      [{ value: '', label: t('agenda.choosePatient') }].concat(
        shared.patientsList.map((p) => ({ value: String(p.id), label: p.full_name })),
      ),
    );
    const nameIn = input({ placeholder: t('rx.walkInName') });
    const ageIn = input({ placeholder: t('rx.agePlaceholder') });
    const kindSel = select([
      { value: 'arret_travail', label: t('rx.certArret') },
      { value: 'aptitude', label: t('rx.certAptitude') },
      { value: 'scolaire', label: t('rx.certScolaire') },
      { value: 'general', label: t('rx.certGeneral') },
    ]);
    const restIn = input({ type: 'number', min: '0', max: '365', value: '3' });
    const startIn = input({ type: 'date', value: todayISO() });
    const contentIn = textarea({ placeholder: t('rx.certContent') });

    patientPicker.addEventListener('change', () => {
      const p = shared.patientsList.find((item) => String(item.id) === patientPicker.value);
      if (p) {
        nameIn.value = p.full_name;
        ageIn.value = computeAgeText(p.birth_date);
      }
    });

    const certs = await window.API.invoke('certificates:list', { limit: 60 }).catch(() => []);

    host.append(
      h(
        'div',
        { class: 'grid two', style: { alignItems: 'start' } },
        h(
          'div',
          { class: 'card col' },
          h('h2', { class: 'card-title' }, t('rx.certNew')),
          field(t('agenda.selectPatient'), patientPicker),
          h('div', { class: 'grid two' }, field(t('rx.walkInName'), nameIn), field(t('rx.age'), ageIn)),
          field(t('rx.certKind'), kindSel),
          h('div', { class: 'grid two' }, field(t('rx.certRestDays'), restIn), field(t('rx.certStartDay'), startIn)),
          field(t('rx.certContent'), contentIn),
          h(
            'button',
            {
              type: 'button',
              class: 'btn primary lg',
              onClick: async () => {
                try {
                  const cert = await window.API.invoke('certificates:create', {
                    patient_id: patientPicker.value ? Number(patientPicker.value) : null,
                    patient_name: nameIn.value.trim(),
                    patient_age: ageIn.value.trim(),
                    kind: kindSel.value,
                    rest_days: Number(restIn.value) || 0,
                    start_day: startIn.value,
                    content: contentIn.value.trim(),
                  });
                  toast(t('common.saved'), 'ok');
                  await window.Components.printCertificate(cert.id, { previewFirst: true });
                  ctx.refresh();
                } catch (e) {
                  toast(errorMessage(e), 'error');
                }
              },
            },
            '🖨️ ',
            t('rx.certSavePrint'),
          ),
        ),
        h(
          'div',
          { class: 'card col' },
          h('h2', { class: 'card-title' }, t('patients.certificates')),
          certs.length === 0
            ? emptyState(t('rx.certEmpty'), 'certificate')
            : h(
                'div',
                { class: 'col' },
                certs.map((c) =>
                  h(
                    'div',
                    { class: 'row between', style: { padding: '8px 0', borderBottom: '1px solid var(--line)' } },
                    h(
                      'div',
                      {},
                      h('div', { class: 'strong' }, c.patient_name),
                      h('div', { class: 'small muted' }, `${formatDate(c.day)} · ${c.kind === 'arret_travail' ? `${c.rest_days} j` : c.kind}`),
                    ),
                    h(
                      'button',
                      {
                        class: 'btn sm primary',
                        onClick: () => window.Components.printCertificate(c.id, { previewFirst: true }),
                      },
                      '🖨️ ' + t('common.print'),
                    ),
                  ),
                ),
              ),
        ),
      ),
    );
  }

  /* ======================================================================== */
  /*  Public entry & deep-link helper from Patient File / Agenda              */
  /* ======================================================================== */
  window.openPrescriptionComposer = function openPrescriptionComposer(prefill = {}) {
    draft = {
      ...createEmptyDraft(),
      patient_id: prefill.patient?.id || prefill.patient_id || null,
      patient_name: prefill.patient?.full_name || prefill.patient_name || '',
      patient_age: prefill.patient_age || computeAgeText(prefill.patient?.birth_date),
      patient_weight: prefill.patient_weight || '',
      patient_allergies: prefill.patient?.allergies || prefill.patient_allergies || '',
      patient_chronic: prefill.patient?.chronic_conditions || prefill.patient_chronic || '',
      department_id: prefill.department_id || null,
      diagnosis: prefill.diagnosis || '',
      exams_requested: prefill.exams_requested || '',
      advice: prefill.advice || '',
      items: Array.isArray(prefill.items) ? prefill.items.map((it) => ({ ...it })) : [],
    };
    activeTab = 'compose';
    if (window.App?.navigate) window.App.navigate('prescriptions');
  };

  Pages.prescriptions = {
    async render(root, ctx) {
      ctx.setHeader(t('rx.title'), t('rx.subtitle'));
      root.append(h('div', { class: 'empty' }, t('common.loading')));

      const [patientsList, depts, templates, medStats, historyPreview] = await Promise.all([
        window.API.invoke('patients:list', { limit: 800 }).catch(() => []),
        window.API.invoke('departments:list').catch(() => []),
        window.API.invoke('prescriptions:templates').catch(() => []),
        window.API.invoke('medications:stats').catch(() => ({ total: 0 })),
        window.API.invoke('prescriptions:list', { limit: 200 }).catch(() => []),
      ]);
      if (!root.isConnected) return;

      const tabs = [
        ['compose', 'prescription', t('rx.tabCompose')],
        ['history', 'clock', t('rx.tabHistory', { n: historyPreview.length })],
        ['catalog', 'pill', t('rx.tabCatalog', { n: medStats.total })],
        ['certificates', 'certificate', t('rx.tabCertificates')],
      ];

      const tabBar = h(
        'div',
        { class: 'dept-tabs' },
        tabs.map(([id, icon, label]) =>
          h(
            'button',
            {
              type: 'button',
              class: `dept-tab ${activeTab === id ? 'active' : ''}`,
              onClick: () => {
                activeTab = id;
                ctx.refresh();
              },
            },
            window.Icons ? window.Icons.el(icon, { size: 16 }) : '',
            ' ',
            label,
          ),
        ),
      );

      const bodyHost = h('div', { class: 'col' });
      clear(root).append(tabBar, bodyHost);

      const shared = { patientsList, depts, templates, medStats };
      if (activeTab === 'history') await renderHistory(bodyHost, ctx);
      else if (activeTab === 'catalog') await renderCatalog(bodyHost, ctx);
      else if (activeTab === 'certificates') await renderCertificates(bodyHost, ctx, shared);
      else await renderCompose(bodyHost, ctx, shared);
    },
  };
})();
