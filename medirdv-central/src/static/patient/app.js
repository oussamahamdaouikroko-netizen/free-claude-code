'use strict';
/* Medirdv patient platform — vanilla JS, FR/AR with RTL. No build step. */
const I18N = {
  fr: {
    hero_title: 'Trouvez un médecin et prenez rendez-vous',
    hero_sub: 'Recherchez par spécialité, wilaya ou nom. Réservation simple, paiement BaridiMob vérifié.',
    search_name: 'Nom du médecin…', all_specialties: 'Toutes spécialités', all_wilayas: 'Toutes wilayas',
    available_on: 'Disponible le…', search: 'Rechercher',
    how_title: 'Comment ça marche',
    how_1: 'Choisissez un médecin et un créneau.',
    how_2: 'Payez par BaridiMob et envoyez la référence.',
    how_3: 'Le médecin confirme via WhatsApp.',
    track_title: 'Suivre ma réservation', track: 'Suivre',
    date: 'Date', full_name: 'Nom complet', phone: 'Téléphone (05…)',
    confirm_booking: 'Confirmer la demande', book: 'Réserver',
    no_results: 'Aucun médecin trouvé.', loading: 'Chargement…',
    select_slot: 'Choisissez un créneau', clinic: 'Cabinet',
    payment_title: 'Paiement BaridiMob',
    amount: 'Montant', recipient: 'Destinataire', rib: 'RIB',
    pay_steps: '1. Ouvrez BaridiMob et transférez le montant exact.\n2. Gardez la référence de transaction.\n3. Revenez ici et envoyez la référence + reçu.',
    submit_ref: 'Envoyer la référence', receipt: 'Reçu (JPG/PNG/PDF)',
    whatsapp_open: 'Ouvrir WhatsApp', awaiting: 'En attente de confirmation du médecin.',
    error_generic: 'Une erreur est survenue.',
    offline: 'Connexion impossible. Vérifiez votre réseau.',
    settings: 'Serveur', save: 'Enregistrer', api_base: 'Adresse du serveur Medirdv',
  },
  ar: {
    hero_title: 'ابحث عن طبيب واحجز موعدك',
    hero_sub: 'ابحث بالاختصاص أو الولاية أو الاسم. حجز بسيط ودفع بريدي موب موثّق.',
    search_name: 'اسم الطبيب…', all_specialties: 'كل الاختصاصات', all_wilayas: 'كل الولايات',
    available_on: 'متاح في…', search: 'بحث',
    how_title: 'كيف يعمل؟',
    how_1: 'اختر طبيباً ووقتاً متاحاً.',
    how_2: 'ادفع عبر بريدي موب وأرسل المرجع.',
    how_3: 'يؤكد الطبيب عبر واتساب.',
    track_title: 'تتبع حجزي', track: 'تتبع',
    date: 'التاريخ', full_name: 'الاسم الكامل', phone: 'الهاتف (05…)',
    confirm_booking: 'تأكيد الطلب', book: 'احجز',
    no_results: 'لا يوجد أطباء.', loading: 'جارٍ التحميل…',
    select_slot: 'اختر وقتاً', clinic: 'العيادة',
    payment_title: 'الدفع عبر بريدي موب',
    amount: 'المبلغ', recipient: 'المستلم', rib: 'الحساب',
    pay_steps: '1. افتح بريدي موب وحول المبلغ بالضبط.\n2. احتفظ بمرجع العملية.\n3. عد هنا وأرسل المرجع + الإيصال.',
    submit_ref: 'إرسال المرجع', receipt: 'الإيصال (JPG/PNG/PDF)',
    whatsapp_open: 'فتح واتساب', awaiting: 'بانتظار تأكيد الطبيب.',
    error_generic: 'حدث خطأ.',
    offline: 'تعذر الاتصال. تحقق من الشبكة.',
    settings: 'الخادم', save: 'حفظ', api_base: 'عنوان خادم Medirdv',
  },
};

let lang = localStorage.getItem('medirdv_lang') || 'fr';
let selectedDoctor = null;
let selectedClinic = null;
let selectedSlot = null;
let idempotencyKey = null;

const t = (key) => (I18N[lang] && I18N[lang][key]) || I18N.fr[key] || key;
const $ = (id) => document.getElementById(id);

/**
 * API base URL.
 *  - Web: same origin (empty prefix).
 *  - Android APK: set via <meta name="medirdv-api-base"> by the build script,
 *    overridable at runtime from the app's Settings screen.
 */
function resolveApiBase() {
  const meta = document.querySelector('meta[name="medirdv-api-base"]');
  const saved = localStorage.getItem('medirdv_api_base') || '';
  const base = saved || (meta ? meta.content.trim() : '');
  return base.replace(/\/+$/, '');
}
let apiBase = resolveApiBase();
const apiUrl = (path) => `${apiBase}${path}`;

