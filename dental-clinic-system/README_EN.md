# Dental Clinic Management System — 100% Free (Arabic-first)

A simple, professional, Arabic-first (RTL) dental clinic management system for a
clinic in Algeria. **Zero running cost**: Google Sheets as the database and main
interface, Google Apps Script for all automation and calculations, and manual
WhatsApp Business messaging via ready-made click-to-chat links.

The full beginner-friendly guide (installation, usage, privacy, quotas, testing
checklist) is in **[README.md](README.md)** (Arabic). This file is a short
technical summary in English.

## Files (all go into ONE Apps Script project)

| File | Purpose |
|---|---|
| `Code.gs` | Config constants, menu (`إدارة العيادة`), shared helpers, phone normalization |
| `Setup.gs` | `setupSystem()` creates 9 sheets + headers + settings + validations, sample data, Drive backup |
| `Queue.gs` | Patient registration, daily queue (unique per-day queue numbers), search |
| `Finance.gs` | Visits, payments (partial allowed), expenses, aggregate calculations |
| `Inventory.gs` | Items, purchases (auto stock increase), low-stock alerts, negative-stock guard (`onEdit`) |
| `WhatsApp.gs` | 6 Arabic message templates, `wa.me` click-to-chat link builder |
| `Dashboard.gs` | `updateDashboard()` computes every metric from real records; optional web app (`doGet`) |
| `Tests.gs` | `runTests()` — self-test with temporary `TEST-X-` records |
| `Index.html` | Optional web dashboard — aggregates only, **no patient names/phones** |

## Design decisions

- **Arabic UI, English code comments.** All sheet headers, menus, alerts and
  templates are Arabic. All sheets are right-to-left.
- **Dates stored as text** (`yyyy-MM-dd`, `HH:mm`) for reliable filtering and
  timezone independence. Currency is DZD.
- **Income = cash actually received.** Every payment is one row in the
  `الدفعات` sheet; visit balances (`المبلغ المتبقي`) update automatically.
  A treatment's full price is never counted as income until paid.
- **Duplicate-payment protection**: identical same-day payments trigger a
  confirmation dialog (covers double form submission).
- **Inventory purchases vs. expenses (no double counting)**: a Settings toggle
  (`تسجيل مشتريات المخزون تلقائيا في المصروفات`, default `نعم`) auto-records each
  purchase as an expense tagged `[شراء مخزون: ...]`. When ON, staff must not
  record the same purchase manually as an expense.
- **WhatsApp is manual by design.** Automatic sending would require the paid
  WhatsApp Cloud API; unofficial automation risks blocking the clinic's number.
  The system generates `https://wa.me/<number>?text=<encoded Arabic message>`
  links; the user presses Send themselves. Opening the link never sends
  anything automatically.
- **Phone numbers**: Algerian mobile numbers are stored normalized as
  `213XXXXXXXXX` (accepts `0555123456`, `+213555123456`, `00213...`, spaced
  forms; rejects landlines and malformed numbers).
- **Privacy**: the optional web app shows aggregate numbers only (no patient
  names, phones, or medical details — never in URLs). Deploy it with access
  limited to "Only myself / Specific accounts". No patient data is written to
  logs. Backups are full spreadsheet copies into a private Drive folder.

## Quick install

1. Create a Google Sheet → **Extensions → Apps Script**.
2. Paste each file above into project files with matching names
   (`Index` must be an HTML file).
3. Save, reload the sheet, then run **إدارة العيادة → إعداد النظام** and
   authorize.
4. Test with **بيانات تجريبية (للاختبار)** + **تشغيل الاختبارات**, then remove
   samples with **مسح البيانات التجريبية**.

## Free-tier limits (Google Apps Script)

~6 minutes max per execution, ~90 minutes total runtime per day (this system
uses seconds), see
[official quotas](https://developers.google.com/apps-script/guides/services/quotas).
No paid service of any kind is required.

## Running the self-tests

Menu: **إدارة العيادة → تشغيل الاختبارات** (creates temporary `TEST-X-` records,
asserts queue numbering, payment math, duplicate detection, WhatsApp links,
inventory updates, dashboard numbers, then deletes them).
