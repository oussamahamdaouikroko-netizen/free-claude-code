'use strict';
/* Medirdv Central admin dashboard — vanilla JS, calls /api/admin/*. */
const $ = (id) => document.getElementById(id);

/** Escape untrusted text before templating (XSS defence in depth). */
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

let currentTab = 'dashboard';

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || 'Erreur');
  return data;
}

async function boot() {
  const { user } = await api('/api/auth/me');
  if (!user) { $('login-view').classList.remove('hidden'); $('app-view').classList.add('hidden'); return; }
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  render();
}

async function render() {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === currentTab));
  const content = $('content');
  content.innerHTML = '<p>Chargement…</p>';
  try {
    if (currentTab === 'dashboard') content.innerHTML = await dashboardHtml();
    else if (currentTab === 'doctors') content.innerHTML = await doctorsHtml();
    else if (currentTab === 'clinics') content.innerHTML = await clinicsHtml();
    else if (currentTab === 'appointments') content.innerHTML = await appointmentsHtml();
    else if (currentTab === 'payments') content.innerHTML = await paymentsHtml();
    else if (currentTab === 'whatsapp') content.innerHTML = await whatsappHtml();
    else if (currentTab === 'analytics') content.innerHTML = await analyticsHtml();
    bindTabActions();
  } catch (error) {
    content.innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}

async function dashboardHtml() {
  const s = await api('/api/admin/dashboard');
  const stat = (num, label) => `<div class="stat"><div class="num">${num}</div><div class="label">${label}</div></div>`;
  return `
    <h2>Tableau de bord</h2>
    <div class="stats">
      ${stat(s.doctors_total, 'Médecins')} ${stat(s.doctors_active, 'Médecins actifs')}
      ${stat(s.clinics_total, 'Cliniques')} ${stat(s.patients_total, 'Patients')}
      ${stat(s.bookings_today, 'Réservations aujourd’hui')} ${stat(s.bookings_pending, 'En attente')}
      ${stat(s.bookings_confirmed, 'Confirmées')} ${stat(s.bookings_cancelled, 'Annulées')}
      ${stat(s.payments_pending, 'Paiements en attente')} ${stat(s.payments_paid, 'Paiements vérifiés')}
      ${stat(`${s.collected_dzd} DZD`, 'Encaissé')}
    </div>
    <div class="card"><h3>WhatsApp</h3>${s.whatsapp.map((w) => `<p>${esc(w.full_name)} — <span class="badge">${esc(w.mode)} / ${esc(w.status)}</span></p>`).join('') || '<p class="muted">Aucun compte.</p>'}</div>
    <div class="card"><h3>Activité récente</h3>${s.recent_activity.map((a) => `<p class="muted">${esc(a.created_at)} · ${esc(a.action)} · ${esc(a.entity)} ${esc(a.entity_id)}</p>`).join('')}</div>`;
}

async function doctorsHtml() {
  const { doctors } = await api('/api/admin/doctors');
  return `
    <h2>Médecins</h2>
    <div class="card"><form class="grid" id="doctor-form">
      <input name="full_name" placeholder="Nom complet" required>
      <input name="specialty_text" placeholder="Spécialité (texte)">
      <input name="phone" placeholder="Téléphone">
      <input name="whatsapp_number" placeholder="WhatsApp">
      <input name="consultation_fee" type="number" placeholder="Frais (DZD)">
      <button type="submit">Ajouter</button>
    </form></div>
    <table><thead><tr><th>Réf</th><th>Nom</th><th>Spécialité</th><th>Statut</th><th>WhatsApp</th><th>Actions</th></tr></thead>
    <tbody>${doctors.map((d) => `<tr>
      <td>${esc(d.public_ref)}</td><td>${esc(d.full_name)}</td><td>${esc(d.specialty ? d.specialty.name_fr : d.specialty_text)}</td>
      <td><span class="badge">${esc(d.status)}</span></td><td>${esc(d.whatsapp.mode)} / ${esc(d.whatsapp.status)}</td>
      <td>${['active', 'suspended', 'inactive'].map((st) => `<button class="secondary" data-status="${Number(d.id)}:${esc(st)}">${esc(st)}</button>`).join(' ')}</td>
    </tr>`).join('')}</tbody></table>`;
}

