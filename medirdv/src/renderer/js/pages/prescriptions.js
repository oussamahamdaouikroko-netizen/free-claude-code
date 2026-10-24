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
      diagnoses: [],
      vitals_bp: '',
      vitals_hr: '',
      vitals_temp: '',
      vitals_spo2: '',
      vitals_glycemia: '',
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

    // Vitals & Structured ICD-10 Multi-Select + Free-Text Diagnosis
    if (!Array.isArray(draft.diagnoses)) draft.diagnoses = [];
    const diagInput = input({ value: draft.diagnosis, placeholder: t('icd.freeTextPlaceholder') });
    const icdSearchInput = input({ placeholder: t('icd.searchPlaceholder') });
    const icdDropdown = h('div', { class: 'col', style: { gap: '4px', marginTop: '4px' } });
    const icdChipsHost = h('div', { class: 'row wrap', style: { gap: '6px', marginTop: '6px' } });
    const icdAlertsHost = h('div', { class: 'col', style: { gap: '6px', marginTop: '6px' } });

    function renderSelectedDiagnoses() {
      clear(icdChipsHost);
      clear(icdAlertsHost);
      const isAr = window.App.language === 'ar';
      for (const [idx, d] of draft.diagnoses.entries()) {
        const lbl = isAr ? d.label_ar || d.label_fr : d.label_fr;
        icdChipsHost.append(
          h(
            'span',
            {
              class: `badge ${d.is_notifiable ? 'danger' : d.is_chronic_ald ? 'ok' : 'info'}`,
              style: { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 8px' },
            },
            h('strong', {}, d.icd10_code),
            h('span', {}, lbl),
            d.is_chronic_ald ? h('span', { class: 'small strong' }, `· ${t('icd.aldBadge')}`) : null,
            d.is_notifiable ? h('span', { class: 'small strong' }, `· ${t('icd.notifiableBadge')}`) : null,
            h(
              'button',
              {
                type: 'button',
                style: { border: 'none', background: 'transparent', cursor: 'pointer', fontWeight: '700', padding: '0 2px' },
                onClick: () => {
                  draft.diagnoses.splice(idx, 1);
                  renderSelectedDiagnoses();
                },
              },
              '×',
            ),
          ),
        );
      }

      if (draft.diagnoses.some((d) => d.is_notifiable)) {
        icdAlertsHost.append(
          h(
            'div',
            {
              class: 'small strong',
              style: {
                padding: '8px 10px',
                borderRadius: '8px',
                background: '#fef2f2',
                border: '1px solid #dc2626',
                color: '#991b1b',
              },
            },
            '🚨 ',
            t('icd.notifiableAlert'),
          ),
        );
      }
      if (draft.diagnoses.some((d) => d.is_chronic_ald)) {
        icdAlertsHost.append(
          h(
            'div',
            {
              class: 'small',
              style: {
                padding: '6px 10px',
                borderRadius: '8px',
                background: '#ecfdf5',
                border: '1px solid #059669',
                color: '#065f46',
              },
            },
            '✓ ',
            t('icd.aldInfo'),
          ),
        );
      }

      const selectedCodes = new Set(draft.diagnoses.map((d) => String(d.icd10_code || '').toUpperCase()).filter(Boolean));
      const matchedProtocols = templates.filter((tpl) => selectedCodes.has(String(tpl.icd10_code || '').toUpperCase()));
      if (matchedProtocols.length > 0) {
        icdAlertsHost.append(
          h(
            'div',
            { class: 'col', style: { gap: '4px', padding: '8px', borderRadius: '8px', background: 'var(--bg-soft, #f8fafc)', border: '1px solid var(--line)' } },
            h('div', { class: 'small strong' }, '📋 ', t('icd.suggestedProtocols')),
            h(
              'div',
              { class: 'row wrap', style: { gap: '6px' } },
              matchedProtocols.map((tpl) =>
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn sm soft',
                    title: tpl.verified ? t('icd.verifiedProtocol') : t('icd.unverifiedProtocol'),
                    onClick: () => {
                      draft.items = (tpl.items || []).map((it) => ({ ...it }));
                      if (tpl.exams_requested && !draft.exams_requested) draft.exams_requested = tpl.exams_requested;
                      if (tpl.advice && !draft.advice) draft.advice = tpl.advice;
                      examsArea.value = draft.exams_requested;
                      adviceArea.value = draft.advice;
                      renderItemsList();
                    },
                  },
                  `${window.App.language === 'ar' ? tpl.title_ar || tpl.title_fr : tpl.title_fr}${tpl.verified ? ' ✓' : ' ⚠'}`,
                ),
              ),
            ),
            matchedProtocols.some((tpl) => !tpl.verified)
              ? h('div', { class: 'muted small' }, '⚠ ', t('icd.unverifiedProtocol'))
              : null,
          ),
        );
      }
    }

    let icdTimer = null;
    icdSearchInput.addEventListener('input', () => {
      clearTimeout(icdTimer);
      const q = icdSearchInput.value.trim();
      if (!q) {
        clear(icdDropdown);
        return;
      }
      icdTimer = setTimeout(async () => {
        const rows = await window.API.invoke('icd10:search', { query: q, limit: 8 }).catch(() => []);
        clear(icdDropdown);
        const isAr = window.App.language === 'ar';
        for (const row of rows) {
          icdDropdown.append(
            h(
              'button',
              {
                type: 'button',
                class: 'row between wrap',
                style: {
                  textAlign: 'start',
                  padding: '6px 10px',
                  borderRadius: '8px',
                  border: '1px solid var(--line)',
                  background: '#fff',
                  cursor: 'pointer',
                  gap: '6px',
                },
                onClick: () => {
                  if (!draft.diagnoses.some((d) => d.icd10_code === row.code)) {
                    draft.diagnoses.push({
                      icd10_id: row.id,
                      icd10_code: row.code,
                      label_fr: row.label_fr,
                      label_ar: row.label_ar,
                      is_chronic_ald: row.is_chronic_ald,
                      is_notifiable: row.is_notifiable,
                    });
                  }
                  icdSearchInput.value = '';
                  clear(icdDropdown);
                  renderSelectedDiagnoses();
                },
              },
              h('span', {}, h('strong', {}, `[${row.code}] `), isAr ? row.label_ar || row.label_fr : row.label_fr),
              h(
                'span',
                { class: 'row', style: { gap: '4px' } },
                row.is_chronic_ald ? h('span', { class: 'badge ok' }, t('icd.aldBadge')) : null,
                row.is_notifiable ? h('span', { class: 'badge danger' }, t('icd.notifiableBadge')) : null,
              ),
            ),
          );
        }
      }, 100);
    });

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

    // Pre-visit intake banner (never auto-copies unverified intake without explicit doctor click)
    const intakeBannerHost = h('div', {});
    if (draft.patient_id) {
      window.API.invoke('intake:latest', { patient_id: draft.patient_id })
        .then((latestIntake) => {
          if (!latestIntake || !intakeBannerHost.isConnected) return;
          const parts = [];
          if (latestIntake.weight_kg) parts.push(`${latestIntake.weight_kg} kg`);
          if (latestIntake.known_allergies) parts.push(`⚠ ${latestIntake.known_allergies}`);
          if (latestIntake.is_pregnant === 1) parts.push(t('intake.alertPregnancy'));
          if (latestIntake.current_medications) parts.push(latestIntake.current_medications);
          const summary = parts.join(' · ') || latestIntake.chief_complaint || '—';
          const isPending = latestIntake.status !== 'applied';

          const applyToDraft = (prefill, updatedPatient) => {
            if (prefill.patient_weight) draft.patient_weight = prefill.patient_weight;
            if (updatedPatient?.allergies) draft.patient_allergies = updatedPatient.allergies;
            if (updatedPatient?.chronic_conditions) draft.patient_chronic = updatedPatient.chronic_conditions;
            if (prefill.vitals_bp && !draft.vitals_bp) draft.vitals_bp = prefill.vitals_bp;
            if (prefill.vitals_glycemia && !draft.vitals_glycemia) draft.vitals_glycemia = prefill.vitals_glycemia;
            if (prefill.chief_complaint && !draft.diagnosis) draft.diagnosis = prefill.chief_complaint;
            ctx.refresh();
          };

          intakeBannerHost.replaceChildren(
            h(
              'div',
              {
                class: 'card row wrap between',
                style: {
                  padding: '10px 14px',
                  border: isPending ? '1.5px solid var(--warn, #d97706)' : '1px solid var(--teal-700)',
                  background: isPending ? 'rgba(245, 158, 11, 0.08)' : 'rgba(13, 148, 136, 0.06)',
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
                        const res = await window.API.invoke('intake:confirm', {
                          id: latestIntake.id,
                          reviewed_by: window.App?.settings?.doctor_name || 'doctor',
                        });
                        toast(t('intake.appliedToast'), 'ok');
                        applyToDraft(res.prescription_prefill || {}, res.patient);
                      } else {
                        applyToDraft(
                          {
                            patient_weight: latestIntake.weight_kg ? `${latestIntake.weight_kg} kg` : '',
                            vitals_bp: latestIntake.last_blood_pressure || '',
                            vitals_glycemia: latestIntake.last_glycemia || '',
                            chief_complaint: latestIntake.chief_complaint || '',
                          },
                          null,
                        );
                      }
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

    // Clinical safety & allergy alerts container (Phase 2 decision-support engine)
    let latestSafetyEval = { alerts: [], blocking: false, requires_override: false, has_unverified_rules: false };
    const allergyAlertHost = h('div', { class: 'col', style: { gap: '8px' } });

    const severityLabel = (sev) => {
      if (sev === 'contraindicated') return t('safety.sevContraindicated');
      if (sev === 'avoid') return t('safety.sevAvoid');
      if (sev === 'caution') return t('safety.sevCaution');
      return t('safety.sevMonitor');
    };

    const refreshAllergyWarnings = async () => {
      clear(allergyAlertHost);
      if (draft.patient_allergies) {
        allergyAlertHost.append(
          h('div', { class: 'allergy-alert' }, '⚠️ ', t('rx.allergyBanner', { allergies: draft.patient_allergies })),
        );
      }
      if (draft.items.length === 0) {
        latestSafetyEval = { alerts: [], blocking: false, requires_override: false, has_unverified_rules: false };
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
        if (!allergyAlertHost.isConnected) return;
        const isAr = window.App?.language === 'ar';
        if (res.alerts.length > 0) {
          allergyAlertHost.append(
            h(
              'div',
              { class: 'small muted', style: { padding: '4px 8px' } },
              window.Icons ? window.Icons.el('shield', { size: 14 }) : '',
              ' ',
              t('safety.disclaimerBanner'),
            ),
          );
        }
        for (const a of res.alerts) {
          const isSevere = a.severity === 'contraindicated' || a.severity === 'avoid';
          allergyAlertHost.append(
            h(
              'div',
              {
                class: isSevere ? 'allergy-alert' : 'card row wrap between',
                style: isSevere
                  ? { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }
                  : { padding: '8px 12px', border: '1px solid var(--warn, #d97706)', gap: '8px' },
              },
              h(
                'div',
                { class: 'row wrap', style: { gap: '8px' } },
                h('span', { class: `badge ${isSevere ? 'danger' : 'warn'}` }, severityLabel(a.severity)),
                h('span', {}, isAr ? a.message_ar || a.message_fr : a.message_fr),
              ),
              !a.verified
                ? h('span', { class: 'badge warn' }, t('safety.unverifiedRuleTag'))
                : null,
            ),
          );
        }
      } catch (_err) {
        const conflicts = detectClientAllergyConflicts(draft.patient_allergies, draft.items);
        for (const c of conflicts) {
          allergyAlertHost.append(
            h('div', { class: 'allergy-alert' }, '🚫 ', t('rx.allergyConflict', { drug: c.drug, allergy: c.allergy })),
          );
        }
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
        durationField.addEventListener('input', () => { item.duration = durationField.value; refreshAllergyWarnings(); });
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
                      style: { padding: '8px 12px', marginTop: '6px', background: 'rgba(13, 148, 136, 0.06)', gap: '8px' },
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

        const subBtn = h(
          'button',
          {
            type: 'button',
            class: 'btn sm ghost',
            onClick: async () => {
              try {
                const { substitutes = [] } = await window.API.invoke('medications:substitutes', {
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
                                h(
                                  'div',
                                  { class: 'muted small' },
                                  [
                                    med.form,
                                    med.laboratory,
                                    med.ppa ? t('nom.ppaLabel', { v: med.ppa }) : '',
                                    med.reference_price ? t('nom.refPriceLabel', { v: med.reference_price }) : '',
                                  ]
                                    .filter(Boolean)
                                    .join(' · '),
                                ),
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
              h('div', { class: 'row wrap', style: { gap: '6px' } }, subBtn, calcBtn,
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
                  `${med.brand} ${med.strength ? `· ${med.strength}` : ''}`,
                  med.is_generic ? ` [${t('nom.genericBadge')}]` : '',
                  med.reimbursable ? ` [CNAS ${med.reimbursement_rate || 80}%]` : '',
                ),
                h(
                  'div',
                  { class: 'drug-sub' },
                  [
                    `${med.form}${med.dci ? ` — DCI : ${med.dci}` : ''}`,
                    med.laboratory || '',
                    med.ppa ? t('nom.ppaLabel', { v: med.ppa }) : '',
                  ]
                    .filter(Boolean)
                    .join(' · '),
                ),
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

    // Save / Print handlers (with Phase 2 blocking override modal for contraindicated/avoid alerts)
    const executeSavePrescription = async (andPrint, overrideReason = '') => {
      const created = await window.API.invoke('prescriptions:create', {
        patient_id: draft.patient_id,
        department_id: draft.department_id,
        day: draft.day,
        patient_name: draft.patient_name.trim(),
        patient_age: draft.patient_age.trim(),
        patient_weight: draft.patient_weight.trim(),
        patient_allergies: draft.patient_allergies,
        patient_chronic: draft.patient_chronic,
        diagnosis: draft.diagnosis.trim(),
        diagnoses: draft.diagnoses || [],
        vitals_bp: draft.vitals_bp.trim(),
        vitals_hr: draft.vitals_hr.trim(),
        vitals_temp: draft.vitals_temp.trim(),
        vitals_spo2: draft.vitals_spo2.trim(),
        vitals_glycemia: draft.vitals_glycemia.trim(),
        exams_requested: draft.exams_requested.trim(),
        advice: draft.advice.trim(),
        print_mode: draft.print_mode || 'both',
        items: draft.items,
        safety_override_reason: overrideReason,
      });
      toast(t('rx.savedToast'), 'ok');
      draft = createEmptyDraft();
      if (andPrint) {
        await window.Components.printPrescription(created.id, { previewFirst: true });
      }
      ctx.refresh();
    };

    const submitPrescription = async (andPrint) => {
      try {
        const evalRes =
          draft.items.length > 0
            ? await window.API.invoke('safety:evaluate', {
                patient_id: draft.patient_id,
                patient_weight: draft.patient_weight,
                patient_age: draft.patient_age,
                patient_allergies: draft.patient_allergies,
                patient_chronic: draft.patient_chronic,
                items: draft.items,
              })
            : { alerts: [], blocking: false, requires_override: false };

        if (evalRes.blocking || evalRes.requires_override) {
          const isAr = window.App?.language === 'ar';
          const reasonIn = textarea({ placeholder: t('safety.overridePrompt'), autofocus: true });
          const errNode = h('div', { class: 'error-text' });
          const majorAlerts = evalRes.alerts.filter(
            (a) => a.severity === 'contraindicated' || a.severity === 'avoid',
          );
          modal({
            title: t('safety.overrideModalTitle'),
            wide: true,
            body: h(
              'div',
              { class: 'col' },
              h('div', { class: 'small muted' }, t('safety.disclaimerBanner')),
              h(
                'div',
                { class: 'col', style: { gap: '6px' } },
                majorAlerts.map((a) =>
                  h(
                    'div',
                    { class: 'allergy-alert' },
                    `[${severityLabel(a.severity)}] `,
                    isAr ? a.message_ar || a.message_fr : a.message_fr,
                  ),
                ),
              ),
              field(t('safety.overridePrompt'), reasonIn),
              errNode,
            ),
            actions: [
              { label: t('common.cancel'), kind: 'ghost' },
              {
                label: t('safety.overrideConfirmBtn'),
                kind: 'primary',
                onClick: async () => {
                  const reason = reasonIn.value.trim();
                  if (reason.length < 5) {
                    errNode.textContent = t('safety.overrideReasonRequired');
                    return false;
                  }
                  try {
                    await executeSavePrescription(andPrint, reason);
                    return true;
                  } catch (e) {
                    errNode.textContent = errorMessage(e);
                    return false;
                  }
                },
              },
            ],
          });
          return;
        }

        await executeSavePrescription(andPrint, '');
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

    const printModeSelect = select(
      [
        { value: 'both', label: t('nom.printBoth') },
        { value: 'dci', label: t('nom.printDci') },
        { value: 'brand', label: t('nom.printBrand') },
      ],
      { value: draft.print_mode || 'both' },
    );
    printModeSelect.addEventListener('change', () => {
      draft.print_mode = printModeSelect.value;
    });

    renderSelectedDiagnoses();
    renderItemsList();
    runDrugSearch();

    host.append(
      headerStrip,
      intakeBannerHost,
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
            field(t('icd.searchLabel'), h('div', {}, icdSearchInput, icdDropdown, icdChipsHost, icdAlertsHost)),
            field(t('rx.diagnosis'), diagInput),
            field(t('nom.printModeLabel'), printModeSelect),
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
  /*  TAB 5: Clinical Safety Rules & CSV/JSON Importer                        */
  /* ======================================================================== */
  async function renderSafetyRules(host, ctx) {
    const TABLE_OPTIONS = [
      { value: 'dose_rules', label: 'dose_rules (mg/kg)' },
      { value: 'interaction_pairs', label: 'interaction_pairs' },
      { value: 'contraindications', label: 'contraindications' },
      { value: 'allergy_class_rules', label: 'allergy_class_rules' },
      { value: 'controlled_rules', label: 'controlled_rules' },
    ];
    let selectedTable = 'dose_rules';
    const tableSel = select(TABLE_OPTIONS, { value: selectedTable });
    const formatSel = select([
      { value: 'json', label: 'JSON' },
      { value: 'csv', label: 'CSV' },
    ]);
    const verifiedChk = h('input', { type: 'checkbox' });
    const contentArea = textarea({ placeholder: '[{"dci":"paracetamol", ...}]' });
    const fileInput = h('input', { type: 'file', accept: '.csv,.json,.txt', style: { display: 'none' } });
    const rulesHost = h('div', { class: 'col' });

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (file.name.toLowerCase().endsWith('.csv')) formatSel.value = 'csv';
      else formatSel.value = 'json';
      contentArea.value = await file.text();
    });

    async function loadRules() {
      const rows = await window.API.invoke('safety:rules-list', { table: selectedTable, limit: 150 }).catch(() => []);
      clear(rulesHost);
      const isAr = window.App?.language === 'ar';
      for (const r of rows) {
        const title = r.dci
          ? `${r.dci}${r.condition_type ? ` · ${r.condition_type}` : ''}${r.mg_per_kg_per_day ? ` · ${r.mg_per_kg_per_day} mg/kg/j` : ''}`
          : r.dci_a
            ? `${r.dci_a} × ${r.dci_b} (${r.severity})`
            : r.class_name_fr || r.class_code;
        const desc = isAr
          ? r.notes_ar || r.mechanism_ar || r.message_ar || r.class_name_ar || r.notes_fr || ''
          : r.notes_fr || r.mechanism_fr || r.message_fr || r.trigger_terms || '';
        rulesHost.append(
          h(
            'div',
            { class: 'row wrap between', style: { padding: '8px 0', borderBottom: '1px solid var(--line)', gap: '8px' } },
            h(
              'div',
              { class: 'col', style: { gap: '2px' } },
              h(
                'div',
                { class: 'row wrap', style: { gap: '6px' } },
                h('strong', {}, title),
                h('span', { class: `badge ${r.verified ? 'ok' : 'warn'}` }, t(r.verified ? 'safety.verifiedRuleTag' : 'safety.unverifiedRuleTag')),
                h('span', { class: 'muted small' }, r.source || 'starter'),
              ),
              desc ? h('div', { class: 'small muted' }, desc) : null,
            ),
            h(
              'button',
              {
                type: 'button',
                class: `btn sm ${r.verified ? 'ghost' : 'soft'}`,
                onClick: async () => {
                  try {
                    await window.API.invoke('safety:rule-verify', {
                      table: selectedTable,
                      id: r.id,
                      verified: !r.verified,
                    });
                    await loadRules();
                  } catch (e) {
                    toast(errorMessage(e), 'error');
                  }
                },
              },
              t(r.verified ? 'safety.unverifyBtn' : 'safety.verifyBtn'),
            ),
          ),
        );
      }
    }

    tableSel.addEventListener('change', () => {
      selectedTable = tableSel.value;
      loadRules();
    });

    host.append(
      h('div', { class: 'card small', style: { border: '1px solid var(--warn, #d97706)' } }, '⚠️ ', t('safety.disclaimerBanner')),
      h(
        'div',
        { class: 'grid two', style: { alignItems: 'start' } },
        h(
          'div',
          { class: 'card col' },
          h('h2', { class: 'card-title' }, t('safety.importTitle')),
          h('div', { class: 'grid two' }, field(t('safety.tableSelect'), tableSel), field(t('safety.formatSelect'), formatSel)),
          h(
            'div',
            { class: 'row wrap between' },
            h('label', { class: 'row', style: { gap: '8px', cursor: 'pointer' } }, verifiedChk, h('span', { class: 'small' }, t('safety.markVerified'))),
            h('button', { type: 'button', class: 'btn sm soft', onClick: () => fileInput.click() }, fileInput, t('safety.chooseFile')),
          ),
          field(t('safety.pasteData'), contentArea),
          h(
            'button',
            {
              type: 'button',
              class: 'btn primary',
              onClick: async () => {
                try {
                  const res = await window.API.invoke('safety:rules-import', {
                    table: tableSel.value,
                    format: formatSel.value,
                    content: contentArea.value,
                    mark_verified: verifiedChk.checked,
                  });
                  toast(t('safety.importedToast', { n: res.imported }), 'ok');
                  contentArea.value = '';
                  await loadRules();
                } catch (e) {
                  toast(errorMessage(e), 'error');
                }
              },
            },
            t('safety.importBtn'),
          ),
        ),
        h('div', { class: 'card col' }, rulesHost),
      ),
    );

    await loadRules();
  }

  /* ======================================================================== */
  /*  TAB 6: ICD-10 (CIM-10) & Editable Clinical Protocols                    */
  /* ======================================================================== */
  async function renderProtocols(host, ctx, shared) {
    const [summary, icdList] = await Promise.all([
      window.API.invoke('icd10:summary').catch(() => ({ total: 0, ald_count: 0, notifiable_count: 0 })),
      window.API.invoke('icd10:search', { query: '', limit: 60 }).catch(() => []),
    ]);

    const icdFileIn = h('input', { type: 'file', accept: '.csv,.tsv,.json', style: { display: 'none' } });
    icdFileIn.addEventListener('change', async () => {
      const f = icdFileIn.files?.[0];
      if (!f) return;
      try {
        const text = await f.text();
        const fmt = f.name.toLowerCase().endsWith('.json') ? 'json' : 'csv';
        const res = await window.API.invoke('icd10:import', { format: fmt, content: text });
        toast(t('icd.importedToast', { inserted: res.inserted, updated: res.updated }), 'ok');
        ctx.refresh();
      } catch (e) {
        toast(errorMessage(e), 'error');
      } finally {
        icdFileIn.value = '';
      }
    });

    const isAr = window.App.language === 'ar';

    host.append(
      h(
        'div',
        { class: 'card row between wrap', style: { gap: '10px' } },
        h(
          'div',
          { class: 'col', style: { gap: '2px' } },
          h('strong', {}, t('icd.protocolsTitle')),
          h(
            'span',
            { class: 'muted small' },
            t('icd.summaryLine', {
              total: summary.total || 0,
              ald: summary.ald_count || 0,
              mdo: summary.notifiable_count || 0,
            }),
          ),
        ),
        h(
          'button',
          { type: 'button', class: 'btn primary', onClick: () => icdFileIn.click() },
          icdFileIn,
          '📥 ',
          t('icd.importBtn'),
        ),
      ),
      h(
        'div',
        { class: 'grid two', style: { alignItems: 'start' } },
        h(
          'div',
          { class: 'card col' },
          h('h2', { class: 'card-title' }, t('rx.templates')),
          shared.templates.map((tpl) =>
            h(
              'div',
              {
                class: 'col',
                style: { padding: '10px', border: '1px solid var(--line)', borderRadius: '10px', gap: '6px' },
              },
              h(
                'div',
                { class: 'row between wrap', style: { gap: '6px' } },
                h(
                  'div',
                  { class: 'row wrap', style: { gap: '6px' } },
                  h('strong', {}, isAr ? tpl.title_ar || tpl.title_fr : tpl.title_fr),
                  tpl.icd10_code ? h('span', { class: 'badge info' }, tpl.icd10_code) : null,
                  h(
                    'span',
                    { class: `badge ${tpl.verified ? 'ok' : 'warn'}` },
                    t(tpl.verified ? 'icd.verifiedProtocol' : 'icd.unverifiedProtocol'),
                  ),
                ),
                h(
                  'div',
                  { class: 'row', style: { gap: '6px' } },
                  !tpl.verified
                    ? h(
                        'button',
                        {
                          type: 'button',
                          class: 'btn sm soft',
                          onClick: async () => {
                            await window.API.invoke('prescriptions:template-update', { id: tpl.id, verified: 1 });
                            toast(t('common.saved'), 'ok');
                            ctx.refresh();
                          },
                        },
                        '✓ ',
                        t('icd.verifyBtn'),
                      )
                    : null,
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'btn sm ghost',
                      onClick: () => {
                        const titleFrIn = input({ value: tpl.title_fr });
                        const titleArIn = input({ value: tpl.title_ar || '' });
                        const icdIn = input({ value: tpl.icd10_code || '', placeholder: 'I10 / J02.9…' });
                        const examsIn = textarea({ value: tpl.exams_requested || '' });
                        const adviceIn = textarea({ value: tpl.advice || '' });
                        modal({
                          title: t('icd.editProtocolBtn'),
                          body: h(
                            'div',
                            { class: 'col' },
                            field(t('common.french'), titleFrIn),
                            field(t('common.arabic'), titleArIn),
                            field(t('icd.codeLabel'), icdIn),
                            field(t('rx.exams'), examsIn),
                            field(t('rx.advice'), adviceIn),
                          ),
                          actions: [
                            { label: t('common.cancel'), class: 'btn' },
                            {
                              label: t('common.save'),
                              class: 'btn primary',
                              onClick: async () => {
                                await window.API.invoke('prescriptions:template-update', {
                                  id: tpl.id,
                                  title_fr: titleFrIn.value,
                                  title_ar: titleArIn.value,
                                  icd10_code: icdIn.value,
                                  exams_requested: examsIn.value,
                                  advice: adviceIn.value,
                                  verified: 1,
                                });
                                toast(t('common.saved'), 'ok');
                                ctx.refresh();
                              },
                            },
                          ],
                        });
                      },
                    },
                    '✎ ',
                    t('icd.editProtocolBtn'),
                  ),
                ),
              ),
              h('div', { class: 'muted small' }, (tpl.items || []).map((it) => it.drug_name).join(' · ')),
            ),
          ),
        ),
        h(
          'div',
          { class: 'card col', style: { maxHeight: '520px', overflowY: 'auto' } },
          h('h2', { class: 'card-title' }, t('icd.searchLabel')),
          icdList.map((row) =>
            h(
              'div',
              { class: 'row between wrap', style: { padding: '6px 0', borderBottom: '1px solid var(--line)', gap: '6px' } },
              h('span', {}, h('strong', {}, `[${row.code}] `), isAr ? row.label_ar || row.label_fr : row.label_fr),
              h(
                'span',
                { class: 'row', style: { gap: '4px' } },
                row.is_chronic_ald ? h('span', { class: 'badge ok' }, t('icd.aldBadge')) : null,
                row.is_notifiable ? h('span', { class: 'badge danger' }, t('icd.notifiableBadge')) : null,
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
      vitals_bp: prefill.vitals_bp || '',
      vitals_glycemia: prefill.vitals_glycemia || '',
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

      const [patientsList, depts, templates, medStats, historyPreview, safetyStats] = await Promise.all([
        window.API.invoke('patients:list', { limit: 800 }).catch(() => []),
        window.API.invoke('departments:list').catch(() => []),
        window.API.invoke('prescriptions:templates').catch(() => []),
        window.API.invoke('medications:stats').catch(() => ({ total: 0 })),
        window.API.invoke('prescriptions:list', { limit: 200 }).catch(() => []),
        window.API.invoke('safety:stats').catch(() => ({})),
      ]);
      if (!root.isConnected) return;

      const totalSafetyRules = Object.values(safetyStats || {}).reduce((acc, s) => acc + (s?.total || 0), 0);

      const tabs = [
        ['compose', 'prescription', t('rx.tabCompose')],
        ['history', 'clock', t('rx.tabHistory', { n: historyPreview.length })],
        ['catalog', 'pill', t('rx.tabCatalog', { n: medStats.total })],
        ['protocols', 'clipboard', t('icd.tabProtocols', { n: templates.length })],
        ['certificates', 'certificate', t('rx.tabCertificates')],
        ['safety_rules', 'shield', t('safety.tabRules', { n: totalSafetyRules })],
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
      else if (activeTab === 'protocols') await renderProtocols(bodyHost, ctx, shared);
      else if (activeTab === 'certificates') await renderCertificates(bodyHost, ctx, shared);
      else if (activeTab === 'safety_rules') await renderSafetyRules(bodyHost, ctx);
      else await renderCompose(bodyHost, ctx, shared);
    },
  };
})();