/** Escape untrusted text before templating (XSS defence in depth). */
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  $('lang-fr').classList.toggle('active', lang === 'fr');
  $('lang-ar').classList.toggle('active', lang === 'ar');
  localStorage.setItem('medirdv_lang', lang);
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(apiUrl(path), { headers: { 'Content-Type': 'application/json' }, ...options });
  } catch {
    throw new Error(t('offline'));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || t('error_generic'));
  return data;
}

async function loadFilters() {
  const [spec, wil] = await Promise.all([api('/api/public/specialties'), api('/api/public/wilayas')]);
  const specSel = $('q-specialty');
  specSel.innerHTML = `<option value="">${t('all_specialties')}</option>` +
    spec.specialties.map((s) => `<option value="${Number(s.id)}">${esc(lang === 'ar' ? s.name_ar : s.name_fr)}</option>`).join('');
  const wilSel = $('q-wilaya');
  wilSel.innerHTML = `<option value="">${t('all_wilayas')}</option>` +
    wil.wilayas.map((w) => `<option value="${esc(w.wilaya)}">${esc(w.wilaya)}</option>`).join('');
}

async function search() {
  const params = new URLSearchParams();
  if ($('q-name').value) params.set('name', $('q-name').value);
  if ($('q-specialty').value) params.set('specialty_id', $('q-specialty').value);
  if ($('q-wilaya').value) params.set('wilaya', $('q-wilaya').value);
  if ($('q-date').value) params.set('available_on', $('q-date').value);
  $('results').innerHTML = `<p>${t('loading')}</p>`;
  const { doctors } = await api(`/api/public/doctors?${params}`);
  if (!doctors.length) { $('results').innerHTML = `<p>${t('no_results')}</p>`; return; }
  $('results').innerHTML = doctors.map((d) => `
    <article class="card">
      <h3>${esc(d.full_name)}</h3>
      <p class="muted">${esc(d.specialty ? (lang === 'ar' ? d.specialty.name_ar : d.specialty.name_fr) : d.specialty_text)}</p>
      <p class="muted">${esc(d.clinics.map((c) => c.name).join(' · '))}</p>
      <p><span class="badge">${d.consultation_fee} DZD</span>
      ${d.whatsapp_mode === 'cloud_api' ? '<span class="badge">WhatsApp ✓</span>' : ''}</p>
      <button data-book="${Number(d.id)}">${t('book')}</button>
    </article>`).join('');
  document.querySelectorAll('[data-book]').forEach((btn) => btn.addEventListener('click', () => openBooking(Number(btn.dataset.book))));
}

async function openBooking(doctorId) {
  const { doctor } = await api(`/api/public/doctors/${doctorId}`);
  selectedDoctor = doctor;
  selectedClinic = doctor.clinics[0] || null;
  selectedSlot = null;
  idempotencyKey = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  $('bk-doctor').textContent = doctor.full_name;
  $('bk-clinics').innerHTML = doctor.clinics.length > 1
    ? doctor.clinics.map((c) => `<label><input type="radio" name="clinic" value="${c.id}" ${c.id === selectedClinic?.id ? 'checked' : ''}> ${esc(c.name)}</label>`).join('')
    : (doctor.clinics[0] ? `<p class="muted">${t('clinic')}: ${esc(doctor.clinics[0].name)}</p>` : '');
  document.querySelectorAll('input[name="clinic"]').forEach((r) => r.addEventListener('change', () => {
    selectedClinic = doctor.clinics.find((c) => c.id === Number(r.value)) || null;
    loadSlots();
  }));
  $('bk-date').value = new Date().toISOString().slice(0, 10);
  $('bk-result').innerHTML = '';
  $('booking-modal').classList.remove('hidden');
  loadSlots();
}

async function loadSlots() {
  const day = $('bk-date').value;
  if (!day || !selectedDoctor) return;
  const params = new URLSearchParams({ day });
  if (selectedClinic) params.set('clinic_id', selectedClinic.id);
  const { slots } = await api(`/api/public/doctors/${selectedDoctor.id}/slots?${params}`);
  $('bk-slots').innerHTML = slots.length
    ? slots.map((s) => `<button type="button" data-slot="${esc(s)}">${esc(s)}</button>`).join('')
    : `<p class="muted">${t('no_results')}</p>`;
  document.querySelectorAll('[data-slot]').forEach((btn) => btn.addEventListener('click', () => {
    selectedSlot = btn.dataset.slot;
    document.querySelectorAll('[data-slot]').forEach((b) => b.classList.toggle('selected', b === btn));
  }));
}

