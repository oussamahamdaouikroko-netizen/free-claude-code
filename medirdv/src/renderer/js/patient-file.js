/* Patient medical file dialog: identity, allergies, chronic conditions, prescriptions, visits & payments. */
(function () {
  'use strict';
  const { t, formatMoney, formatDate, formatDateTime, formatLong } = window.I18N;
  const { h, modal, toast, errorMessage, emptyState, statusBadge, todayISO } = window.UI;

  function section(title, content, action = null) {
    return h(
      'div',
      { class: 'mt' },
      h('h3', { style: { margin: '0 0 10px', fontSize: '1rem' }, class: 'row between' }, h('span', {}, title), action),
      content,
    );
  }

  function formatIntakeAlert(a) {
    if (!a || !a.code) return '';
    switch (a.code) {
      case 'REPORTED_ALLERGY':
        return t('intake.alertAllergy', { v: a.detail || '' });
      case 'PREGNANCY':
        return t('intake.alertPregnancy');
      case 'BREASTFEEDING':
        return t('intake.alertBreastfeeding');
      case 'CHILD_UNDER_15KG':
        return t('intake.alertChildUnder15kg', { v: a.detail || '' });
      case 'CHRONIC_KIDNEY_DISEASE':
        return t('intake.alertCkd', { v: a.detail || '' });
      default:
        return a.detail || a.code;
    }
  }

  function renderIntakeCard(intakeRow, patient, { onReload, onPrescribe } = {}) {
    if (!intakeRow) return null;
    const isPending = intakeRow.status !== 'applied';
    const alerts = Array.isArray(intakeRow.alerts) ? intakeRow.alerts : [];
    const sourceLabel = intakeRow.source === 'manual' ? t('intake.sourceManual') : t('intake.sourceWhatsapp');

    const kv = (label, val) =>
      val !== null && val !== undefined && String(val).trim() !== ''
        ? h(
            'div',
            { class: 'col', style: { gap: '2px' } },
            h('span', { class: 'muted small' }, label),
            h('strong', { class: 'small' }, String(val)),
          )
        : null;

    const actionsRow = isPending
      ? h(
          'div',
          { class: 'row wrap', style: { gap: '8px', marginTop: '10px' } },
          h(
            'button',
            {
              type: 'button',
              class: 'btn sm primary',
              onClick: async () => {
                try {
                  await window.API.invoke('intake:confirm', {
                    id: intakeRow.id,
                    reviewed_by: window.App?.settings?.doctor_name || 'doctor',
                  });
                  toast(t('intake.appliedToast'), 'ok');
                  if (onReload) onReload();
                } catch (err) {
                  toast(errorMessage(err), 'error');
                }
              },
            },
            window.Icons ? window.Icons.el('checkCircle', { size: 15 }) : '',
            ' ',
            t('intake.confirmApply'),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn sm soft',
              onClick: async () => {
                try {
                  const res = await window.API.invoke('intake:confirm', {
                    id: intakeRow.id,
                    reviewed_by: window.App?.settings?.doctor_name || 'doctor',
                  });
                  toast(t('intake.appliedToast'), 'ok');
                  if (onPrescribe) onPrescribe(res);
                } catch (err) {
                  toast(errorMessage(err), 'error');
                }
              },
            },
            window.Icons ? window.Icons.el('prescription', { size: 15 }) : '',
            ' ',
            t('intake.confirmAndPrescribe'),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn sm',
              onClick: () =>
                window.Components.openIntakeModal({
                  patient,
                  intakeRow,
                  applyOnSave: true,
                  onSaved: () => {
                    if (onReload) onReload();
                  },
                }),
            },
            window.Icons ? window.Icons.el('edit', { size: 14 }) : '',
            ' ',
            t('intake.editBeforeApply'),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn sm ghost',
              onClick: async () => {
                try {
                  await window.API.invoke('intake:reject', {
                    id: intakeRow.id,
                    reviewed_by: window.App?.settings?.doctor_name || 'doctor',
                  });
                  toast(t('intake.rejectedToast'), 'ok');
                  if (onReload) onReload();
                } catch (err) {
                  toast(errorMessage(err), 'error');
                }
              },
            },
            t('intake.reject'),
          ),
        )
      : null;

    return section(
      t('intake.cardTitle'),
      h(
        'div',
        {
          class: 'card col',
          style: {
            border: isPending ? '1.5px solid var(--warn, #d97706)' : '1px solid var(--line)',
            background: isPending ? 'rgba(245, 158, 11, 0.06)' : 'var(--surface)',
            gap: '10px',
          },
        },
        h(
          'div',
          { class: 'row wrap between', style: { gap: '8px' } },
          h(
            'span',
            { class: `badge ${isPending ? 'warn' : 'ok'}` },
            isPending ? t('intake.unverifiedBanner') : t('intake.verifiedBanner'),
          ),
          h('span', { class: 'muted small' }, `${sourceLabel} · ${formatDateTime(intakeRow.created_at)}`),
        ),
        alerts.length > 0
          ? h(
              'div',
              { class: 'row wrap', style: { gap: '6px' } },
              alerts.map((a) => h('span', { class: 'badge danger' }, formatIntakeAlert(a))),
            )
          : null,
        h(
          'div',
          { class: 'grid three', style: { gap: '10px' } },
          kv(
            t('intake.ageYears'),
            intakeRow.effective_age_years !== null && intakeRow.effective_age_years !== undefined
              ? intakeRow.effective_age_years < 2
                ? t('intake.ageUnitMonths', { n: Math.round(intakeRow.effective_age_years * 12) })
                : t('intake.ageUnitYears', { n: Math.round(intakeRow.effective_age_years * 10) / 10 })
              : '',
          ),
          kv(t('intake.weightKg'), intakeRow.weight_kg ? `${intakeRow.weight_kg} kg` : ''),
          kv(t('intake.heightCm'), intakeRow.height_cm ? `${intakeRow.height_cm} cm` : ''),
          kv(t('intake.bmi'), intakeRow.bmi || ''),
          kv(
            t('intake.complaint'),
            intakeRow.chief_complaint
              ? `${intakeRow.chief_complaint}${intakeRow.symptom_duration ? ` (${intakeRow.symptom_duration})` : ''}`
              : '',
          ),
          kv(t('intake.currentMeds'), intakeRow.current_medications),
          kv(t('intake.knownAllergies'), intakeRow.known_allergies),
          kv(t('intake.chronic'), intakeRow.chronic_conditions),
          kv(t('intake.lastBp'), intakeRow.last_blood_pressure),
          kv(t('intake.lastGlycemia'), intakeRow.last_glycemia),
          intakeRow.is_pregnant === 1 ? kv(t('intake.pregnant'), t('common.yes')) : null,
          intakeRow.is_breastfeeding === 1 ? kv(t('intake.breastfeeding'), t('common.yes')) : null,
          intakeRow.smoker === 1 ? kv(t('intake.smoker'), t('common.yes')) : null,
        ),
        actionsRow,
      ),
    );
  }

  function renderWeightTrend(weightHistory = [], patient, onReload) {
    const addWeightBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn sm ghost',
        onClick: () => {
          const wIn = window.UI.input({ type: 'number', step: '0.1', min: '0.3', max: '400', placeholder: '72.0', autofocus: true });
          const hIn = window.UI.input({ type: 'number', step: '0.5', min: '30', max: '250', placeholder: '170' });
          const err = h('div', { class: 'error-text' });
          modal({
            title: `${t('intake.recordWeightBtn')} · ${patient.full_name}`,
            body: h(
              'div',
              { class: 'col' },
              h('div', { class: 'grid two' }, window.UI.field(t('intake.weightKg'), wIn), window.UI.field(t('intake.heightCm'), hIn)),
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
                    await window.API.invoke('intake:record-weight', {
                      patient_id: patient.id,
                      weight_kg: wIn.value.trim(),
                      height_cm: hIn.value.trim() || null,
                    });
                    toast(t('common.saved'), 'ok');
                    if (onReload) onReload();
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
      window.Icons ? window.Icons.el('scale', { size: 15 }) : '',
      ' ',
      t('intake.recordWeightBtn'),
    );

    return section(
      t('intake.weightTrendTitle'),
      weightHistory.length === 0
        ? h('div', { class: 'muted small' }, t('intake.weightTrendEmpty'))
        : h(
            'div',
            { class: 'row wrap', style: { gap: '8px' } },
            weightHistory.slice(0, 8).map((entry, idx) => {
              const prev = weightHistory[idx + 1];
              const diff = prev ? Math.round((entry.weight_kg - prev.weight_kg) * 10) / 10 : null;
              const diffStr = diff === null || diff === 0 ? '' : diff > 0 ? ` (+${diff} kg)` : ` (${diff} kg)`;
              return h(
                'div',
                { class: 'card', style: { padding: '8px 12px', minWidth: '130px' } },
                h('div', { class: 'strong' }, `${entry.weight_kg} kg${diffStr}`),
                h(
                  'div',
                  { class: 'muted small' },
                  `${formatDate(entry.recorded_at)}${entry.bmi ? ` · ${t('intake.bmi')} ${entry.bmi}` : ''}`,
                ),
              );
            }),
          ),
      addWeightBtn,
    );
  }

  async function open(patientId) {
    const currency = () => window.App.settings.currency;
    const host = h('div', {}, h('div', { class: 'empty' }, t('common.loading')));
    const dialog = modal({ title: t('patients.file'), body: host, wide: true, actions: [{ label: t('common.close'), kind: 'ghost' }] });
    let emrTab = 'overview';

    async function load() {
      try {
        const [data, payments, consultations, labs, imaging, vaccinations, pregnancy, docs, vitals, timeline] = await Promise.all([
          window.API.invoke('patients:get', { id: patientId }),
          window.API.invoke('payments:by-patient', { patient_id: patientId }),
          window.API.invoke('emr:consultations', { patient_id: patientId }).catch(() => []),
          window.API.invoke('emr:labs', { patient_id: patientId }).catch(() => ({ orders: [], results: [], trends: [] })),
          window.API.invoke('emr:imaging', { patient_id: patientId }).catch(() => []),
          window.API.invoke('emr:vaccinations', { patient_id: patientId }).catch(() => ({ schedule: [], administered: [], due: [] })),
          window.API.invoke('emr:pregnancy', { patient_id: patientId }).catch(() => []),
          window.API.invoke('emr:docs', { patient_id: patientId }).catch(() => []),
          window.API.invoke('emr:vitals-trends', { patient_id: patientId }).catch(() => ({ bp: [], glycemia: [] })),
          window.API.invoke('emr:timeline', { patient_id: patientId }).catch(() => []),
        ]);
        const { patient, history, prescriptions = [], intakes = [], pending_intake = null, weight_history = [] } = data;
        const activeIntake = pending_intake || intakes.find((r) => r.status !== 'rejected') || null;
        const upcoming = history.find(
          (row) => row.day >= todayISO() && (row.status === 'booked' || row.status === 'done'),
        );
        const balance = Number(patient.balance) || 0;

        const emrTabBar = h(
          'div',
          { class: 'dept-tabs mt', style: { marginBottom: '8px' } },
          [
            ['overview', t('emr.tabOverview')],
            ['consultations', t('emr.tabConsultations', { n: consultations.length })],
            ['labs_imaging', t('emr.tabLabsImaging', { n: (labs.results?.length || 0) + imaging.length })],
            ['prevention', t('emr.tabPrevention')],
            ['documents', t('emr.tabDocuments', { n: docs.length })],
          ].map(([id, label]) =>
            h(
              'button',
              {
                type: 'button',
                class: `dept-tab ${emrTab === id ? 'active' : ''}`,
                onClick: () => {
                  emrTab = id;
                  load();
                },
              },
              label,
            ),
          ),
        );

        const renderConsultationsTab = () => {
          const ccIn = window.UI.input({ placeholder: t('emr.chiefComplaint') });
          const histIn = window.UI.textarea({ placeholder: t('emr.historyIllness') });
          const examIn = window.UI.textarea({ placeholder: t('emr.physicalExam') });
          const assessIn = window.UI.input({ placeholder: t('emr.assessment') });
          const planIn = window.UI.textarea({ placeholder: t('emr.plan') });
          const bpIn = window.UI.input({ placeholder: '120/80' });
          const glyIn = window.UI.input({ placeholder: '0,95' });
          const wIn = window.UI.input({ placeholder: 'kg' });
          const hIn = window.UI.input({ placeholder: 'cm' });
          const hcIn = window.UI.input({ placeholder: 'cm' });

          const whoHost = h('div', { class: 'muted small mt-s' });
          if (vaccinations.age_months !== null && vaccinations.age_months <= 120 && weight_history[0]) {
            window.API.invoke('emr:who-growth', {
              gender: patient.gender || 'm',
              age_months: vaccinations.age_months,
              weight_kg: weight_history[0].weight_kg,
              height_cm: weight_history[0].height_cm,
            }).then((g) => {
              if (!whoHost.isConnected) return;
              whoHost.textContent = `${t('emr.whoGrowthTitle')} — ${t('emr.whoResult', {
                wp: g.weight_percentile ?? '—',
                wz: g.weight_z ?? '—',
                hp: g.height_percentile ?? '—',
                hz: g.height_z ?? '—',
              })}`;
            }).catch(() => {});
          }

          return h(
            'div',
            { class: 'col mt' },
            whoHost,
            h(
              'div',
              { class: 'card col' },
              h('strong', {}, t('emr.newConsultation')),
              window.UI.field(t('emr.chiefComplaint'), ccIn),
              h('div', { class: 'grid two' }, window.UI.field(t('emr.historyIllness'), histIn), window.UI.field(t('emr.physicalExam'), examIn)),
              h('div', { class: 'grid two' }, window.UI.field(t('emr.assessment'), assessIn), window.UI.field(t('emr.plan'), planIn)),
              h(
                'div',
                { class: 'grid four' },
                window.UI.field(t('rx.bp'), bpIn),
                window.UI.field(t('rx.glycemia'), glyIn),
                window.UI.field(t('rx.weight'), wIn),
                window.UI.field(t('emr.headCirc'), hcIn),
              ),
              window.UI.field(t('intake.heightCm'), hIn),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn primary',
                  onClick: async () => {
                    try {
                      await window.API.invoke('emr:consultation-create', {
                        patient_id: patient.id,
                        chief_complaint: ccIn.value,
                        history_of_illness: histIn.value,
                        physical_exam: examIn.value,
                        assessment: assessIn.value,
                        plan: planIn.value,
                        vitals_bp: bpIn.value,
                        vitals_glycemia: glyIn.value,
                        weight_kg: wIn.value,
                        height_cm: hIn.value,
                        head_circumference_cm: hcIn.value,
                      });
                      toast(t('common.saved'), 'ok');
                      load();
                    } catch (e) {
                      toast(errorMessage(e), 'error');
                    }
                  },
                },
                t('common.save'),
              ),
            ),
            consultations.map((c) =>
              h(
                'div',
                { class: 'card col' },
                h('div', { class: 'row between' }, h('strong', {}, `${formatDate(c.day)} — ${c.chief_complaint || c.assessment || '—'}`), c.bmi ? h('span', { class: 'badge info' }, `${t('intake.bmi')} ${c.bmi}`) : null),
                c.physical_exam ? h('div', { class: 'small' }, `${t('emr.physicalExam')} : ${c.physical_exam}`) : null,
                c.assessment ? h('div', { class: 'small strong' }, `${t('emr.assessment')} : ${c.assessment}`) : null,
                c.plan ? h('div', { class: 'small muted' }, `${t('emr.plan')} : ${c.plan}`) : null,
              ),
            ),
          );
        };

        const renderLabsImagingTab = () => {
          const analyteIn = window.UI.input({ placeholder: 'HbA1c / Glycémie / Créatinine…' });
          const valIn = window.UI.input({ placeholder: '7.4' });
          const unitIn = window.UI.input({ placeholder: '% / g/L / mg/L' });
          const minIn = window.UI.input({ placeholder: '4.0' });
          const maxIn = window.UI.input({ placeholder: '6.5' });

          const modSel = window.UI.select([
            { value: 'rx', label: 'RX' },
            { value: 'echo', label: 'Écho' },
            { value: 'ct', label: 'Scanner' },
            { value: 'mri', label: 'IRM' },
            { value: 'ecg', label: 'ECG' },
          ]);
          const regionIn = window.UI.input({ placeholder: t('emr.bodyRegion') });
          const findIn = window.UI.textarea({ placeholder: t('emr.findings') });
          const abnChk = h('input', { type: 'checkbox' });

          return h(
            'div',
            { class: 'grid two mt', style: { alignItems: 'start' } },
            h(
              'div',
              { class: 'card col' },
              h('strong', {}, t('emr.newLabResult')),
              window.UI.field(t('emr.analyte'), analyteIn),
              h('div', { class: 'grid two' }, window.UI.field(t('emr.value'), valIn), window.UI.field(t('emr.unit'), unitIn)),
              h('div', { class: 'grid two' }, window.UI.field(t('emr.refMin'), minIn), window.UI.field(t('emr.refMax'), maxIn)),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn primary sm',
                  onClick: async () => {
                    try {
                      await window.API.invoke('emr:lab-result', {
                        patient_id: patient.id,
                        analyte_label: analyteIn.value,
                        value_num: valIn.value,
                        unit: unitIn.value,
                        ref_min: minIn.value,
                        ref_max: maxIn.value,
                      });
                      toast(t('common.saved'), 'ok');
                      load();
                    } catch (e) {
                      toast(errorMessage(e), 'error');
                    }
                  },
                },
                t('common.save'),
              ),
              (labs.results || []).map((r) =>
                h(
                  'div',
                  { class: 'row between wrap', style: { padding: '6px 0', borderBottom: '1px solid var(--line)' } },
                  h('span', {}, `${formatDate(r.day)} · ${r.analyte_label}`),
                  h(
                    'span',
                    { class: 'row', style: { gap: '6px' } },
                    h('strong', {}, `${r.value_num ?? r.value_text} ${r.unit || ''}`),
                    r.abnormal_flag
                      ? h(
                          'span',
                          { class: `badge ${r.abnormal_flag === 'critical' ? 'danger' : 'warn'}` },
                          t(r.abnormal_flag === 'low' ? 'emr.flagLow' : r.abnormal_flag === 'critical' ? 'emr.flagCritical' : 'emr.flagHigh'),
                        )
                      : null,
                  ),
                ),
              ),
            ),
            h(
              'div',
              { class: 'card col' },
              h('strong', {}, t('emr.newImaging')),
              h('div', { class: 'grid two' }, window.UI.field(t('emr.modality'), modSel), window.UI.field(t('emr.bodyRegion'), regionIn)),
              window.UI.field(t('emr.findings'), findIn),
              h('label', { class: 'row small', style: { gap: '6px' } }, abnChk, t('emr.abnormal')),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn primary sm',
                  onClick: async () => {
                    try {
                      await window.API.invoke('emr:imaging-order', {
                        patient_id: patient.id,
                        modality: modSel.value,
                        body_region: regionIn.value,
                        findings: findIn.value,
                        abnormal_flag: abnChk.checked,
                      });
                      toast(t('common.saved'), 'ok');
                      load();
                    } catch (e) {
                      toast(errorMessage(e), 'error');
                    }
                  },
                },
                t('common.save'),
              ),
              imaging.map((im) =>
                h(
                  'div',
                  { class: 'col', style: { padding: '6px 0', borderBottom: '1px solid var(--line)' } },
                  h('div', { class: 'row between' }, h('strong', {}, `${formatDate(im.day)} · ${im.modality.toUpperCase()} ${im.body_region}`), im.abnormal_flag ? h('span', { class: 'badge danger' }, t('emr.abnormal')) : null),
                  im.findings ? h('div', { class: 'small muted' }, im.findings) : null,
                ),
              ),
            ),
          );
        };

        const renderPreventionTab = () => {
          const vacSel = window.UI.select(
            (vaccinations.schedule || []).map((v) => ({
              value: v.vaccine_code,
              label: window.App.language === 'ar' ? v.name_ar || v.name_fr : v.name_fr,
            })),
          );
          const lotIn = window.UI.input({ placeholder: t('emr.lotNumber') });
          const ddrIn = window.UI.input({ type: 'date' });

          return h(
            'div',
            { class: 'grid two mt', style: { alignItems: 'start' } },
            h(
              'div',
              { class: 'card col' },
              h('strong', {}, t('emr.vaccTitle')),
              (vaccinations.due || []).length > 0
                ? h('div', { class: 'badge warn' }, t('emr.vaccDueAlert', { n: vaccinations.due.length }))
                : null,
              window.UI.field(t('emr.vaccRecordBtn'), vacSel),
              window.UI.field(t('emr.lotNumber'), lotIn),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn primary sm',
                  onClick: async () => {
                    const chosen = (vaccinations.schedule || []).find((v) => v.vaccine_code === vacSel.value);
                    await window.API.invoke('emr:vaccination-record', {
                      patient_id: patient.id,
                      vaccine_code: vacSel.value,
                      vaccine_name: chosen ? chosen.name_fr : vacSel.value,
                      dose_label: chosen ? chosen.dose_label : '',
                      lot_number: lotIn.value,
                    });
                    toast(t('common.saved'), 'ok');
                    load();
                  },
                },
                t('emr.vaccRecordBtn'),
              ),
              (vaccinations.administered || []).map((v) =>
                h('div', { class: 'small', style: { padding: '4px 0', borderBottom: '1px solid var(--line)' } }, `✓ ${formatDate(v.administered_day)} — ${v.vaccine_name}${v.lot_number ? ` (${v.lot_number})` : ''}`),
              ),
            ),
            patient.gender === 'f'
              ? h(
                  'div',
                  { class: 'card col' },
                  h('strong', {}, t('emr.pregTitle')),
                  window.UI.field(t('emr.ddr'), ddrIn),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'btn primary sm',
                      onClick: async () => {
                        try {
                          await window.API.invoke('emr:pregnancy-create', { patient_id: patient.id, ddr: ddrIn.value });
                          toast(t('common.saved'), 'ok');
                          load();
                        } catch (e) {
                          toast(errorMessage(e), 'error');
                        }
                      },
                    },
                    t('emr.newPregnancy'),
                  ),
                  pregnancy.map((ep) =>
                    h(
                      'div',
                      { class: 'card col', style: { padding: '8px' } },
                      h('strong', {}, `${t('emr.ddr')} : ${formatDate(ep.ddr)} → ${t('emr.dpa')} : ${formatDate(ep.dpa)}`),
                      ep.current_gestational_weeks !== null
                        ? h('span', { class: 'badge info' }, `${ep.current_gestational_weeks} SA`)
                        : null,
                    ),
                  ),
                )
              : h('div', {}),
          );
        };

        const renderDocumentsTab = () => {
          const titleIn = window.UI.input({ placeholder: t('emr.docTitle') });
          const catSel = window.UI.select([
            { value: 'lab', label: 'Biologie' },
            { value: 'imaging', label: 'Imagerie' },
            { value: 'letter', label: 'Courrier' },
            { value: 'consent', label: 'Consentement' },
            { value: 'other', label: 'Autre' },
          ]);
          const fileIn = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg,.webp', style: { display: 'none' } });
          fileIn.addEventListener('change', async () => {
            const f = fileIn.files?.[0];
            if (!f) return;
            try {
              const buf = await f.arrayBuffer();
              const bytes = new Uint8Array(buf);
              let bin = '';
              for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
              await window.API.invoke('emr:doc-attach', {
                patient_id: patient.id,
                category: catSel.value,
                title: titleIn.value.trim() || f.name,
                filename: f.name,
                data_base64: btoa(bin),
              });
              toast(t('common.saved'), 'ok');
              load();
            } catch (e) {
              toast(errorMessage(e), 'error');
            }
          });

          return h(
            'div',
            { class: 'card col mt' },
            h('div', { class: 'grid two' }, window.UI.field(t('emr.docTitle'), titleIn), window.UI.field(t('emr.docCategory'), catSel)),
            h('button', { type: 'button', class: 'btn primary sm', onClick: () => fileIn.click() }, fileIn, '📎 ', t('emr.attachDoc')),
            docs.map((doc) =>
              h(
                'div',
                { class: 'row between wrap', style: { padding: '8px 0', borderBottom: '1px solid var(--line)' } },
                h('span', {}, `${formatDate(doc.day)} · ${doc.title} (${Math.round(doc.size_bytes / 1024)} KB)`),
                h(
                  'div',
                  { class: 'row', style: { gap: '6px' } },
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'btn sm soft',
                      onClick: async () => {
                        const full = await window.API.invoke('emr:doc-read', { id: doc.id });
                        modal({
                          title: full.title,
                          wide: true,
                          body: full.mime_type.startsWith('image/')
                            ? h('img', { src: full.data_url, style: { maxWidth: '100%', borderRadius: '8px' } })
                            : h('iframe', { src: full.data_url, style: { width: '100%', height: '70vh', border: 'none' } }),
                          actions: [{ label: t('common.close') }],
                        });
                      },
                    },
                    t('emr.viewDoc'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'btn sm ghost',
                      onClick: async () => {
                        await window.API.invoke('emr:doc-remove', { id: doc.id });
                        load();
                      },
                    },
                    t('common.delete'),
                  ),
                ),
              ),
            ),
          );
        };

        host.replaceChildren(
          h(
            'div',
            { class: 'row wrap between' },
            h(
              'div',
              { class: 'col', style: { gap: '6px' } },
              h(
                'div',
                { class: 'row wrap', style: { gap: '8px' } },
                h('div', { style: { fontSize: '1.25rem', fontWeight: '700' } }, patient.full_name),
                patient.blood_group ? h('span', { class: 'badge ok' }, patient.blood_group) : null,
                patient.chronic_conditions ? h('span', { class: 'badge warn' }, patient.chronic_conditions) : null,
              ),
              h('div', { class: 'muted small' }, [patient.phone, patient.birth_date ? formatDate(patient.birth_date) : '', patient.wilaya, patient.chifa_number ? `${t('emr.chifa')}: ${patient.chifa_number}` : ''].filter(Boolean).join(' · ') || '—'),
              patient.allergies
                ? h('div', { class: 'allergy-alert', style: { padding: '7px 12px', fontSize: '0.84rem' } }, '⚠️ ', `${t('patients.allergies')} : ${patient.allergies}`)
                : null,
              patient.notes ? h('div', { class: 'muted small' }, '📝 ' + patient.notes) : null,
            ),
            h(
              'div',
              { class: 'col', style: { alignItems: 'flex-end' } },
              h('span', { class: `badge ${balance > 0.009 ? 'danger' : 'ok'}` }, `${t('patients.debt')} : ${formatMoney(Math.max(0, balance), currency())}`),
              h(
                'div',
                { class: 'row wrap' },
                h(
                  'button',
                  {
                    class: 'btn sm soft',
                    onClick: () => {
                      const typeSel = window.UI.select(
                        ['referral', 'medical_report', 'cert_fitness_sports', 'cert_school', 'cert_vaccination'].map((k) => ({
                          value: k,
                          label: t(`print.doc_${k}`),
                        })),
                      );
                      const recIn = input({ placeholder: 'Dr. ... / Cardiologie' });
                      const sumIn = window.UI.textarea({ rows: 3 });
                      modal({
                        title: t('print.newDocBtn'),
                        body: h('div', { class: 'col' }, field(t('print.docType'), typeSel), field(t('print.recipientDoc'), recIn), field(t('print.summaryLabel'), sumIn)),
                        actions: [
                          { label: t('common.cancel'), kind: 'ghost' },
                          {
                            label: t('common.save'),
                            kind: 'primary',
                            onClick: async () => {
                              const created = await window.API.invoke('docs:create', {
                                patient_id: patient.id,
                                doc_type: typeSel.value,
                                recipient_doctor: recIn.value,
                                clinical_summary: sumIn.value,
                              });
                              const { html } = await window.API.invoke('docs:html', { id: created.id });
                              const w = window.open('', '_blank');
                              if (w) {
                                w.document.write(html);
                                w.document.close();
                              }
                            },
                          },
                        ],
                      });
                    },
                  },
                  '📄 ',
                  t('print.newDocBtn'),
                ),
                h(
                  'button',
                  {
                    class: 'btn sm ghost',
                    onClick: async () => {
                      const bundle = await window.API.invoke('privacy:export', { patient_id: patient.id });
                      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const a = h('a', { href: url, download: `patient-${patient.id}-18-07.json` });
                      document.body.append(a);
                      a.click();
                      a.remove();
                    },
                  },
                  t('sec.law1807Export'),
                ),
                h(
                  'button',
                  {
                    class: 'btn sm ghost',
                    onClick: async () => {
                      const ok = await window.UI.confirmDialog(t('sec.law1807AnonConfirm'));
                      if (!ok) return;
                      await window.API.invoke('privacy:anonymize', { patient_id: patient.id });
                      toast(t('common.saved'), 'ok');
                      load();
                    },
                  },
                  t('sec.law1807Anon'),
                ),
                h(
                  'button',
                  {
                    class: 'btn sm',
                    onClick: () =>
                      window.Components.openPatientModal({
                        patient,
                        onSaved: () => load(),
                      }),
                  },
                  '✏️ ' + t('common.edit'),
                ),
                h(
                  'button',
                  {
                    class: 'btn sm',
                    onClick: () =>
                      window.Components.openIntakeModal({
                        patient,
                        appointmentId: upcoming?.id || null,
                        onSaved: () => load(),
                      }),
                  },
                  window.Icons ? window.Icons.el('clipboard', { size: 14 }) : '',
                  ' ',
                  t('intake.newManual'),
                ),
                h(
                  'button',
                  {
                    class: 'btn sm soft',
                    onClick: () => {
                      dialog.close();
                      if (window.openPrescriptionComposer) window.openPrescriptionComposer({ patient });
                    },
                  },
                  '💊 ' + t('patients.newPrescription'),
                ),
                h(
                  'button',
                  {
                    class: 'btn sm soft',
                    onClick: () =>
                      window.Components.openInvoiceModal({
                        patient,
                        onSaved: () => load(),
                      }),
                  },
                  '🧾 ' + t('billing.newInvoice'),
                ),
                h(
                  'button',
                  {
                    class: 'btn sm primary',
                    onClick: () =>
                      window.Components.openAppointmentModal({
                        patientId: patient.id,
                        onSaved: () => load(),
                      }),
                  },
                  '🗓️ ' + t('patients.book'),
                ),
                balance > 0.009
                  ? h(
                      'button',
                      {
                        class: 'btn sm soft',
                        onClick: () =>
                          window.Components.openPaymentModal({
                            patientId: patient.id,
                            onSaved: () => load(),
                          }),
                      },
                      '💵 ' + t('patients.payDebt'),
                    )
                  : null,
              ),
            ),
          ),
          emrTabBar,
          emrTab === 'consultations'
            ? renderConsultationsTab()
            : emrTab === 'labs_imaging'
              ? renderLabsImagingTab()
              : emrTab === 'prevention'
                ? renderPreventionTab()
                : emrTab === 'documents'
                  ? renderDocumentsTab()
                  : h(
                      'div',
                      {},
                      (vitals.bp?.length > 0 || vitals.glycemia?.length > 0)
                        ? section(
                            t('emr.vitalsTrends'),
                            h(
                              'div',
                              { class: 'row wrap', style: { gap: '8px' } },
                              (vitals.bp || []).slice(-5).map((b) => h('span', { class: 'badge info' }, `${formatDate(b.day)} · TA ${b.sys}/${b.dia}`)),
                              (vitals.glycemia || []).slice(-5).map((g) => h('span', { class: 'badge warn' }, `${formatDate(g.day)} · Gly ${g.value}`)),
                            ),
                          )
                        : null,
                      timeline.length > 0
                        ? section(
                            t('emr.timelineTitle'),
                            h(
                              'div',
                              { class: 'col', style: { gap: '4px', maxHeight: '160px', overflowY: 'auto' } },
                              timeline.slice(0, 12).map((ev) =>
                                h('div', { class: 'small row between', style: { borderBottom: '1px solid var(--line)', padding: '4px 0' } }, h('span', {}, `${formatDate(ev.day)} · ${ev.title}`), h('span', { class: 'muted' }, ev.kind)),
                              ),
                            ),
                          )
                        : null,
          upcoming
            ? section(
                t('patients.upcoming'),
                h(
                  'div',
                  { class: 'appt' },
                  h('div', { class: 'queue' }, upcoming.queue_number),
                  h(
                    'div',
                    { class: 'who' },
                    h('div', { class: 'name' }, formatLong(upcoming.day)),
                    h(
                      'div',
                      { class: 'meta' },
                      [window.Components.departmentLabel(upcoming), upcoming.treatment_name || t('common.none')]
                        .filter(Boolean)
                        .join(' · '),
                    ),
                  ),
                  h('div', { class: 'money' }, formatMoney(upcoming.price, currency())),
                ),
              )
            : null,
          renderIntakeCard(activeIntake, patient, {
            onReload: () => load(),
            onPrescribe: (res) => {
              dialog.close();
              if (window.openPrescriptionComposer) {
                const pf = res?.prescription_prefill || {};
                window.openPrescriptionComposer({
                  patient: res?.patient || patient,
                  patient_weight: pf.patient_weight || '',
                  diagnosis: pf.chief_complaint || '',
                  vitals_bp: pf.vitals_bp || '',
                  vitals_glycemia: pf.vitals_glycemia || '',
                });
              }
            },
          }),
          renderWeightTrend(weight_history, patient, () => load()),
          section(
            `${t('patients.prescriptions')} (${prescriptions.length})`,
            prescriptions.length === 0
              ? h('div', { class: 'muted small' }, t('patients.noPrescriptions'))
              : h(
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
                        h('th', {}, t('common.date')),
                        h('th', {}, t('rx.drugName')),
                        h('th', { class: 'actions' }, ''),
                      ),
                    ),
                    h(
                      'tbody',
                      {},
                      prescriptions.map((rx) =>
                        h(
                          'tr',
                          {},
                          h('td', {}, formatDate(rx.day)),
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
                                onClick: () => {
                                  dialog.close();
                                  if (window.openPrescriptionComposer) {
                                    window.openPrescriptionComposer({
                                      patient,
                                      department_id: rx.department_id,
                                      diagnosis: rx.diagnosis,
                                      exams_requested: rx.exams_requested,
                                      advice: rx.advice,
                                      items: rx.items || [],
                                    });
                                  }
                                },
                              },
                              '↻ ' + t('rx.renew'),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
          ),
          section(
            `${t('patients.history')} (${history.length})`,
            history.length === 0
              ? emptyState(t('patients.noHistory'), 'clock')
              : h(
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
                        h('th', {}, t('common.date')),
                        h('th', {}, 'N°'),
                        h('th', {}, t('common.treatment')),
                        h('th', {}, t('common.price')),
                        h('th', {}, t('common.paid')),
                        h('th', {}, t('common.due')),
                        h('th', {}, t('common.status')),
                        h('th', { class: 'actions' }, ''),
                      ),
                    ),
                    h(
                      'tbody',
                      {},
                      history.map((row) =>
                        h(
                          'tr',
                          {},
                          h('td', {}, formatDate(row.day)),
                          h('td', {}, String(row.queue_number)),
                          h(
                            'td',
                            {},
                            [window.Components.departmentLabel(row), row.treatment_name]
                              .filter(Boolean)
                              .join(' · ') || '—',
                          ),
                          h('td', { class: 'num' }, formatMoney(row.price, currency())),
                          h('td', { class: 'num' }, formatMoney(row.paid, currency())),
                          h(
                            'td',
                            { class: 'num' },
                            row.balance > 0.009
                              ? h('span', { style: { color: 'var(--danger)', fontWeight: '600' } }, formatMoney(row.balance, currency()))
                              : '✓',
                          ),
                          h('td', {}, statusBadge(row.status)),
                          h(
                            'td',
                            { class: 'actions' },
                            row.status !== 'cancelled'
                              ? h(
                                  'button',
                                  {
                                    class: 'btn icon sm',
                                    title: t('common.edit'),
                                    onClick: () =>
                                      window.Components.openAppointmentEditModal({
                                        appointment: row,
                                        onSaved: () => load(),
                                      }),
                                  },
                                  '💲',
                                )
                              : null,
                            row.status !== 'cancelled' && row.balance > 0.009
                              ? h(
                                  'button',
                                  {
                                    class: 'btn icon sm',
                                    title: t('patients.addPayment'),
                                    onClick: () =>
                                      window.Components.openPaymentModal({
                                        patientId: patient.id,
                                        appointment: row,
                                        onSaved: () => load(),
                                      }),
                                  },
                                  '💵',
                                )
                              : null,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
          ),
          section(
            t('patients.payments'),
            payments.length === 0
              ? h('div', { class: 'muted small' }, t('patients.noPayments'))
              : h(
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
                        h('th', {}, t('common.date')),
                        h('th', {}, t('common.amount')),
                        h('th', {}, t('common.method')),
                        h('th', {}, t('common.note')),
                        h('th', { class: 'actions' }, ''),
                      ),
                    ),
                    h(
                      'tbody',
                      {},
                      payments.map((payment) =>
                        h(
                          'tr',
                          {},
                          h('td', {}, formatDateTime(payment.paid_at)),
                          h('td', { class: 'num' }, formatMoney(payment.amount, currency())),
                          h('td', {}, t(`common.${payment.method}`)),
                          h('td', {}, payment.note || '—'),
                          h(
                            'td',
                            { class: 'actions' },
                            h(
                              'button',
                              {
                                class: 'btn icon sm',
                                title: t('patients.printReceipt'),
                                onClick: () => window.Components.printReceipt(payment.id),
                              },
                              '🖨️',
                            ),
                            h(
                              'button',
                              {
                                class: 'btn icon sm',
                                title: t('common.delete'),
                                onClick: async () => {
                                  const ok = await window.UI.confirmDialog(t('common.delete') + ' ?');
                                  if (!ok) return;
                                  try {
                                    await window.API.invoke('payments:remove', { id: payment.id });
                                    toast(t('common.deleted'), 'ok');
                                    load();
                                  } catch (error) {
                                    toast(errorMessage(error), 'error');
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
          ),
                    ),
        );
      } catch (error) {
        host.replaceChildren(h('div', { class: 'error-text' }, errorMessage(error)));
      }
    }

    await load();
    return dialog;
  }

  window.openPatientFile = open;
})();