async function clinicsHtml() {
  const { clinics } = await api('/api/admin/clinics');
  return `
    <h2>Cliniques</h2>
    <div class="card"><form class="grid" id="clinic-form">
      <input name="name" placeholder="Nom de la clinique" required>
      <input name="wilaya" placeholder="Wilaya"><input name="city" placeholder="Commune">
      <input name="address" placeholder="Adresse"><input name="phone" placeholder="Téléphone">
      <button type="submit">Ajouter</button>
    </form></div>
    <table><thead><tr><th>Nom</th><th>Wilaya</th><th>Commune</th><th>Adresse</th></tr></thead>
    <tbody>${clinics.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.wilaya)}</td><td>${esc(c.city)}</td><td>${esc(c.address)}</td></tr>`).join('')}</tbody></table>`;
}

async function appointmentsHtml() {
  const { appointments } = await api('/api/admin/appointments');
  return `
    <h2>Rendez-vous</h2>
    <table><thead><tr><th>Réf</th><th>Patient</th><th>Date</th><th>Heure</th><th>Statut</th><th>Actions</th></tr></thead>
    <tbody>${appointments.map((a) => `<tr>
      <td>${esc(a.public_ref)}</td><td>${esc(a.patient_name)}</td><td>${esc(a.day)}</td><td>${esc(a.time)}</td>
      <td><span class="badge">${esc(a.status)}</span></td>
      <td><button class="secondary" data-notify="${Number(a.id)}">Notifier (WhatsApp)</button>
      <button class="secondary" data-cancel="${Number(a.id)}">Annuler</button></td>
    </tr>`).join('')}</tbody></table>`;
}

async function paymentsHtml() {
  const { payments } = await api('/api/admin/payments');
  return `
    <h2>Paiements (vérification manuelle BaridiMob)</h2>
    <table><thead><tr><th>Réf</th><th>RDV</th><th>Montant</th><th>Statut</th><th>Réf. transaction</th><th>Actions</th></tr></thead>
    <tbody>${payments.map((p) => `<tr>
      <td>${esc(p.public_ref)}</td><td>${esc(p.appointment_ref)}</td><td>${esc(p.amount)} DZD</td>
      <td><span class="badge">${esc(p.status)}</span></td><td>${esc(p.transaction_ref || '—')}</td>
      <td><button class="secondary" data-verify="${Number(p.id)}:paid">Vérifier (payé)</button>
      <button class="secondary" data-verify="${Number(p.id)}:rejected">Rejeter</button></td>
    </tr>`).join('')}</tbody></table>`;
}

async function whatsappHtml() {
  const { accounts, configured } = await api('/api/admin/whatsapp/accounts');
  return `
    <h2>WhatsApp Hub (API officielle Meta)</h2>
    <p class="muted">Plateforme: ${configured ? 'configurée' : 'NON configurée — mode Click-to-Chat uniquement'}</p>
    <table><thead><tr><th>Médecin</th><th>Numéro</th><th>Mode</th><th>Statut</th><th>Erreur</th></tr></thead>
    <tbody>${accounts.map((a) => `<tr><td>${esc(a.full_name)}</td><td>${esc(a.display_number || '—')}</td><td>${esc(a.mode)}</td><td><span class="badge">${esc(a.status)}</span></td><td>${esc(a.last_error || '')}</td></tr>`).join('')}</tbody></table>
    <div class="card"><button id="retry-failed">Réessayer les messages échoués</button> <span id="retry-result"></span></div>`;
}

async function analyticsHtml() {
  const a = await api('/api/admin/analytics');
  return `
    <h2>Analyses</h2>
    <div class="card"><h3>Réservations par jour</h3>${a.daily.map((d) => `<p>${esc(d.day)} — ${esc(d.n)}</p>`).join('') || '<p class="muted">—</p>'}</div>
    <div class="card"><h3>Par statut</h3>${a.byStatus.map((s) => `<p>${esc(s.status)} — ${esc(s.n)}</p>`).join('')}</div>
    <div class="card"><h3>Spécialités demandées</h3>${a.bySpecialty.map((s) => `<p>${esc(s.specialty)} — ${esc(s.n)}</p>`).join('')}</div>
    <div class="card"><h3>Par wilaya</h3>${a.byWilaya.map((s) => `<p>${esc(s.wilaya)} — ${esc(s.n)}</p>`).join('')}</div>
    <div class="card"><h3>Paiements</h3><p>Encaissé: ${esc(a.paymentStats.collected)} DZD</p>${a.paymentStats.byStatus.map((s) => `<p>${esc(s.status)} — ${esc(s.n)} (${esc(s.total)} DZD)</p>`).join('')}</div>`;
}

function bindTabActions() {
  const doctorForm = $('doctor-form');
  if (doctorForm) doctorForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(doctorForm).entries());
    await api('/api/admin/doctors', { method: 'POST', body: JSON.stringify(body) });
    render();
  });
  const clinicForm = $('clinic-form');
  if (clinicForm) clinicForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(clinicForm).entries());
    await api('/api/admin/clinics', { method: 'POST', body: JSON.stringify(body) });
    render();
  });
  document.querySelectorAll('[data-status]').forEach((btn) => btn.addEventListener('click', async () => {
    const [id, status] = btn.dataset.status.split(':');
    await api(`/api/admin/doctors/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
    render();
  }));
  document.querySelectorAll('[data-notify]').forEach((btn) => btn.addEventListener('click', async () => {
    try { await api(`/api/admin/appointments/${btn.dataset.notify}/notify-doctor`, { method: 'POST' }); alert('Notification envoyée'); }
    catch (e) { alert(e.message); }
  }));
  document.querySelectorAll('[data-cancel]').forEach((btn) => btn.addEventListener('click', async () => {
    await api(`/api/admin/appointments/${btn.dataset.cancel}/cancel`, { method: 'POST' });
    render();
  }));
  document.querySelectorAll('[data-verify]').forEach((btn) => btn.addEventListener('click', async () => {
    const [id, decision] = btn.dataset.verify.split(':');
    const note = prompt('Note de vérification (optionnel):') || '';
    await api(`/api/admin/payments/${id}/verify`, { method: 'POST', body: JSON.stringify({ decision, note }) });
    render();
  }));
  const retry = $('retry-failed');
  if (retry) retry.addEventListener('click', async () => {
    const { results } = await api('/api/admin/whatsapp/retry-failed', { method: 'POST' });
    $('retry-result').textContent = `${results.filter((r) => r.ok).length}/${results.length} réussis`;
  });
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: $('login-email').value, password: $('login-password').value }) });
    $('login-error').textContent = '';
    boot();
  } catch (error) { $('login-error').textContent = error.message; }
});
$('logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); boot(); });
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => { currentTab = b.dataset.tab; render(); }));

boot();
