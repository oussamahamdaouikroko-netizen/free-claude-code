# Payment Engine — BaridiMob Workflow (Part 5)

## Reality check
BaridiMob is a manual transfer app. **There is no public API to automatically
verify that money was received.** Central therefore implements a secure
manual-verification workflow and never invents a payment API.

## Workflow
1. Patient books → system calculates the fee and generates `MR-YYYY-NNNNNN`.
2. System shows the **verified recipient** details (Admin → Settings →
   `baridimob_recipient`) with copy buttons.
3. Patient opens BaridiMob independently and transfers the exact amount.
4. Patient returns to Medirdv and submits the **transaction reference**
   (+ optional receipt photo/PDF, validated by type/size/magic bytes).
5. Payment → `under_verification`. Booking → `payment_verification`.
6. An authorized **Payment Verifier** (or Super Admin) checks the actual
   receipt of funds in BaridiMob and clicks Verify / Reject with notes.
7. `paid` → booking advances to `pending_doctor_approval` and the doctor is
   notified. `rejected` → patient is notified with the reason and can retry.

**A screenshot is not proof of payment.** Payments are never marked Paid
from a receipt alone — only a human verifier confirming receipt of funds.

## Policies (per doctor)
- `baridimob` — prepay via BaridiMob instructions (default).
- `cash_at_clinic` — pay in cash at the clinic; booking goes straight to
  doctor approval.
- `free` — no payment required.

## Protections
- `txn_ref` is unique at DB level — duplicates are rejected (409).
- Double submission of the same payment is rejected.
- Every transition writes to `payment_audit_logs` (who, what, when, notes).
- Refunds: `paid` → `refunded` with audit entry.
- Receipts stored under `data/receipts/` with random names; never served
  publicly (admin views them via the dashboard after auth).

## Future methods
`payment_methods` table reserves `baridi_pay`, `cib`, `edahabia`. When an
official merchant API becomes available and authorized, implement it as a
new verifier behind the same audit trail — do not fake it meanwhile.
