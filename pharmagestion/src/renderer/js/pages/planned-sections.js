/* Registrations for the sections that are not implemented yet.
 *
 * They use the shared `planned` factory so every one of them explains, in the
 * chosen language, what it will do and why it matters. This keeps the
 * navigation real (all ten sections are reachable) while never showing a fake
 * table or a button that silently does nothing.
 */
(function () {
  'use strict';

  const Pages = window.Pages;

  const sections = [
    {
      page: 'stock',
      titleKey: 'nav.stock',
      phase: 2,
      points: ['plan.stock.1', 'plan.stock.2', 'plan.stock.3', 'plan.stock.4'],
      whyKey: 'plan.stock.why',
    },
    {
      page: 'purchases',
      titleKey: 'nav.purchases',
      phase: 3,
      points: ['plan.purchases.1', 'plan.purchases.2', 'plan.purchases.3', 'plan.purchases.4'],
      whyKey: 'plan.purchases.why',
    },
    {
      page: 'sales',
      titleKey: 'nav.sales',
      phase: 3,
      points: ['plan.sales.1', 'plan.sales.2', 'plan.sales.3', 'plan.sales.4'],
      whyKey: 'plan.sales.why',
    },
    {
      page: 'customer_debts',
      titleKey: 'nav.customer_debts',
      phase: 3,
      points: [
        'plan.customer_debts.1',
        'plan.customer_debts.2',
        'plan.customer_debts.3',
        'plan.customer_debts.4',
      ],
      whyKey: 'plan.customer_debts.why',
    },
    {
      page: 'supplier_debts',
      titleKey: 'nav.supplier_debts',
      phase: 3,
      points: [
        'plan.supplier_debts.1',
        'plan.supplier_debts.2',
        'plan.supplier_debts.3',
        'plan.supplier_debts.4',
      ],
      whyKey: 'plan.supplier_debts.why',
    },
    {
      page: 'expiry',
      titleKey: 'nav.expiry',
      phase: 2,
      points: ['plan.expiry.1', 'plan.expiry.2', 'plan.expiry.3', 'plan.expiry.4'],
      whyKey: 'plan.expiry.why',
    },
    {
      page: 'import_export',
      titleKey: 'nav.import_export',
      phase: 4,
      points: [
        'plan.import_export.1',
        'plan.import_export.2',
        'plan.import_export.3',
        'plan.import_export.4',
      ],
      whyKey: 'plan.import_export.why',
    },
    {
      page: 'reports',
      titleKey: 'nav.reports',
      phase: 5,
      points: ['plan.reports.1', 'plan.reports.2', 'plan.reports.3', 'plan.reports.4'],
      whyKey: 'plan.reports.why',
    },
  ];

  for (const section of sections) {
    Pages[section.page] = Pages.planned(section);
  }
})();
