/* Expenses: filters, totals by category, CRUD. */
(function () {
  'use strict';
  const { t, formatMoney, formatDate } = window.I18N;
  const { h, clear, emptyState, toast, errorMessage, input, modal, field } = window.UI;
  const Pages = window.Pages;

  function monthBounds(month) {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
  }

  function categoryDialog(onSaved) {
    const nameFr = input({ placeholder: 'Ex. Assurance' });
    const nameAr = input({ placeholder: 'تأمين', dir: 'rtl' });
    const error = h('div', { class: 'error-text' });
    modal({
      title: t('expenses.newCategory'),
      body: h('div', { class: 'col' }, field(t('expenses.categoryNameFr'), nameFr), field(t('expenses.categoryNameAr'), nameAr), error),
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        {
          label: t('common.save'),
          kind: 'primary',
          onClick: async () => {
            try {
              await window.API.invoke('expenses:create-category', { name_fr: nameFr.value.trim(), name_ar: nameAr.value.trim() });
              toast(t('common.saved'), 'ok');
              onSaved();
              return true;
            } catch (err) {
              error.textContent = errorMessage(err);
              return false;
            }
          },
        },
      ],
    });
  }

  Pages.expenses = {
    async render(root, ctx) {
      const monthInput = input({ type: 'month', value: window.App.month || window.UI.todayISO().slice(0, 7), style: { maxWidth: '190px' } });
      monthInput.addEventListener('change', () => {
        window.App.month = monthInput.value;
        ctx.refresh();
      });

      ctx.setHeader(
        t('expenses.title'),
        t('expenses.subtitle'),
        h(
          'div',
          { class: 'row' },
          monthInput,
          h('button', { class: 'btn', onClick: () => categoryDialog(ctx.refresh) }, '🏷️ ', t('expenses.newCategory')),
          h('button', { class: 'btn primary', onClick: () => window.Components.openExpenseModal({ onSaved: ctx.refresh }) }, '＋ ', t('expenses.new')),
        ),
      );

      const { start, end } = monthBounds(window.App.month || window.UI.todayISO().slice(0, 7));
      let rows = [];
      let categories = [];
      try {
        [rows, categories] = await Promise.all([
          window.API.invoke('expenses:list', { start, end }),
          window.API.invoke('expenses:by-category', { start, end }),
        ]);
      } catch (error) {
        clear(root).append(h('div', { class: 'card error-text' }, errorMessage(error)));
        return;
      }

      const currency = window.App.settings.currency;
      const total = rows.reduce((sum, row) => sum + Number(row.amount), 0);

      clear(root).append(
        h(
          'div',
          { class: 'grid', style: { gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', alignItems: 'start' } },
          h(
            'div',
            { class: 'card' },
            h('h2', { class: 'card-title' }, `${t('expenses.period')} : ${formatDate(start)} → ${formatDate(end)}`, h('span', { class: 'badge warn' }, t('reports.expenseCount', { n: rows.length }))),
            rows.length === 0
              ? emptyState(t('expenses.none'), '💸')
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
                        h('th', {}, t('expenses.category')),
                        h('th', {}, t('expenses.label')),
                        h('th', {}, t('common.amount')),
                        h('th', { class: 'actions' }, ''),
                      ),
                    ),
                    h(
                      'tbody',
                      {},
                      rows.map((row) =>
                        h(
                          'tr',
                          {},
                          h('td', {}, formatDate(row.day)),
                          h('td', {}, window.App.language === 'ar' ? row.category_ar : row.category_fr),
                          h('td', { class: 'muted' }, row.label || '—'),
                          h('td', { class: 'num strong' }, formatMoney(row.amount, currency)),
                          h(
                            'td',
                            { class: 'actions' },
                            h('button', { class: 'btn icon sm', title: t('common.edit'), onClick: () => window.Components.openExpenseModal({ expense: row, onSaved: ctx.refresh }) }, '✏️'),
                            h(
                              'button',
                              {
                                class: 'btn icon sm',
                                title: t('common.delete'),
                                onClick: async () => {
                                  const ok = await window.UI.confirmDialog(t('expenses.deleteConfirm'));
                                  if (!ok) return;
                                  try {
                                    await window.API.invoke('expenses:remove', { id: row.id });
                                    toast(t('common.deleted'), 'ok');
                                    ctx.refresh();
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
          h(
            'div',
            { class: 'col' },
            h(
              'div',
              { class: 'card kpi' },
              h('div', { class: 'label' }, t('expenses.total')),
              h('div', { class: 'value expense' }, formatMoney(total, currency)),
              h('div', { class: 'foot' }, `${t('reports.expenseCount', { n: rows.length })}`),
            ),
            h(
              'div',
              { class: 'card' },
              h('h2', { class: 'card-title' }, t('expenses.byCategory')),
              categories.length === 0
                ? h('div', { class: 'muted small' }, t('expenses.none'))
                : h(
                    'div',
                    { class: 'col' },
                    categories.map((category) =>
                      h(
                        'div',
                        { class: 'row between' },
                        h('span', {}, window.App.language === 'ar' ? category.name_ar : category.name_fr),
                        h('strong', { class: 'num' }, formatMoney(category.total, currency)),
                      ),
                    ),
                  ),
            ),
          ),
        ),
      );
    },
  };
})();
