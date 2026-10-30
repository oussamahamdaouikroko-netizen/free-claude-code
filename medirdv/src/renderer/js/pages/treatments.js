/* Treatment catalog + default prices. */
(function () {
  'use strict';
  const { t, formatMoney } = window.I18N;
  const { h, clear, emptyState, toast, errorMessage, modal, field, input } = window.UI;
  const Pages = window.Pages;

  function editor(treatment, onSaved) {
    const isEdit = Boolean(treatment);
    const nameFr = input({ value: treatment?.name_fr || '', placeholder: 'Échographie cardiaque' });
    const nameAr = input({ value: treatment?.name_ar || '', placeholder: 'إيكوغرافيا القلب', dir: 'rtl' });
    const price = input({ type: 'number', min: '0', step: '100', value: String(treatment?.default_price ?? 0) });
    const priceInsured = input({ type: 'number', min: '0', step: '100', value: String(treatment?.price_insured ?? treatment?.default_price ?? 0) });
    const convRate = input({ type: 'number', min: '0', max: '100', value: String(treatment?.convention_rate ?? 80) });
    const color = input({ type: 'color', value: treatment?.color || '#0066cc', style: { padding: '4px', height: '46px' } });
    const error = h('div', { class: 'error-text' });

    const save = async () => {
      error.textContent = '';
      if (!nameFr.value.trim()) {
        error.textContent = t('error.TREATMENT_NAME_REQUIRED');
        return false;
      }
      try {
        const payload = {
          id: treatment?.id,
          name_fr: nameFr.value.trim(),
          name_ar: nameAr.value.trim(),
          default_price: Number(price.value) || 0,
          price_private: Number(price.value) || 0,
          price_insured: Number(priceInsured.value) || 0,
          convention_rate: Number(convRate.value) || 80,
          color: color.value,
        };
        if (isEdit) await window.API.invoke('treatments:update', payload);
        else await window.API.invoke('treatments:create', payload);
        toast(t('common.saved'), 'ok');
        onSaved();
        return true;
      } catch (err) {
        error.textContent = errorMessage(err);
        return false;
      }
    };

    modal({
      title: isEdit ? t('common.edit') : t('treatments.new'),
      body: h(
        'div',
        { class: 'col' },
        field(t('treatments.nameFr'), nameFr),
        field(t('treatments.nameAr'), nameAr),
        h(
          'div',
          { class: 'grid two' },
          field(`${t('billing.pricePrivate')} (${window.App.settings.currency})`, price),
          field(`${t('billing.priceInsured')} (${window.App.settings.currency})`, priceInsured),
        ),
        h(
          'div',
          { class: 'grid two' },
          field(t('billing.conventionRate'), convRate),
          field(t('treatments.color'), color),
        ),
        error,
      ),
      actions: [
        { label: t('common.cancel'), kind: 'ghost' },
        { label: t('common.save'), kind: 'primary', onClick: async () => (await save()) || false },
      ],
    });
  }

  Pages.treatments = {
    async render(root, ctx) {
      ctx.setHeader(
        t('treatments.title'),
        t('treatments.subtitle'),
        h('button', { class: 'btn primary', onClick: () => editor(null, ctx.refresh) }, '＋ ', t('treatments.new')),
      );

      let rows;
      try {
        rows = await window.API.invoke('treatments:list', { include_inactive: true });
      } catch (error) {
        clear(root).append(h('div', { class: 'card error-text' }, errorMessage(error)));
        return;
      }

      const currency = window.App.settings.currency;
      clear(root).append(
        h(
          'div',
          { class: 'card' },
          rows.length === 0
            ? emptyState(t('reports.noData'), 'stethoscope')
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
                      h('th', {}, ''),
                      h('th', {}, t('treatments.nameFr')),
                      h('th', {}, t('treatments.nameAr')),
                      h('th', {}, t('common.price')),
                      h('th', {}, t('common.status')),
                      h('th', { class: 'actions' }, t('common.actions')),
                    ),
                  ),
                  h(
                    'tbody',
                    {},
                    rows.map((row) =>
                      h(
                        'tr',
                        {},
                        h('td', {}, h('span', { style: { display: 'inline-block', width: '12px', height: '12px', borderRadius: '4px', background: row.color } }, '')),
                        h('td', { class: 'strong' }, row.name_fr),
                        h('td', { dir: 'rtl' }, row.name_ar),
                        h('td', { class: 'num' }, formatMoney(row.default_price, currency)),
                        h(
                          'td',
                          {},
                          row.active
                            ? h('span', { class: 'badge ok' }, '✓')
                            : h('span', { class: 'badge gray' }, t('common.no')),
                        ),
                        h(
                          'td',
                          { class: 'actions' },
                          h('button', { class: 'btn icon sm', title: t('common.edit'), onClick: () => editor(row, ctx.refresh) }, '✏️'),
                          h(
                            'button',
                            {
                              class: 'btn icon sm',
                              title: t('common.delete'),
                              onClick: async () => {
                                const ok = await window.UI.confirmDialog(t('treatments.deleteConfirm', { name: row.name_fr }));
                                if (!ok) return;
                                try {
                                  const result = await window.API.invoke('treatments:remove', { id: row.id });
                                  if (result.deactivated) toast(t('treatments.deactivated'), 'ok');
                                  else toast(t('common.deleted'), 'ok');
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
      );
    },
  };
})();