async function submitBooking(event) {
  event.preventDefault();
  if (!selectedSlot) { $('bk-result').innerHTML = `<p class="error">${t('select_slot')}</p>`; return; }
  try {
    const result = await api('/api/public/bookings', {
      method: 'POST',
      body: JSON.stringify({
        patient_name: $('bk-name').value,
        patient_phone: $('bk-phone').value,
        doctor_id: selectedDoctor.id,
        clinic_id: selectedClinic ? selectedClinic.id : null,
        day: $('bk-date').value,
        time: selectedSlot,
        lang,
        idempotency_key: idempotencyKey,
      }),
    });
    const ins = result.instructions;
    const payHtml = ins.method === 'cash'
      ? `<p>${t('awaiting')}</p>`
      : `<div class="payment-box">
           <strong>${t('payment_title')}</strong>
           <p>${t('amount')}: ${esc(ins.amount_dzd)} DZD · ${t('recipient')}: ${esc(ins.recipient_name || '—')} · ${t('rib')}: ${esc(ins.recipient_rib || '—')}</p>
           <pre>${t('pay_steps')}</pre>
           <input id="pay-ref" placeholder="Transaction reference">
           <input id="pay-file" type="file" accept=".jpg,.jpeg,.png,.pdf">
           <button type="button" id="pay-submit">${t('submit_ref')}</button>
         </div>`;
    // Only official wa.me links may be rendered as an action link.
    const safeLink = /^https:\/\/wa\.me\/\d{6,15}\?text=/.test(result.next_step.link || '') ? result.next_step.link : '';
    const waLink = safeLink ? `<p><a href="${esc(safeLink)}" target="_blank" rel="noopener noreferrer">${t('whatsapp_open')}</a></p>` : '';
    $('bk-result').innerHTML = `
      <p class="success">${esc(result.appointment.public_ref)} — ${esc(result.appointment.status)}</p>
      <p>${esc(result.next_step.message)}</p>${waLink}${payHtml}`;
    const payBtn = $('pay-submit');
    if (payBtn) payBtn.addEventListener('click', async () => {
      const file = $('pay-file').files[0];
      if (!file) { alert(t('receipt')); return; }
      const buf = await file.arrayBuffer();
      const res = await fetch(apiUrl(`/api/public/payments/${result.payment.id}/submit`), {
        method: 'POST',
        headers: { 'X-Filename': file.name, 'X-Transaction-Ref': $('pay-ref').value },
        body: buf,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { alert(data.error?.message || t('error_generic')); return; }
      $('bk-result').innerHTML = `<p class="success">${esc(result.appointment.public_ref)} — ${esc(data.payment.status)}</p><p>${t('awaiting')}</p>`;
    });
  } catch (error) {
    $('bk-result').innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}

async function track(event) {
  event.preventDefault();
  try {
    const data = await api(`/api/public/track?ref=${encodeURIComponent($('track-ref').value)}&phone=${encodeURIComponent($('track-phone').value)}`);
    $('track-result').innerHTML = `
      <p class="status">${esc(data.appointment.public_ref)} — ${esc(data.appointment.status)}</p>
      <p>${esc(data.doctor.full_name)} · ${esc(data.appointment.day)} ${esc(data.appointment.time)}</p>
      <p>${data.payment ? `${t('amount')}: ${esc(data.payment.amount)} DZD — ${esc(data.payment.status)}` : ''}</p>`;
  } catch (error) {
    $('track-result').innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}

$('lang-fr').addEventListener('click', () => { lang = 'fr'; applyLang(); loadFilters().then(search); });
$('lang-ar').addEventListener('click', () => { lang = 'ar'; applyLang(); loadFilters().then(search); });
$('search-form').addEventListener('submit', (e) => { e.preventDefault(); search(); });
$('track-form').addEventListener('submit', track);
$('bk-form').addEventListener('submit', submitBooking);
$('bk-date').addEventListener('change', loadSlots);
document.querySelector('[data-close]').addEventListener('click', () => $('booking-modal').classList.add('hidden'));

/** Native-app server settings: only shown in the APK, never on the web. */
function initNativeSettings() {
  const isNative = Boolean(window.Capacitor) || Boolean(apiBase);
  const btn = $('settings-btn');
  if (!isNative || !btn) return;
  btn.classList.remove('hidden');
  btn.addEventListener('click', () => {
    $('api-base-input').value = apiBase;
    $('settings-note').textContent = '';
    $('settings-modal').classList.remove('hidden');
  });
  document.querySelector('[data-close-settings]').addEventListener('click', () => $('settings-modal').classList.add('hidden'));
  $('api-base-save').addEventListener('click', () => {
    const value = $('api-base-input').value.trim().replace(/\/+$/, '');
    if (value && !/^https:\/\//.test(value) && !/^http:\/\/localhost/.test(value)) {
      $('settings-note').textContent = 'HTTPS required.';
      return;
    }
    if (value) localStorage.setItem('medirdv_api_base', value);
    else localStorage.removeItem('medirdv_api_base');
    apiBase = resolveApiBase();
    $('settings-modal').classList.add('hidden');
    loadFilters().then(search);
  });
}

applyLang();
initNativeSettings();
loadFilters().then(search);
