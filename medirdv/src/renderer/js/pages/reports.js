/* Reports: cash-basis daily and monthly views with a printable day report. */
(function () {
  'use strict';
  const { t, formatMoney, formatDate } = window.I18N;
  const { h, clear, emptyState, errorMessage, input, toast } = window.UI;
  const Pages = window.Pages;

  let mode = 'daily';

  function kpi(label, value, cls = '', foot = '') {
    return h(
      'div',
      { class: 'card kpi' },
      h('div', { class: 'label' }, label),
      h('div', { class: `value ${cls}` }, value),
      foot ? h('div', { class: 'foot' }, foot) : null,
    );
  }

  function chart(series, currency) {
    const max = Math.max(1, ...series.map((row) => Math.max(row.income, row.expenses)));
    return h(
      'div',
      {},
      h(
        'div',
        { class: 'chart' },
        series.map((row) =>
          h(
            'div',
            { class: 'bar-wrap', title: `${formatDate(row.day)} — ${formatMoney(row.income, currency)} / ${formatMoney(row.expenses, currency)}` },
            h('div', { class: 'bar', style: { height: `${Math.max(2, (row.income / max) * 100)}%` } }),
            h('div', { class: 'bar expense', style: { height: `${Math.max(1, (row.expenses / max) * 40)}%` } }),
            h('div', { class: 'bar-label' }, row.day.slice(-2)),
          ),
        ),
      ),
      h(
        'div',
        { class: 'legend mt-s' },
        h('span', {}, h('i', { style: { background: 'var(--teal-600)' } }), t('reports.income')),
        h('span', {}, h('i', { style: { background: '#e7b7b3' } }), t('reports.expenses')),
      ),
    );
  }

  function tableCard(title, headers, rows, emptyText) {
    return h(
      'div',
      { class: 'card' },
      h('h2', { class: 'card-title' }, title),
      rows.length === 0
        ? h('div', { class: 'muted small' }, emptyText)
        : h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'list' },
              h('thead', {}, h('tr', {}, headers.map((header) => h('th', { class: /num/.test(header) ? 'num' : '' }, header)))),
              h(
                'tbody',
                {},
                rows.map((row) => h('tr', {}, row.map((cell, index) => h('td', { class: index > 0 ? 'num' : '' }, cell)))),
              ),
            ),
          ),
    );
  }

  async function renderDaily(root, ctx, currency) {
    const dayInput = input({ type: 'date', value: window.App.day || window.UI.todayISO(), style: { maxWidth: '190px' } });
    dayInput.addEventListener('change', () => {
      window.App.day = dayInput.value;
      ctx.refresh();
    });
    ctx.setHeader(
      t('reports.title'),
      t('reports.daily'),
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'tabs' }, h('button', { class: 'active', onClick: () => { mode = 'daily'; ctx.refresh(); } }, t('reports.daily'))),
        h('div', { class: 'tabs' }, h('button', { onClick: () => { mode = 'monthly'; ctx.refresh(); } }, t('reports.monthly'))),
        h('div', { class: 'tabs' }, h('button', { onClick: () => { mode = 'epidemiology'; ctx.refresh(); } }, t('icd.epidemiologyTab'))),
        h('div', { class: 'tabs' }, h('button', { onClick: () => { mode = 'z_report'; ctx.refresh(); } }, t('billing.zReportTab'))),
        dayInput,
        h('button', { class: 'btn', onClick: () => window.Components.printDailyReport(dayInput.value) }, '🖨️ ', t('reports.print')),
      ),
    );

    const report = await window.API.invoke('reports:daily', { day: dayInput.value });
    clear(root).append(
      h(
        'div',
        { class: 'grid four' },
        kpi(t('reports.income'), formatMoney(report.income, currency), 'income', t('reports.paymentCount', { n: report.income_count })),
        kpi(t('reports.expenses'), formatMoney(report.expenses, currency), 'expense', t('reports.expenseCount', { n: report.expenses_count })),
        kpi(t('reports.net'), formatMoney(report.net, currency), 'net'),
        kpi(t('reports.debts'), formatMoney(report.unpaid_debts, currency), 'expense'),
      ),
      h(
        'div',
        { class: 'grid mt', style: { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', alignItems: 'start' } },
        tableCard(
          `${t('reports.payments')} — ${formatDate(report.day)}`,
          [t('common.patient'), t('common.method'), t('common.amount')],
          report.payments.map((row) => [row.full_name, t(`common.${row.method}`), formatMoney(row.amount, currency)]),
          t('reports.noData'),
        ),
        tableCard(
          t('reports.byCategory'),
          [t('expenses.category'), t('expenses.label'), t('common.amount')],
          report.expenses_detail.map((row) => [
            window.App.language === 'ar' ? row.category_ar : row.category_fr,
            row.label || '—',
            formatMoney(row.amount, currency),
          ]),
          t('reports.noData'),
        ),
      ),
      h(
        'div',
        { class: 'grid mt two' },
        tableCard(
          t('reports.treatments'),
          [t('common.treatment'), t('dash.appointmentsToday'), t('common.total')],
          report.treatments.map((row) => [row.name, String(row.count), formatMoney(row.revenue, currency)]),
          t('reports.noData'),
        ),
        h(
          'div',
          { class: 'card' },
          h('h2', { class: 'card-title' }, t('reports.dayTotal')),
          h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('dash.appointmentsToday')), h('strong', {}, String(report.appointments.total))),
          h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('reports.done')), h('strong', {}, String(report.appointments.done))),
          h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('reports.missed')), h('strong', {}, String(report.appointments.no_show))),
          h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('reports.newPatients')), h('strong', {}, String(report.new_patients))),
          h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('reports.income')), h('strong', {}, formatMoney(report.income, currency))),
          h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('reports.net')), h('strong', { style: { color: 'var(--teal-700)' } }, formatMoney(report.net, currency))),
        ),
      ),
      exportCard('daily', report.day),
    );
  }

  async function renderMonthly(root, ctx, currency) {
    const monthInput = input({ type: 'month', value: window.App.month || window.UI.todayISO().slice(0, 7), style: { maxWidth: '190px' } });
    monthInput.addEventListener('change', () => {
      window.App.month = monthInput.value;
      ctx.refresh();
    });
    ctx.setHeader(
      t('reports.title'),
      t('reports.monthly'),
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'tabs' }, h('button', { onClick: () => { mode = 'daily'; ctx.refresh(); } }, t('reports.daily'))),
        h('div', { class: 'tabs' }, h('button', { class: 'active', onClick: () => { mode = 'monthly'; ctx.refresh(); } }, t('reports.monthly'))),
        h('div', { class: 'tabs' }, h('button', { onClick: () => { mode = 'epidemiology'; ctx.refresh(); } }, t('icd.epidemiologyTab'))),
        h('div', { class: 'tabs' }, h('button', { onClick: () => { mode = 'z_report'; ctx.refresh(); } }, t('billing.zReportTab'))),
        monthInput,
      ),
    );

    const report = await window.API.invoke('reports:monthly', { month: monthInput.value });
    clear(root).append(
      h(
        'div',
        { class: 'grid four' },
        kpi(t('reports.income'), formatMoney(report.income, currency), 'income', t('reports.paymentCount', { n: report.income_count })),
        kpi(t('reports.expenses'), formatMoney(report.expenses, currency), 'expense', t('reports.expenseCount', { n: report.expenses_count })),
        kpi(t('reports.net'), formatMoney(report.net, currency), 'net'),
        kpi(t('reports.debts'), formatMoney(report.unpaid_debts, currency), 'expense'),
      ),
      h(
        'div',
        { class: 'card mt' },
        h('h2', { class: 'card-title' }, t('reports.chart'),
          h('span', { class: 'muted small' }, `${t('reports.avgDay')} : ${formatMoney(report.average_income_per_day, currency)}`)),
        chart(report.series, currency),
      ),
      h(
        'div',
        { class: 'grid mt two' },
        tableCard(
          t('reports.byCategory'),
          [t('expenses.category'), t('common.total')],
          report.expenses_by_category.map((row) => [
            window.App.language === 'ar' ? row.name_ar : row.name_fr,
            formatMoney(row.total, currency),
          ]),
          t('reports.noData'),
        ),
        tableCard(
          t('reports.treatments'),
          [t('common.treatment'), t('dash.appointmentsToday'), t('common.total')],
          report.treatments.map((row) => [row.name, String(row.count), formatMoney(row.revenue, currency)]),
          t('reports.noData'),
        ),
      ),
      h(
        'div',
        { class: 'card mt' },
        h('h2', { class: 'card-title' }, t('reports.monthTotal')),
        h('div', { class: 'grid three' },
          h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('dash.appointmentsToday')), h('strong', {}, String(report.appointments.total))),
          h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('reports.done')), h('strong', {}, String(report.appointments.done))),
          h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('reports.newPatients')), h('strong', {}, String(report.new_patients))),
          h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('reports.bestDay')), h('strong', {}, report.best_day ? `${formatDate(report.best_day.day)} (${formatMoney(report.best_day.income, currency)})` : '—')),
          h('div', { class: 'info-line' }, h('span', { class: 'k' }, t('reports.avgDay')), h('strong', {}, formatMoney(report.average_income_per_day, currency))),
        ),
      ),
      exportCard('monthly', report.month),
    );
  }

  /**
   * Google Sheets / Excel export card.
   *
   * The file is generated locally as a real .xlsx (open it with Google Drive →
   * « Ouvrir avec → Google Sheets », Excel or LibreOffice). Nothing is uploaded:
   * the clinic can stay offline.
   */
  function exportCard(kind, period) {
    const exporting = new Set();

    const run = async (button, target) => {
      if (exporting.has(target)) return;
      exporting.add(target);
      button.disabled = true;
      try {
        if (target === 'copy') {
          const result = await window.API.invoke('export:clipboard', { kind, day: period, month: period });
          const copied = await window.API.copyText(result.tsv);
          toast(copied ? t('export.copied') : t('export.copyFailed'), copied ? 'ok' : 'error');
          return;
        }
        const result = await window.API.invoke('export:sheet', {
          kind: target === 'full' ? 'full' : kind,
          day: period,
          month: period,
        });
        if (result?.canceled) return;
        toast(t('export.done', { file: result.filename || '' }), 'ok');
        if (result.file) {
          window.UI.modal({
            title: t('export.sheetReady'),
            body: h(
              'div',
              {},
              h('p', { class: 'muted' }, t('export.sheetHelp')),
              h('div', { class: 'callout' }, '📄 ' + (result.filename || '')),
              h('div', { class: 'muted small mt-s' }, t('export.sheetOpenHow')),
            ),
            actions: [
              {
                label: t('export.openFolder'),
                kind: 'primary',
                onClick: () => window.API.invoke('export:reveal', { file: result.file }).catch(() => {}),
              },
              { label: t('common.close') },
            ],
          });
        }
      } catch (error) {
        toast(errorMessage(error), 'error');
      } finally {
        exporting.delete(target);
        button.disabled = false;
      }
    };

    const button = (target, icon, label, kindClass = '') => {
      const element = h('button', { class: `btn ${kindClass}` }, label);
      if (window.Icons) window.Icons.decorate(element, icon, { size: 17 });
      element.addEventListener('click', () => run(element, target));
      return element;
    };

    return h(
      'div',
      { class: 'card mt' },
      h(
        'h2',
        { class: 'card-title' },
        t('export.title'),
        h('span', { class: 'badge ok' }, t('export.offline')),
      ),
      h('p', { class: 'card-sub' }, t('export.subtitle')),
      h(
        'div',
        { class: 'row wrap' },
        button('sheet', 'sheet', t('export.thisPeriod'), 'primary'),
        button('full', 'database', t('export.everything')),
        button('copy', 'copy', t('export.copy')),
      ),
      h('div', { class: 'help mt-s' }, t('export.howToOpen')),
    );
  }

  let epiStart = '';
  let epiEnd = '';
  let epiDept = '';

  async function renderEpidemiology(root, ctx) {
    const today = window.UI.todayISO();
    if (!epiEnd) epiEnd = today;
    if (!epiStart) epiStart = `${today.slice(0, 7)}-01`;

    const depts = await window.API.invoke('departments:list').catch(() => []);
    const startIn = input({ type: 'date', value: epiStart, style: { maxWidth: '155px' } });
    const endIn = input({ type: 'date', value: epiEnd, style: { maxWidth: '155px' } });
    const deptSel = window.UI.select(
      [{ value: '', label: t('common.all') }].concat(
        depts.map((d) => ({
          value: String(d.id),
          label: window.App.language === 'ar' ? d.name_ar || d.name_fr : d.name_fr,
        })),
      ),
      { value: epiDept, style: { maxWidth: '200px' } },
    );

    startIn.addEventListener('change', () => { epiStart = startIn.value; ctx.refresh(); });
    endIn.addEventListener('change', () => { epiEnd = endIn.value; ctx.refresh(); });
    deptSel.addEventListener('change', () => { epiDept = deptSel.value; ctx.refresh(); });

    ctx.setHeader(
      t('reports.title'),
      t('icd.epidemiologyTab'),
      h(
        'div',
        { class: 'row wrap' },
        h('div', { class: 'tabs' }, h('button', { onClick: () => { mode = 'daily'; ctx.refresh(); } }, t('reports.daily'))),
        h('div', { class: 'tabs' }, h('button', { onClick: () => { mode = 'monthly'; ctx.refresh(); } }, t('reports.monthly'))),
        h('div', { class: 'tabs' }, h('button', { class: 'active', onClick: () => { mode = 'epidemiology'; ctx.refresh(); } }, t('icd.epidemiologyTab'))),
        h('div', { class: 'tabs' }, h('button', { onClick: () => { mode = 'z_report'; ctx.refresh(); } }, t('billing.zReportTab'))),
        startIn,
        endIn,
        depts.length > 0 ? deptSel : null,
      ),
    );

    const stats = await window.API.invoke('diagnoses:stats', {
      start: epiStart,
      end: epiEnd,
      department_id: epiDept ? Number(epiDept) : undefined,
    });
    const isAr = window.App.language === 'ar';

    clear(root).append(
      h(
        'div',
        { class: 'grid four' },
        kpi(t('icd.kpiTotalDiag'), String(stats.totals?.total_diagnoses || 0)),
        kpi(t('icd.kpiRxCoded'), String(stats.totals?.prescriptions_with_diag || 0)),
        kpi(t('icd.kpiAld'), String(stats.totals?.chronic_ald_cases || 0), 'income'),
        kpi(t('icd.kpiMdo'), String(stats.totals?.notifiable_cases || 0), stats.totals?.notifiable_cases > 0 ? 'expense' : ''),
      ),
      h(
        'div',
        { class: 'grid mt two', style: { alignItems: 'start' } },
        tableCard(
          t('icd.topDiagnoses'),
          [t('icd.codeLabel'), t('common.name'), t('common.total')],
          (stats.by_code || []).map((r) => [
            r.code,
            `${isAr ? r.label_ar || r.label_fr : r.label_fr}${r.is_notifiable ? ' 🚨' : r.is_chronic_ald ? ' ✓' : ''}`,
            String(r.count),
          ]),
          t('reports.noData'),
        ),
        h(
          'div',
          { class: 'col' },
          tableCard(
            t('icd.byAgeGroup'),
            [t('rx.age'), t('common.total')],
            (stats.by_age_group || []).map((r) => [t(`icd.age_${r.age_group}`), String(r.count)]),
            t('reports.noData'),
          ),
          tableCard(
            t('icd.byDepartment'),
            [t('dept.select'), t('common.total')],
            (stats.by_department || []).map((r) => [isAr ? r.name_ar || r.name_fr : r.name_fr, String(r.count)]),
            t('reports.noData'),
          ),
        ),
      ),
    );
  }

  async function renderZReport(root, ctx, currency) {
    const dayIn = input({ type: 'date', value: window.App.day || window.UI.todayISO(), style: { maxWidth: '170px' } });
    dayIn.addEventListener('change', () => {
      window.App.day = dayIn.value;
      ctx.refresh();
    });

    ctx.setHeader(
      t('reports.title'),
      t('billing.zReportTab'),
      h(
        'div',
        { class: 'row wrap' },
        h('div', { class: 'tabs' }, h('button', { onClick: () => { mode = 'daily'; ctx.refresh(); } }, t('reports.daily'))),
        h('div', { class: 'tabs' }, h('button', { onClick: () => { mode = 'monthly'; ctx.refresh(); } }, t('reports.monthly'))),
        h('div', { class: 'tabs' }, h('button', { onClick: () => { mode = 'epidemiology'; ctx.refresh(); } }, t('icd.epidemiologyTab'))),
        h('div', { class: 'tabs' }, h('button', { class: 'active', onClick: () => { mode = 'z_report'; ctx.refresh(); } }, t('billing.zReportTab'))),
        dayIn,
      ),
    );

    const [z, invoices] = await Promise.all([
      window.API.invoke('billing:z-report', { day: dayIn.value }),
      window.API.invoke('billing:invoices', { start: dayIn.value, end: dayIn.value, limit: 100 }),
    ]);

    const downloadBlob = (content, mime, filename, isBase64 = false) => {
      let blob;
      if (isBase64) {
        const bin = atob(content);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        blob = new Blob([arr], { type: mime });
      } else {
        blob = new Blob([content], { type: mime });
      }
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: filename });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    clear(root).append(
      h(
        'div',
        { class: 'grid four' },
        kpi(t('billing.grossCollected'), formatMoney(z.gross_collected, currency)),
        kpi(t('billing.refundsTotal'), formatMoney(z.total_refunds, currency), z.total_refunds > 0 ? 'expense' : ''),
        kpi(t('billing.netCollected'), formatMoney(z.net_collected, currency), 'income'),
        kpi(t('billing.insuredReceivable'), formatMoney(z.invoices?.insured_receivable || 0, currency)),
      ),
      h(
        'div',
        { class: 'grid mt two', style: { alignItems: 'start' } },
        tableCard(
          t('billing.zTitle'),
          [t('common.method'), t('billing.grossCollected'), t('billing.refundsTotal'), t('billing.netCollected')],
          ['cash', 'card', 'transfer'].map((m) => [
            t(`common.${m}`),
            formatMoney(z.by_method[m].gross, currency),
            formatMoney(z.by_method[m].refunds, currency),
            formatMoney(z.by_method[m].net, currency),
          ]),
          t('reports.noData'),
        ),
        h(
          'div',
          { class: 'card col' },
          h('h2', { class: 'card-title' }, t('billing.claimsExportTitle')),
          h(
            'div',
            { class: 'row wrap' },
            h(
              'button',
              {
                type: 'button',
                class: 'btn primary',
                onClick: async () => {
                  const res = await window.API.invoke('billing:claims-export', { format: 'xlsx' });
                  downloadBlob(res.buffer_base64, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `bordereau-cnas-${dayIn.value}.xlsx`, true);
                  toast(t('billing.exportedToast', { n: res.count }), 'ok');
                },
              },
              '📊 ',
              t('billing.exportXlsx'),
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'btn soft',
                onClick: async () => {
                  const res = await window.API.invoke('billing:claims-export', { format: 'csv' });
                  downloadBlob(res.csv, 'text/csv;charset=utf-8', `bordereau-cnas-${dayIn.value}.csv`, false);
                  toast(t('billing.exportedToast', { n: res.count }), 'ok');
                },
              },
              '📄 ',
              t('billing.exportCsv'),
            ),
          ),
        ),
      ),
      tableCard(
        t('billing.invoices'),
        ['N°', t('common.patient'), t('billing.insuranceType'), t('common.total'), t('billing.patientShare')],
        invoices.map((inv) => [
          inv.invoice_number,
          inv.patient_name,
          t(`billing.ins_${inv.insurance_type || 'none'}`),
          formatMoney(inv.total_amount, currency),
          formatMoney(inv.patient_share, currency),
        ]),
        t('reports.noData'),
      ),
    );
  }

  Pages.reports = {
    async render(root, ctx) {
      const currency = window.App.settings.currency;
      try {
        if (mode === 'monthly') await renderMonthly(root, ctx, currency);
        else if (mode === 'epidemiology') await renderEpidemiology(root, ctx);
        else if (mode === 'z_report') await renderZReport(root, ctx, currency);
        else await renderDaily(root, ctx, currency);
      } catch (error) {
        ctx.setHeader(t('reports.title'), '');
        clear(root).append(h('div', { class: 'card error-text' }, errorMessage(error)));
      }
    },
  };
})();
