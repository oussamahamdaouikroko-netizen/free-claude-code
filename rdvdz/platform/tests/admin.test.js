/**
 * Administration, branches et console opérateur : contrôle des rôles,
 * périmètre des branches, création de personnel, vérification des médecins,
 * réglages protégés, journal d'audit et espace « mon compte ».
 */

import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  teardown,
  call,
  registerPatient,
  registerDoctor,
  loginWith,
  createAdmin,
  createVerifiedDoctorWithSlots,
  uniquePhone,
} from './helpers.js';
import { db, many, one } from '../src/db.js';
import { clearAll as clearRateLimits } from '../src/lib/rate-limit.js';

let fixture;

test.before(async () => {
  await setup();
  fixture = await createVerifiedDoctorWithSlots({ slotCount: 4, fee: 2000 });
});

test.after(async () => {
  await teardown();
});

test.beforeEach(() => clearRateLimits());

/** Crée une branche et renvoie son id. */
async function createBranch(admin, code) {
  const response = await call('POST', '/api/v1/branches', {
    token: admin.token,
    csrf: admin.csrf,
    body: { code, name: `Branche ${code}`, wilaya_code: 16, phone: '0550111222' },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.branch.id;
}

/** Crée un membre du personnel via l'API d'administration. */
async function createStaff(admin, role, branchId = null) {
  const phone = uniquePhone();
  const response = await call('POST', '/api/v1/admin/staff', {
    token: admin.token,
    csrf: admin.csrf,
    body: {
      full_name: `Agent ${role}`,
      phone,
      role,
      password: 'MotDePasse#2026',
      locale: 'fr',
      ...(branchId ? { branch_id: branchId } : {}),
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const session = await loginWith(phone);
  return { ...session, phone };
}

/* ------------------------------- accès refusés ---------------------------- */

test('les routes d\'administration sont fermées aux patients, médecins et opérateurs', async () => {
  const patient = await registerPatient();
  for (const url of ['/api/v1/admin/overview', '/api/v1/admin/users', '/api/v1/admin/audit-logs']) {
    const response = await call('GET', url, { token: patient.token });
    assert.equal(response.status, 403, url);
  }

  const doctor = await loginWith(fixture.doctorPhone);
  const asDoctor = await call('GET', '/api/v1/admin/users', { token: doctor.token });
  assert.equal(asDoctor.status, 403);

  const operator = await createAdmin('OPERATOR');
  const asOperator = await call('GET', '/api/v1/admin/users', { token: operator.token });
  assert.equal(asOperator.status, 403, 'un opérateur n\'administre pas les comptes');

  const anonymous = await call('GET', '/api/v1/admin/users');
  assert.equal(anonymous.status, 401);
});

test('un opérateur peut consulter le tableau de bord mais pas créer une branche', async () => {
  const operator = await createAdmin('OPERATOR');
  const dashboard = await call('GET', '/api/v1/ops/dashboard', { token: operator.token });
  assert.equal(dashboard.status, 200);

  const create = await call('POST', '/api/v1/branches', {
    token: operator.token,
    csrf: operator.csrf,
    body: { code: 'OPS', name: 'Interdit', wilaya_code: 16 },
  });
  assert.equal(create.status, 403);
});

test('le médecin ne peut pas modifier ses propres vérifications', async () => {
  const doctor = await loginWith(fixture.doctorPhone);
  const response = await call('POST', `/api/v1/admin/doctors/${fixture.doctorId}/verify`, {
    token: doctor.token,
    csrf: doctor.csrf,
    body: {},
  });
  assert.equal(response.status, 403);
});

/* -------------------------------- vue d'ensemble -------------------------- */

test('la vue d\'ensemble expose des compteurs et aucun nom de patient', async () => {
  const admin = await createAdmin('ADMIN');
  const response = await call('GET', '/api/v1/admin/overview', { token: admin.token });
  assert.equal(response.status, 200);
  assert.ok(Number.isInteger(response.body.patients));
  assert.ok(response.body.doctors.total >= 1);
  assert.ok(response.body.doctors.verified >= 1);
  assert.equal(typeof response.body.conversion.rate, 'number');
  assert.ok(response.body.revenue);

  const raw = JSON.stringify(response.body);
  assert.equal(/full_name|phone|symptom|diagnos/i.test(raw), false, 'aucune donnée personnelle dans l\'agrégat');
});

test('une période invalide renvoie 422 et non 500', async () => {
  const admin = await createAdmin('ADMIN');
  const response = await call('GET', '/api/v1/admin/overview?from=2026-05-01&to=2026-01-01', {
    token: admin.token,
  });
  assert.equal(response.status, 422);
});

/* --------------------------------- personnel ----------------------------- */

test('la création de personnel promeut un compte sans laisser de profil patient', async () => {
  const admin = await createAdmin('SUPER_ADMIN');
  const branchId = await createBranch(admin, `BR-${Date.now() % 100000}`);
  const staff = await createStaff(admin, 'OPERATOR', branchId);

  const row = await one('SELECT id, role, status FROM users WHERE id = $1', [staff.user.id]);
  assert.equal(row.role, 'OPERATOR');
  assert.equal(row.status, 'ACTIVE');

  const orphan = await many('SELECT id FROM patients WHERE user_id = $1', [row.id]);
  assert.equal(orphan.length, 0, 'aucun profil patient résiduel');

  const linked = await many('SELECT branch_id FROM branch_operators WHERE user_id = $1', [row.id]);
  assert.equal(linked.length, 1);
  assert.equal(linked[0].branch_id, branchId);

  const scoped = await many('SELECT branch_id FROM user_scopes WHERE user_id = $1', [row.id]);
  assert.equal(scoped.length, 1, 'le périmètre de données est bien posé');

  const traces = await many(`SELECT action FROM audit_logs WHERE entity_id = $1`, [row.id]);
  assert.ok(traces.some((t) => t.action === 'staff.created'));
});

test('un rôle interne ne peut pas être créé par l\'inscription publique', async () => {
  const response = await call('POST', '/api/v1/auth/register', {
    body: {
      fullName: 'Faux Admin',
      phone: uniquePhone(),
      password: 'MotDePasse#2026',
      role: 'OPERATOR',
      consent: true,
    },
  });
  assert.equal(response.status, 422);
});

/* ----------------------------- suspensions ------------------------------- */

test('suspendre un compte révoque immédiatement sa session', async () => {
  const admin = await createAdmin('ADMIN');
  const victim = await registerPatient();

  const self = await call('POST', `/api/v1/admin/users/${admin.id}/suspend`, {
    token: admin.token,
    csrf: admin.csrf,
    body: { reason: 'test' },
  });
  assert.equal(self.status, 409);
  assert.equal(self.body.error.code, 'SELF_SUSPEND');

  const suspend = await call('POST', `/api/v1/admin/users/${victim.user.id}/suspend`, {
    token: admin.token,
    csrf: admin.csrf,
    body: { reason: 'fraude suspectée' },
  });
  assert.equal(suspend.status, 200);
  assert.equal(suspend.body.user.status, 'SUSPENDED');

  const after = await call('GET', '/api/v1/me/profile', { token: victim.token });
  assert.equal(after.status, 401, 'le cookie révoqué ne fonctionne plus');

  const sessions = await many('SELECT revoked_at FROM sessions WHERE user_id = $1', [victim.user.id]);
  assert.ok(sessions.every((s) => s.revoked_at), 'toutes les sessions sont révoquées');

  const reactivate = await call('POST', `/api/v1/admin/users/${victim.user.id}/activate`, {
    token: admin.token,
    csrf: admin.csrf,
  });
  assert.equal(reactivate.status, 200);
  assert.equal(reactivate.body.user.status, 'ACTIVE');

  const loginAgain = await loginWith(victim.phone, victim.password);
  assert.ok(loginAgain.token);
});

test('la liste des utilisateurs ne renvoie jamais d\'empreinte de mot de passe', async () => {
  const admin = await createAdmin('ADMIN');
  const response = await call('GET', '/api/v1/admin/users?limit=50', { token: admin.token });
  assert.equal(response.status, 200);
  assert.ok(response.body.items.length >= 1);
  const raw = JSON.stringify(response.body);
  assert.equal(raw.includes('password_hash'), false);
  assert.equal(raw.includes('password_salt'), false);
});

/* --------------------------- vérification médecins ----------------------- */

test('un médecin refusé n\'est pas publiable, un médecin vérifié l\'est', async () => {
  const admin = await createAdmin('ADMIN');
  const first = await registerDoctor({ fullName: 'Dr Refusé' });
  const second = await registerDoctor({ fullName: 'Dr Accepté' });

  const pending = await call('GET', '/api/v1/admin/doctors/pending', { token: admin.token });
  assert.equal(pending.status, 200);
  const ids = pending.body.items.map((item) => item.id);
  assert.ok(ids.length >= 2);

  const rejected = await call('POST', `/api/v1/admin/doctors/${first.userId}/reject`, {
    token: admin.token,
    csrf: admin.csrf,
    body: {},
  });
  assert.equal(rejected.status, 422, 'un refus doit être motivé');

  const noReason = await call('POST', `/api/v1/admin/doctors/${first.userId}/reject`, {
    token: admin.token,
    csrf: admin.csrf,
    body: { note: 'Numéro d\'ordre introuvable' },
  });
  assert.equal(noReason.status, 404, 'l\'identifiant attendu est celui du docteur, pas de l\'utilisateur');

  const doctorRow = await one('SELECT id FROM doctors WHERE user_id = $1', [first.userId]);
  const ok = await call('POST', `/api/v1/admin/doctors/${doctorRow.id}/reject`, {
    token: admin.token,
    csrf: admin.csrf,
    body: { note: 'Numéro d\'ordre introuvable' },
  });
  assert.equal(ok.status, 200);

  const secondRow = await one('SELECT id FROM doctors WHERE user_id = $1', [second.userId]);
  const verify = await call('POST', `/api/v1/admin/doctors/${secondRow.id}/verify`, {
    token: admin.token,
    csrf: admin.csrf,
    body: { note: 'dossier complet' },
  });
  assert.equal(verify.status, 200);

  const verified = await one('SELECT verified_at, rejected_at FROM doctors WHERE id = $1', [secondRow.id]);
  assert.ok(verified.verified_at);
  assert.equal(verified.rejected_at, null);

  const stillPending = await call('GET', '/api/v1/admin/doctors/pending', { token: admin.token });
  assert.equal(
    stillPending.body.items.some((item) => item.id === secondRow.id),
    false,
    'un médecin vérifié sort de la file d\'attente',
  );
});

/* --------------------------------- cliniques ----------------------------- */

test('une clinique créée par un administrateur est traçable et vérifiable', async () => {
  const admin = await createAdmin('ADMIN');
  const created = await call('POST', '/api/v1/admin/clinics', {
    token: admin.token,
    csrf: admin.csrf,
    body: {
      name_fr: 'Clinique El Oued',
      name_ar: 'عيادة الوادي',
      kind: 'MEDICAL',
      wilaya_code: 39,
      commune: 'El Oued',
      address: 'Rue du marché',
      phone: '0550333444',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const clinicId = created.body.clinic.id;

  const verified = await call('POST', `/api/v1/admin/clinics/${clinicId}/verify`, {
    token: admin.token,
    csrf: admin.csrf,
  });
  assert.equal(verified.status, 200);
  assert.ok(verified.body.clinic.verified_at);

  const publicView = await call('GET', `/api/v1/clinics/${clinicId}`);
  assert.equal(publicView.status, 200);
  assert.equal(publicView.body.clinic.name_ar, 'عيادة الوادي');

  const traces = await many(`SELECT action FROM audit_logs WHERE entity_id = $1`, [clinicId]);
  assert.ok(traces.some((t) => t.action === 'clinic.verified'));
});

/* --------------------------------- réglages ------------------------------ */

test('seules les clés publiques peuvent être modifiées', async () => {
  const admin = await createAdmin('ADMIN');

  const forbidden = await call('PUT', '/api/v1/admin/settings/app.secret', {
    token: admin.token,
    csrf: admin.csrf,
    body: { value: 'x' },
  });
  assert.equal(forbidden.status, 422);

  const ok = await call('PUT', '/api/v1/admin/settings/public.booking', {
    token: admin.token,
    csrf: admin.csrf,
    body: { value: { hold_ttl_minutes: 12 } },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.setting.value.hold_ttl_minutes, 12);

  const settings = await call('GET', '/api/v1/admin/settings', { token: admin.token });
  assert.ok(settings.body.items.some((item) => item.key === 'public.booking'));

  const traces = await many(`SELECT action FROM audit_logs WHERE action = 'settings.updated'`);
  assert.ok(traces.length >= 1);

  // On restaure la valeur initiale pour ne pas polluer les autres tests.
  await call('PUT', '/api/v1/admin/settings/public.booking', {
    token: admin.token,
    csrf: admin.csrf,
    body: { value: { hold_ttl_minutes: 10 } },
  });
});

/* ------------------------------ journal d'audit -------------------------- */

test('le journal d\'audit est filtrable, paginé et en lecture seule', async () => {
  const admin = await createAdmin('ADMIN');
  const response = await call('GET', '/api/v1/admin/audit-logs?limit=10', { token: admin.token });
  assert.equal(response.status, 200);
  assert.ok(response.body.items.length >= 1);
  const entry = response.body.items[0];
  assert.ok(entry.action);
  assert.ok(entry.created_at);

  const filtered = await call('GET', '/api/v1/admin/audit-logs?action=user.suspended', { token: admin.token });
  assert.equal(filtered.status, 200);
  assert.ok(filtered.body.items.every((item) => item.action === 'user.suspended'));

  const write = await call('POST', '/api/v1/admin/audit-logs', {
    token: admin.token,
    csrf: admin.csrf,
    body: { action: 'faux' },
  });
  assert.equal(write.status, 404, 'aucune route d\'écriture sur le journal');
});

/* ---------------------------------- branches ----------------------------- */

test('un opérateur ne voit et n\'administre que sa branche', async () => {
  const admin = await createAdmin('SUPER_ADMIN');
  const branchA = await createBranch(admin, `A-${Date.now() % 100000}`);
  const branchB = await createBranch(admin, `B-${Date.now() % 100000}`);
  const operator = await createStaff(admin, 'OPERATOR', branchA);

  const list = await call('GET', '/api/v1/branches', { token: operator.token });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items.map((b) => b.id), [branchA]);

  const forbidden = await call('GET', `/api/v1/branches/${branchB}/performance`, {
    token: operator.token,
  });
  assert.equal(forbidden.status, 403);

  const own = await call('GET', `/api/v1/branches/${branchA}/performance`, { token: operator.token });
  assert.equal(own.status, 200);

  const dashboard = await call('GET', '/api/v1/ops/dashboard', { token: operator.token });
  assert.equal(dashboard.status, 200);
  assert.ok(dashboard.body.bookings);
});

test('un opérateur sans branche reçoit un tableau de bord vide explicite', async () => {
  const operator = await createAdmin('OPERATOR');
  const dashboard = await call('GET', '/api/v1/ops/dashboard', { token: operator.token });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.bookings.total, 0);
  assert.ok(dashboard.body.warning);

  const bookings = await call('GET', '/api/v1/bookings?limit=10', { token: operator.token });
  assert.equal(bookings.status, 200);
  assert.equal(bookings.body.items.length, 0, 'aucune réservation hors périmètre');
});

/* ------------------------- console opérateur : patients ------------------ */

test('un opérateur crée un patient au guichet sans compte, sans doublon', async () => {
  const admin = await createAdmin('ADMIN');
  const branchId = await createBranch(admin, `C-${Date.now() % 100000}`);
  const operator = await createStaff(admin, 'OPERATOR', branchId);
  const phone = uniquePhone();

  const created = await call('POST', '/api/v1/ops/patients', {
    token: operator.token,
    csrf: operator.csrf,
    body: { full_name: 'Patiente Guichet', phone: `0${phone.slice(1)}`, wilaya_code: 39, commune: 'El Oued' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.created, true);
  const patientId = created.body.patient.id;

  const twice = await call('POST', '/api/v1/ops/patients', {
    token: operator.token,
    csrf: operator.csrf,
    body: { full_name: 'Patiente Guichet', phone, wilaya_code: 39 },
  });
  assert.equal(twice.status, 200);
  assert.equal(twice.body.created, false);
  assert.equal(twice.body.patient.id, patientId, 'le même numéro ramène le même dossier');

  const search = await call('GET', '/api/v1/ops/patients?q=Guichet', { token: operator.token });
  assert.equal(search.status, 200);
  assert.ok(search.body.items.some((p) => p.id === patientId));
  const keys = Object.keys(search.body.items[0]).sort();
  assert.deepEqual(keys, ['commune', 'created_at', 'full_name', 'id', 'phone', 'wilaya_code'], 'identité seule');
});

test('un patient sans compte peut être inscrit au guichet puis payé en espèces', async () => {
  const admin = await createAdmin('ADMIN');
  const branchId = await createBranch(admin, `D-${Date.now() % 100000}`);
  const operator = await createStaff(admin, 'OPERATOR', branchId);
  const doctor = await createVerifiedDoctorWithSlots({ slotCount: 2, fee: 2000 });
  await call('POST', `/api/v1/branches/${branchId}/doctors`, {
    token: admin.token,
    csrf: admin.csrf,
    body: { doctor_id: doctor.doctorId, commission_pct: 10 },
  });

  const patient = await call('POST', '/api/v1/ops/patients', {
    token: operator.token,
    csrf: operator.csrf,
    body: { full_name: 'Patient Sans Compte', phone: uniquePhone(), wilaya_code: 16 },
  });

  const booking = await call('POST', '/api/v1/ops/bookings', {
    token: operator.token,
    csrf: operator.csrf,
    body: { slot_id: doctor.slots[0].id, patient_id: patient.body.patient.id, branch_id: branchId },
  });
  assert.equal(booking.status, 201, JSON.stringify(booking.body));
  assert.equal(booking.body.appointment.status, 'AWAITING_PAYMENT');
  assert.equal(booking.body.payment_required, true);

  const record = await call('POST', `/api/v1/ops/bookings/${booking.body.appointment.id}/payment-record`, {
    token: operator.token,
    csrf: operator.csrf,
    body: { receipt_ref: 'CAISSE-001' },
  });
  assert.equal(record.status, 200, JSON.stringify(record.body));
  assert.equal(record.body.verification, 'MANUAL');

  const appointment = await one('SELECT status, branch_id FROM appointments WHERE id = $1', [
    booking.body.appointment.id,
  ]);
  assert.ok(['PAID', 'CONFIRMED'].includes(appointment.status));
  assert.equal(appointment.branch_id, branchId);

  const slot = await one('SELECT status FROM doctor_slots WHERE id = $1', [doctor.slots[0].id]);
  assert.equal(slot.status, 'BOOKED');
});

test('un opérateur ne peut pas réserver sur une branche hors de son périmètre', async () => {
  const admin = await createAdmin('SUPER_ADMIN');
  const branchA = await createBranch(admin, `E-${Date.now() % 100000}`);
  const branchB = await createBranch(admin, `F-${Date.now() % 100000}`);
  const operator = await createStaff(admin, 'OPERATOR', branchA);
  const patient = await call('POST', '/api/v1/ops/patients', {
    token: operator.token,
    csrf: operator.csrf,
    body: { full_name: 'Patient Périmètre', phone: uniquePhone(), wilaya_code: 16 },
  });

  const response = await call('POST', '/api/v1/ops/bookings', {
    token: operator.token,
    csrf: operator.csrf,
    body: { slot_id: fixture.slots[0].id, patient_id: patient.body.patient.id, branch_id: branchB },
  });
  assert.equal(response.status, 403);
});

test('l\'affectation d\'un opérateur à une branche est tracée et révocable', async () => {
  const admin = await createAdmin('SUPER_ADMIN');
  const branchId = await createBranch(admin, `G-${Date.now() % 100000}`);
  const target = await createAdmin('OPERATOR');

  const assign = await call('POST', `/api/v1/branches/${branchId}/operators`, {
    token: admin.token,
    csrf: admin.csrf,
    body: { user_id: target.id },
  });
  assert.equal(assign.status, 201);

  const duplicate = await call('POST', `/api/v1/branches/${branchId}/operators`, {
    token: admin.token,
    csrf: admin.csrf,
    body: { user_id: target.id },
  });
  assert.equal(duplicate.status, 201, 'l\'affectation est idempotente');

  const visible = await call('GET', '/api/v1/branches', { token: target.token });
  assert.equal(visible.body.items.length, 1);

  const remove = await call('DELETE', `/api/v1/branches/${branchId}/operators/${target.id}`, {
    token: admin.token,
    csrf: admin.csrf,
  });
  assert.equal(remove.status, 200);

  const after = await call('GET', '/api/v1/branches', { token: target.token });
  assert.equal(after.body.items.length, 0);
});

/* ------------------------------- mon compte ------------------------------ */

test('le profil « mon compte » est lisible et rectifiable', async () => {
  const patient = await registerPatient({ fullName: 'Nom Initial' });

  const profile = await call('GET', '/api/v1/me/profile', { token: patient.token });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.user.phone, patient.phone);
  assert.equal(profile.body.patient.id, patient.patientId);

  const update = await call('PUT', '/api/v1/me/profile', {
    token: patient.token,
    csrf: patient.csrf,
    body: { full_name: 'Nom Corrigé', wilaya_code: 39, commune: 'Guemar', locale: 'ar' },
  });
  assert.equal(update.status, 200);

  const after = await call('GET', '/api/v1/me/profile', { token: patient.token });
  assert.equal(after.body.user.full_name, 'Nom Corrigé');
  assert.equal(after.body.user.locale, 'ar');
  assert.equal(after.body.patient.commune, 'Guemar');

  const traces = await many(`SELECT action FROM audit_logs WHERE entity_id = $1`, [patient.user.id]);
  assert.ok(traces.length >= 1, 'la rectification est tracée');
});

test('les disponibilités du médecin sont remplacées atomiquement', async () => {
  const doctor = await loginWith(fixture.doctorPhone);

  const put = await call('PUT', '/api/v1/me/availability', {
    token: doctor.token,
    csrf: doctor.csrf,
    body: {
      hours: [
        { weekday: 0, opens: '08:00', closes: '12:00' },
        { weekday: 2, opens: '13:00', closes: '17:00', break_start: '15:00', break_end: '15:30' },
      ],
    },
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  const read = await call('GET', '/api/v1/me/availability', { token: doctor.token });
  assert.equal(read.body.hours.length, 2);
  assert.equal(read.body.hours[0].weekday, 0);

  const replace = await call('PUT', '/api/v1/me/availability', {
    token: doctor.token,
    csrf: doctor.csrf,
    body: { hours: [{ weekday: 1, opens: '09:00', closes: '11:00' }] },
  });
  assert.equal(replace.status, 200);

  const after = await call('GET', '/api/v1/me/availability', { token: doctor.token });
  assert.equal(after.body.hours.length, 1, 'remplacement complet, pas de fusion');
  assert.equal(after.body.hours[0].weekday, 1);

  const invalid = await call('PUT', '/api/v1/me/availability', {
    token: doctor.token,
    csrf: doctor.csrf,
    body: { hours: 'lundi' },
  });
  assert.equal(invalid.status, 422);
});

test('une indisponibilité bloque les créneaux et sa suppression les rouvre', async () => {
  const doctor = await loginWith(fixture.doctorPhone);
  const slot = await one(
    `INSERT INTO doctor_slots (doctor_id, starts_at, ends_at, mode, status)
     VALUES ($1, now() + interval '20 days', now() + interval '20 days 20 minutes', 'IN_CLINIC', 'OPEN')
     RETURNING id`,
    [fixture.doctorId],
  );

  const timeOff = await call('POST', '/api/v1/me/time-off', {
    token: doctor.token,
    csrf: doctor.csrf,
    body: {
      starts_at: new Date(Date.now() + 19 * 86400000).toISOString(),
      ends_at: new Date(Date.now() + 21 * 86400000).toISOString(),
      reason: 'congé',
    },
  });
  assert.equal(timeOff.status, 201, JSON.stringify(timeOff.body));

  const blocked = await one('SELECT status FROM doctor_slots WHERE id = $1', [slot.id]);
  assert.equal(blocked.status, 'BLOCKED');

  const remove = await call('DELETE', `/api/v1/me/time-off/${timeOff.body.time_off.id}`, {
    token: doctor.token,
    csrf: doctor.csrf,
  });
  assert.equal(remove.status, 200);

  const reopened = await one('SELECT status FROM doctor_slots WHERE id = $1', [slot.id]);
  assert.equal(reopened.status, 'OPEN');
});

test('une indisponibilité mal bornée est refusée', async () => {
  const doctor = await loginWith(fixture.doctorPhone);
  const response = await call('POST', '/api/v1/me/time-off', {
    token: doctor.token,
    csrf: doctor.csrf,
    body: {
      starts_at: new Date(Date.now() + 3 * 86400000).toISOString(),
      ends_at: new Date(Date.now() + 2 * 86400000).toISOString(),
    },
  });
  assert.equal(response.status, 422);
});

test('un patient ne peut pas modifier les disponibilités d\'un médecin', async () => {
  const patient = await registerPatient();
  const response = await call('PUT', '/api/v1/me/availability', {
    token: patient.token,
    csrf: patient.csrf,
    body: { hours: [] },
  });
  assert.equal(response.status, 403);
});

test('les notifications : lecture, marquage et préférences', async () => {
  const patient = await registerPatient();

  const list = await call('GET', '/api/v1/notifications', { token: patient.token });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.items));

  const preference = await call('PUT', '/api/v1/notifications/preferences', {
    token: patient.token,
    csrf: patient.csrf,
    body: { event_code: 'booking.reminder', channel: 'WHATSAPP', enabled: false },
  });
  assert.equal(preference.status, 200);

  const preferences = await call('GET', '/api/v1/notifications/preferences', {
    token: patient.token,
  });
  const reminder = preferences.body.items.find(
    (item) => item.event_code === 'booking.reminder' && item.channel === 'WHATSAPP',
  );
  assert.equal(reminder.enabled, false, 'le refus du canal est enregistré');

  const bad = await call('PUT', '/api/v1/notifications/preferences', {
    token: patient.token,
    csrf: patient.csrf,
    body: { event_code: 'booking.reminder', channel: 'TELEGRAM', enabled: true },
  });
  assert.equal(bad.status, 422);

  const readAll = await call('POST', '/api/v1/notifications/read-all', {
    token: patient.token,
    csrf: patient.csrf,
  });
  assert.equal(readAll.status, 200);
});

test('l\'export de mes données est un fichier JSON téléchargeable', async () => {
  const patient = await registerPatient();
  const response = await call('GET', '/api/v1/me/export', { token: patient.token });
  assert.equal(response.status, 200);
  assert.match(response.headers['content-disposition'], /attachment/);
  assert.equal(response.body.user.id, patient.user.id);
  const raw = JSON.stringify(response.body);
  assert.equal(raw.includes('password_hash'), false);
});
