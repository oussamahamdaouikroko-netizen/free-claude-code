/* Medirdv Central SPA — patient site + admin dashboard + doctor portal.
   Vanilla JS, no build step. Arabic (RTL) / French (LTR) via toggle. */
"use strict";

const I18N = {
  fr: {
    nav_home: "Accueil", nav_track: "Suivre ma réservation", nav_login: "Connexion",
    nav_admin: "Administration", nav_doctor: "Espace médecin",
    footer: "Medirdv Central — plateforme centralisée de rendez-vous médicaux pour l'Algérie.",
    footer_note: "Vos données de santé ne sont jamais partagées au-delà du nécessaire pour votre rendez-vous.",
    hero_title: "Trouvez votre médecin, réservez en quelques minutes",
    hero_sub: "Recherchez par spécialité, wilaya ou clinique. Réservation invité possible, paiement BaridiMob simple, confirmation par WhatsApp.",
    search: "Rechercher", name: "Nom du médecin", specialty: "Spécialité", wilaya: "Wilaya",
    city: "Commune", clinic: "Clinique", all: "Toutes",
    no_doctors: "Aucun médecin actif trouvé. Essayez une autre recherche.",
    book: "Réserver", fee: "Consultation", whatsapp_api: "WhatsApp connecté",
    whatsapp_ctc: "WhatsApp (lien direct)", whatsapp_none: "WhatsApp non configuré",
    step1: "Médecin", step2: "Clinique", step3: "Date", step4: "Heure", step5: "Vos infos",
    step6: "Paiement", step7: "Confirmation",
    choose_clinic: "Choisir une clinique", choose_date: "Choisir une date", choose_time: "Choisir un horaire",
    no_slots: "Aucun horaire disponible pour cette date.",
    patient_name: "Nom complet", patient_phone: "Téléphone (WhatsApp)", lang: "Langue",
    confirm_booking: "Confirmer la demande",
    pay_title: "Paiement BaridiMob", pay_instructions: "Transférez le montant via BaridiMob vers le destinataire affiché, puis saisissez la référence de transaction.",
    amount: "Montant", recipient: "Destinataire", copy: "Copier", copied: "Copié !",
    txn_ref: "Référence de transaction BaridiMob", receipt: "Reçu (photo/PDF, optionnel)",
    submit_payment: "Envoyer pour vérification", whatsapp_help: "Aide WhatsApp",
    track_title: "Suivre ma réservation", ref: "Référence (ex : MR-2026-000001)", phone: "Téléphone",
    track: "Suivre", status: "Statut", cancel: "Annuler la réservation",
    login_title: "Connexion", email: "Email", password: "Mot de passe", login: "Se connecter",
    logout: "Se déconnecter", dashboard: "Tableau de bord", doctors: "Médecins",
    clinics: "Cliniques", appointments: "Rendez-vous", payments: "Paiements",
    whatsapp: "WhatsApp", patients: "Patients", users: "Utilisateurs", settings: "Paramètres",
    audit: "Journal d'audit", monitoring: "Supervision",
    add: "Ajouter", edit: "Modifier", save: "Enregistrer", approve: "Approuver",
    suspend: "Suspendre", activate: "Activer", verify: "Vérifier", reject: "Rejeter",
    refund: "Rembourser", connect: "Connecter", disconnect: "Déconnecter", retry: "Réessayer",
    total_doctors: "Médecins actifs", total_clinics: "Cliniques", total_patients: "Patients",
    today: "Réservations aujourd'hui", pending: "En attente", confirmed: "Confirmées",
    cancelled: "Annulées", pay_pending: "Paiements en attente", pay_verified: "Paiements vérifiés",
    collected: "Montant collecté (DA)", wa_connected: "WhatsApp connectés",
    recent: "Activité récente", daily: "Réservations (14 jours)", monthly: "Réservations (12 mois)",
    top_spec: "Spécialités demandées", by_wilaya: "Par wilaya",
    my_appointments: "Mes rendez-vous", accept: "Accepter", reschedule: "Autre horaire",
    complete: "Terminé", block_date: "Bloquer une date", reason: "Motif",
    error: "Une erreur est survenue.", loading: "Chargement…", empty: "Rien à afficher.",
    click_to_chat_note: "Ce médecin n'est pas connecté à l'API WhatsApp officielle. Vous serez redirigé vers WhatsApp avec un message pré-rempli — la confirmation se fera manuellement.",
    payment_note: "Un reçu n'est pas une preuve de paiement : un administrateur vérifiera la réception réelle des fonds avant confirmation.",
    cash_note: "Paiement en espèces à la clinique.",
  },
  ar: {
    nav_home: "الرئيسية", nav_track: "تتبع الحجز", nav_login: "تسجيل الدخول",
    nav_admin: "الإدارة", nav_doctor: "فضاء الطبيب",
    footer: "ميديرديف سنترال — منصة مركزية لمواعيد الأطباء في الجزائر.",
    footer_note: "لا تُشارك بياناتك الصحية أبدا إلا بالقدر الضروري لموعدك.",
    hero_title: "ابحث عن طبيبك واحجز في دقائق",
    hero_sub: "ابحث بالتخصص أو الولاية أو العيادة. حجز كضيف ممكن، دفع بريدي موب بسيط، وتأكيد عبر واتساب.",
    search: "بحث", name: "اسم الطبيب", specialty: "التخصص", wilaya: "الولاية",
    city: "البلدية", clinic: "العيادة", all: "الكل",
    no_doctors: "لم يتم العثور على أطباء نشطين. جرّب بحثا آخر.",
    book: "احجز", fee: "الاستشارة", whatsapp_api: "واتساب متصل",
    whatsapp_ctc: "واتساب (رابط مباشر)", whatsapp_none: "واتساب غير مهيأ",
    step1: "الطبيب", step2: "العيادة", step3: "التاريخ", step4: "الوقت", step5: "معلوماتك",
    step6: "الدفع", step7: "التأكيد",
    choose_clinic: "اختر عيادة", choose_date: "اختر تاريخا", choose_time: "اختر وقتا",
    no_slots: "لا توجد أوقات متاحة لهذا التاريخ.",
    patient_name: "الاسم الكامل", patient_phone: "الهاتف (واتساب)", lang: "اللغة",
    confirm_booking: "تأكيد الطلب",
    pay_title: "الدفع عبر بريدي موب", pay_instructions: "حوّل المبلغ عبر بريدي موب إلى المستلم المعروض، ثم أدخل مرجع العملية.",
    amount: "المبلغ", recipient: "المستلم", copy: "نسخ", copied: "تم النسخ!",
    txn_ref: "مرجع عملية بريدي موب", receipt: "الإيصال (صورة/PDF، اختياري)",
    submit_payment: "إرسال للتحقق", whatsapp_help: "مساعدة واتساب",
    track_title: "تتبع الحجز", ref: "المرجع (مثال: MR-2026-000001)", phone: "الهاتف",
    track: "تتبع", status: "الحالة", cancel: "إلغاء الحجز",
    login_title: "تسجيل الدخول", email: "البريد الإلكتروني", password: "كلمة المرور", login: "دخول",
    logout: "خروج", dashboard: "لوحة القيادة", doctors: "الأطباء",
    clinics: "العيادات", appointments: "المواعيد", payments: "المدفوعات",
    whatsapp: "واتساب", patients: "المرضى", users: "المستخدمون", settings: "الإعدادات",
    audit: "سجل التدقيق", monitoring: "المراقبة",
    add: "إضافة", edit: "تعديل", save: "حفظ", approve: "اعتماد",
    suspend: "تعليق", activate: "تفعيل", verify: "تحقق", reject: "رفض",
    refund: "استرجاع", connect: "ربط", disconnect: "فصل", retry: "إعادة المحاولة",
    total_doctors: "أطباء نشطون", total_clinics: "عيادات", total_patients: "مرضى",
    today: "حجوزات اليوم", pending: "قيد الانتظار", confirmed: "مؤكدة",
    cancelled: "ملغاة", pay_pending: "مدفوعات قيد الانتظار", pay_verified: "مدفوعات مؤكدة",
    collected: "المبلغ المحصّل (دج)", wa_connected: "واتساب متصل",
    recent: "النشاط الأخير", daily: "الحجوزات (14 يوما)", monthly: "الحجوزات (12 شهرا)",
    top_spec: "التخصصات المطلوبة", by_wilaya: "حسب الولاية",
    my_appointments: "مواعيدي", accept: "قبول", reschedule: "وقت آخر",
    complete: "إنهاء", block_date: "حظر تاريخ", reason: "السبب",
    error: "حدث خطأ.", loading: "جار التحميل…", empty: "لا شيء لعرضه.",
    click_to_chat_note: "هذا الطبيب غير مرتبط بواجهة واتساب الرسمية. سيتم تحويلك إلى واتساب مع رسالة جاهزة — التأكيد يدوي.",
    payment_note: "الإيصال ليس دليلا على الدفع: سيتحقق المسؤول من استلام المبلغ فعليا قبل التأكيد.",
    cash_note: "الدفع نقدا في العيادة.",
  },
};

let LANG = localStorage.getItem("medirdv_lang") || "fr";
let USER = null, CSRF = null;

const t = (k) => (I18N[LANG] && I18N[LANG][k]) || I18N.fr[k] || k;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function setLang(lang) {
  LANG = lang;
  localStorage.setItem("medirdv_lang", lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  $("#lang-toggle").textContent = lang === "ar" ? "Français" : "العربية";
  $$("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  route();
}

async function api(path, { method = "GET", body = null, headers = {} } = {}) {
  const res = await fetch(path, {
    method, credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(CSRF ? { "X-CSRF-Token": CSRF } : {}), ...headers },
    body: body ? JSON.stringify(body) : null,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function alertBox(msg, kind = "error") {
  const el = document.createElement("div");
  el.className = `alert ${kind}`;
  el.textContent = msg;
  return el;
}

function badgeFor(status) {
  const map = { active: "", confirmed: "", paid: "", connected: "", sent: "",
    pending_approval: "warn", pending_payment: "warn", payment_verification: "warn",
    pending_doctor_approval: "warn", under_verification: "warn", awaiting_payment: "warn",
    suspended: "danger", rejected: "danger", cancelled: "danger", expired: "danger",
    disconnected: "danger", failed: "danger", click_to_chat: "warn", queued: "warn" };
  return `<span class="badge ${map[status] || "muted"}">${esc(status)}</span>`;
}

function barChart(items, labelKey) {
  if (!items.length) return `<p class="empty">${t("empty")}</p>`;
  const max = Math.max(...items.map((i) => i.n), 1);
  return `<div class="chart">${items.map((i) => `<div class="bar" style="height:${Math.max(4, (i.n / max) * 100)}%" title="${esc(i[labelKey])}: ${i.n}"><span>${esc(String(i[labelKey]).slice(5))}</span></div>`).join("")}</div>`;
}

/* ------------------------------------------------------------------ views */
function viewHome() {
  const app = $("#app");
  app.innerHTML = `
    <section class="hero"><h1>${t("hero_title")}</h1><p>${t("hero_sub")}</p></section>
    <section class="card"><form class="search-form" id="search-form">
      <div><label>${t("name")}</label><input name="q" placeholder="…"></div>
      <div><label>${t("specialty")}</label><input name="specialty" placeholder="…"></div>
      <div><label>${t("wilaya")}</label><input name="wilaya" placeholder="…"></div>
      <div><label>${t("city")}</label><input name="city" placeholder="…"></div>
      <div><label>${t("clinic")}</label><input name="clinic" placeholder="…"></div>
      <div style="align-self:end"><button class="btn" type="submit">${t("search")}</button></div>
    </form></section>
    <section id="results"><p class="muted">${t("loading")}</p></section>`;
  const load = async (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    const { doctors } = await api(`/api/v1/public/doctors?${qs}`);
    $("#results").innerHTML = doctors.length
      ? `<div class="grid">${doctors.map((d) => `
        <article class="card doctor-card">
          <h3>${esc(d.full_name)}</h3>
          <p class="muted">${esc(d.specialty)} · ${esc(d.wilaya)} ${esc(d.city)}</p>
          <p>${esc(d.address || "")}</p>
          <p>${t("fee")} : <strong>${esc(d.fee)} DA</strong></p>
          <p>${badgeFor(d.whatsapp?.status === "connected" ? (d.whatsapp.mode === "cloud" ? "connected" : "click_to_chat") : "muted")}</p>
          <a class="btn" href="#/doctor/${d.id}">${t("book")}</a>
        </article>`).join("")}</div>`
      : `<p class="empty">${t("no_doctors")}</p>`;
  };
  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    load(Object.fromEntries(new FormData(e.target)));
  });
  load().catch((e) => { $("#results").innerHTML = ""; $("#results").append(alertBox(e.message)); });
}

async function viewDoctor(id) {
  const app = $("#app");
  const { doctor } = await api(`/api/v1/public/doctors/${id}`);
  const wa = doctor.whatsapp || {};
  app.innerHTML = `
    <a href="#/">← ${t("nav_home")}</a>
    <section class="card"><h2>${esc(doctor.full_name)}</h2>
      <p class="muted">${esc(doctor.specialty)} · ${esc(doctor.wilaya)} ${esc(doctor.city)}</p>
      <p>${esc(doctor.address || "")}</p>
      <p>${t("fee")} : <strong>${esc(doctor.fee)} DA</strong> · ${esc(doctor.duration_min)} min</p>
      <p>${wa.status === "connected" && wa.mode === "cloud" ? t("whatsapp_api") : wa.status === "connected" ? t("whatsapp_ctc") : t("whatsapp_none")}</p>
      ${wa.mode === "click_to_chat" ? `<div class="alert info">${t("click_to_chat_note")}</div>` : ""}
    </section>
    <section class="card" id="booking"></section>`;
  renderBooking(doctor);
}

function renderBooking(doctor) {
  const box = $("#booking");
  const clinics = doctor.clinics || [];
  let clinicId = clinics[0]?.id || null, date = "", time = "";
  box.innerHTML = `
    <div class="steps"><span class="step active">1 ${t("step1")}</span><span class="step">2 ${t("step2")}</span><span class="step">3 ${t("step3")}</span><span class="step">4 ${t("step4")}</span><span class="step">5 ${t("step5")}</span></div>
    <label>${t("choose_clinic")}</label>
    <select id="bk-clinic">${clinics.map((c) => `<option value="${c.id}">${esc(c.name)} — ${esc(c.city)}</option>`).join("")}</select>
    <label style="margin-top:10px">${t("choose_date")}</label>
    <input type="date" id="bk-date">
    <label style="margin-top:10px">${t("choose_time")}</label>
    <div class="slots" id="bk-slots"><p class="muted">${t("choose_date")}</p></div>
    <form id="bk-form" hidden>
      <div class="grid" style="margin-top:12px">
        <div><label>${t("patient_name")}</label><input name="patient_name" required></div>
        <div><label>${t("patient_phone")}</label><input name="patient_phone" required inputmode="tel"></div>
      </div>
      <button class="btn" style="margin-top:12px" type="submit">${t("confirm_booking")}</button>
    </form>
    <div id="bk-result"></div>`;
  const loadSlots = async () => {
    date = $("#bk-date").value;
    if (!date) return;
    const { slots } = await api(`/api/v1/public/doctors/${doctor.id}/availability?date=${date}&clinic_id=${clinicId || ""}`);
    $("#bk-slots").innerHTML = slots.length
      ? slots.map((s) => `<button type="button" class="slot" data-slot="${s}">${s}</button>`).join("")
      : `<p class="muted">${t("no_slots")}</p>`;
    $$(".slot", box).forEach((b) => b.addEventListener("click", () => {
      $$(".slot", box).forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected"); time = b.dataset.slot; $("#bk-form").hidden = false;
    }));
  };
  $("#bk-clinic").addEventListener("change", (e) => { clinicId = Number(e.target.value); loadSlots(); });
  $("#bk-date").addEventListener("change", loadSlots);
  $("#bk-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const idem = crypto.randomUUID();
    try {
      const res = await api("/api/v1/public/bookings", {
        method: "POST", headers: { "Idempotency-Key": idem },
        body: { doctor_id: doctor.id, clinic_id: clinicId, date, time, ...fd, lang: LANG },
      });
      const b = res.booking;
      $("#bk-result").innerHTML = `<div class="alert ok">${t("step7")} — ${t("ref")} : <strong>${esc(b.ref)}</strong> · ${t("status")} : ${badgeFor(b.status)}</div>`
        + (b.payment_status === "awaiting_payment" && doctor.payment_policy === "baridimob" ? paymentBox(b, doctor) : "")
        + (res.whatsapp?.via === "click_to_chat" ? `<p><a class="btn secondary" href="${esc(res.whatsapp.url)}" target="_blank" rel="noopener">${t("whatsapp_help")}</a></p>` : "");
      wirePayment(b);
    } catch (err) { $("#bk-result").innerHTML = ""; $("#bk-result").append(alertBox(err.message)); }
  });
}

function paymentBox(b, doctor) {
  return `<section class="card"><h3>${t("pay_title")}</h3>
    <p>${t("pay_instructions")}</p>
    <p>${t("amount")} : <strong>${esc(doctor.fee)} DA</strong></p>
    <div class="copy-row"><span>${t("recipient")} :</span><code id="pay-recipient">—</code><button class="btn small secondary" id="pay-copy" type="button">${t("copy")}</button></div>
    <p class="muted">${t("payment_note")}</p>
    <form id="pay-form">
      <label>${t("txn_ref")}</label><input name="txn_ref" required>
      <label style="margin-top:8px">${t("receipt")}</label><input name="receipt" type="file" accept=".jpg,.jpeg,.png,.pdf">
      <button class="btn" style="margin-top:10px" type="submit">${t("submit_payment")}</button>
    </form><div id="pay-result"></div></section>`;
}

function wirePayment(b) {
  const form = $("#pay-form");
  if (!form) return;
  $("#pay-copy")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#pay-recipient").textContent);
    $("#pay-copy").textContent = t("copied");
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const file = fd.get("receipt");
    try {
      if (file && file.size) {
        const buf = new Uint8Array(await file.arrayBuffer());
        let bin = ""; buf.forEach((x) => { bin += String.fromCharCode(x); });
        await api(`/api/v1/public/bookings/${b.ref}/receipt`, {
          method: "POST",
          body: { phone: $("#bk-form")?.patient_phone?.value || "", txn_ref: fd.get("txn_ref"),
                  filename: file.name, file_b64: btoa(bin) },
        });
      } else {
        await api(`/api/v1/public/bookings/${b.ref}/payment`, {
          method: "POST", body: { phone: "", txn_ref: fd.get("txn_ref") },
        });
      }
      $("#pay-result").innerHTML = `<div class="alert ok">${t("status")} : ${badgeFor("under_verification")}</div>`;
    } catch (err) { $("#pay-result").innerHTML = ""; $("#pay-result").append(alertBox(err.message)); }
  });
}

function viewTrack() {
  const app = $("#app");
  app.innerHTML = `<section class="card"><h2>${t("track_title")}</h2>
    <form id="track-form" class="search-form">
      <div><label>${t("ref")}</label><input name="ref" required placeholder="MR-2026-000001"></div>
      <div><label>${t("phone")}</label><input name="phone" required></div>
      <div style="align-self:end"><button class="btn" type="submit">${t("track")}</button></div>
    </form><div id="track-result"></div></section>`;
  $("#track-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      const { booking } = await api(`/api/v1/public/bookings/track?ref=${encodeURIComponent(fd.ref)}&phone=${encodeURIComponent(fd.phone)}`);
      $("#track-result").innerHTML = `<div class="card">
        <p>${t("ref")} : <strong>${esc(booking.ref)}</strong> · ${t("status")} : ${badgeFor(booking.status)}</p>
        <p>${esc(booking.date)} ${esc(booking.time)}</p>
        ${booking.payment ? `<p>${t("payments")} : ${badgeFor(booking.payment.status)}</p>` : ""}
        <button class="btn danger small" id="track-cancel">${t("cancel")}</button></div>`;
      $("#track-cancel").addEventListener("click", async () => {
        await api(`/api/v1/public/bookings/${booking.ref}/cancel`, { method: "POST", body: { phone: fd.phone } });
        $("#track-result").innerHTML = `<div class="alert ok">${t("cancelled")}</div>`;
      });
    } catch (err) { $("#track-result").innerHTML = ""; $("#track-result").append(alertBox(err.message)); }
  });
}

function viewLogin() {
  const app = $("#app");
  app.innerHTML = `<section class="card" style="max-width:420px;margin:30px auto"><h2>${t("login_title")}</h2>
    <form id="login-form"><label>${t("email")}</label><input name="email" type="email" required>
    <label style="margin-top:8px">${t("password")}</label><input name="password" type="password" required>
    <button class="btn" style="margin-top:14px;width:100%" type="submit">${t("login")}</button></form>
    <div id="login-result"></div></section>`;
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const res = await api("/api/v1/auth/login", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
      USER = res.user; CSRF = res.csrf_token; refreshNav();
      location.hash = USER.role === "doctor" ? "#/doctor-portal" : "#/admin";
    } catch (err) { $("#login-result").innerHTML = ""; $("#login-result").append(alertBox(err.message)); }
  });
}

/* ------------------------------------------------------------------ admin */
async function viewAdmin() {
  if (!USER) return viewLogin();
  const app = $("#app");
  const tabs = [["dashboard", t("dashboard")], ["doctors", t("doctors")], ["clinics", t("clinics")],
    ["appointments", t("appointments")], ["payments", t("payments")], ["whatsapp", t("whatsapp")],
    ["patients", t("patients")], ["users", t("users")], ["settings", t("settings")],
    ["audit", t("audit")], ["monitoring", t("monitoring")]];
  app.innerHTML = `<div class="tabs">${tabs.map(([k, label], i) => `<button data-tab="${k}" class="${i === 0 ? "active" : ""}">${label}</button>`).join("")}
    <button id="logout">${t("logout")}</button></div><div id="admin-body"><p class="muted">${t("loading")}</p></div>`;
  $("#logout").addEventListener("click", async () => { await api("/api/v1/auth/logout", { method: "POST" }); USER = null; CSRF = null; refreshNav(); location.hash = "#/"; });
  const load = async (tab) => {
    $$(".tabs button[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    const body = $("#admin-body");
    body.innerHTML = `<p class="muted">${t("loading")}</p>`;
    try {
      if (tab === "dashboard") {
        const s = await api("/api/v1/admin/stats");
        body.innerHTML = `
          <div class="grid grid-3">
            ${[[s.doctors_active, t("total_doctors")], [s.clinics_total, t("total_clinics")], [s.patients_total, t("total_patients")],
               [s.bookings_today, t("today")], [s.pending_bookings, t("pending")], [s.confirmed_bookings, t("confirmed")],
               [s.cancelled_bookings, t("cancelled")], [s.payments_pending, t("pay_pending")], [s.payments_verified, t("pay_verified")],
               [s.total_collected + " DA", t("collected")], [s.whatsapp_connected + "/" + s.whatsapp_total, t("wa_connected")]]
              .map(([v, l]) => `<div class="card"><div class="stat">${esc(v)}</div><div class="stat-label">${l}</div></div>`).join("")}
          </div>
          <div class="grid">
            <section class="card"><h3>${t("daily")}</h3>${barChart(s.daily_bookings, "day")}</section>
            <section class="card"><h3>${t("monthly")}</h3>${barChart(s.monthly_bookings, "month")}</section>
            <section class="card"><h3>${t("top_spec")}</h3><table>${s.top_specialties.map((r) => `<tr><td>${esc(r.specialty)}</td><td>${r.n}</td></tr>`).join("")}</table></section>
            <section class="card"><h3>${t("by_wilaya")}</h3><table>${s.by_wilaya.map((r) => `<tr><td>${esc(r.wilaya)}</td><td>${r.n}</td></tr>`).join("")}</table></section>
          </div>
          <section class="card"><h3>${t("recent")}</h3><table>${s.recent_activity.map((r) => `<tr><td>${esc(r.actor)}</td><td>${esc(r.action)}</td><td>${esc(r.created_at)}</td></tr>`).join("")}</table></section>`;
      } else if (tab === "doctors") {
        const { doctors } = await api("/api/v1/admin/doctors");
        body.innerHTML = `<section class="card"><h3>${t("doctors")}</h3>
          <form id="doc-form" class="search-form">
            <div><label>${t("name")}</label><input name="full_name" required></div>
            <div><label>${t("specialty")}</label><input name="specialty"></div>
            <div><label>${t("wilaya")}</label><input name="wilaya"></div>
            <div><label>${t("city")}</label><input name="city"></div>
            <div><label>${t("fee")}</label><input name="fee" type="number" value="0"></div>
            <div style="align-self:end"><button class="btn" type="submit">${t("add")}</button></div>
          </form></section>
          <section class="card"><table><tr><th>ID</th><th>${t("name")}</th><th>${t("specialty")}</th><th>${t("status")}</th><th></th></tr>
          ${doctors.map((d) => `<tr><td>${d.id}</td><td>${esc(d.full_name)}</td><td>${esc(d.specialty)}</td><td>${badgeFor(d.status)}</td>
            <td><button class="btn small" data-act="active" data-id="${d.id}">${t("activate")}</button>
            <button class="btn small secondary" data-act="suspended" data-id="${d.id}">${t("suspend")}</button></td></tr>`).join("")}</table></section>`;
        $("#doc-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          await api("/api/v1/admin/doctors", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
          load("doctors");
        });
        $$("[data-act]", body).forEach((b) => b.addEventListener("click", async () => {
          await api(`/api/v1/admin/doctors/${b.dataset.id}/status`, { method: "POST", body: { status: b.dataset.act } });
          load("doctors");
        }));
      } else if (tab === "clinics") {
        const { clinics } = await api("/api/v1/admin/clinics");
        body.innerHTML = `<section class="card"><h3>${t("clinics")}</h3>
          <form id="clinic-form" class="search-form">
            <div><label>${t("name")}</label><input name="name" required></div>
            <div><label>${t("wilaya")}</label><input name="wilaya"></div>
            <div><label>${t("city")}</label><input name="city"></div>
            <div style="align-self:end"><button class="btn" type="submit">${t("add")}</button></div>
          </form></section>
          <section class="card"><table>${clinics.map((c) => `<tr><td>${c.id}</td><td>${esc(c.name)}</td><td>${esc(c.wilaya)} ${esc(c.city)}</td></tr>`).join("")}</table></section>`;
        $("#clinic-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          await api("/api/v1/admin/clinics", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
          load("clinics");
        });
      } else if (tab === "appointments") {
        const { appointments } = await api("/api/v1/admin/appointments");
        body.innerHTML = `<section class="card"><table><tr><th>${t("ref")}</th><th>${t("name")}</th><th>${t("status")}</th><th>Date</th></tr>
          ${appointments.map((a) => `<tr><td>${esc(a.ref)}</td><td>${esc(a.patient_name)} → ${esc(a.doctor_name)}</td><td>${badgeFor(a.status)}</td><td>${esc(a.date)} ${esc(a.time)}</td></tr>`).join("")}</table></section>`;
      } else if (tab === "payments") {
        const { payments } = await api("/api/v1/admin/payments");
        body.innerHTML = `<section class="card"><table><tr><th>${t("ref")}</th><th>${t("amount")}</th><th>${t("status")}</th><th>${t("txn_ref")}</th><th></th></tr>
          ${payments.map((p) => `<tr><td>${esc(p.booking_ref)}</td><td>${esc(p.amount)} DA</td><td>${badgeFor(p.status)}</td><td>${esc(p.txn_ref || "—")}</td>
            <td>${p.status === "under_verification" ? `<button class="btn small" data-v="paid" data-id="${p.id}">${t("verify")}</button> <button class="btn small danger" data-v="rejected" data-id="${p.id}">${t("reject")}</button>` : ""}
            ${p.status === "paid" ? `<button class="btn small secondary" data-r="${p.id}">${t("refund")}</button>` : ""}</td></tr>`).join("")}</table></section>`;
        $$("[data-v]", body).forEach((b) => b.addEventListener("click", async () => {
          const notes = prompt("Notes:", "") || "";
          await api(`/api/v1/admin/payments/${b.dataset.id}/verify`, { method: "POST", body: { decision: b.dataset.v, notes } });
          load("payments");
        }));
        $$("[data-r]", body).forEach((b) => b.addEventListener("click", async () => {
          await api(`/api/v1/admin/payments/${b.dataset.r}/refund`, { method: "POST", body: { notes: "" } });
          load("payments");
        }));
      } else if (tab === "whatsapp") {
        const { accounts } = await api("/api/v1/admin/whatsapp/accounts");
        const { doctors } = await api("/api/v1/admin/doctors");
        body.innerHTML = `<section class="card"><h3>${t("whatsapp")}</h3>
          <form id="wa-form" class="search-form">
            <div><label>${t("doctors")}</label><select name="doctor_id">${doctors.map((d) => `<option value="${d.id}">${esc(d.full_name)}</option>`).join("")}</select></div>
            <div><label>Phone Number ID</label><input name="phone_number_id"></div>
            <div><label>Access token</label><input name="access_token" type="password"></div>
            <div><label>Mode</label><select name="mode"><option value="cloud">cloud (API)</option><option value="click_to_chat">click_to_chat</option></select></div>
            <div style="align-self:end"><button class="btn" type="submit">${t("connect")}</button></div>
          </form></section>
          <section class="card"><table><tr><th>${t("doctors")}</th><th>${t("status")}</th><th></th></tr>
          ${accounts.map((a) => `<tr><td>${esc(a.doctor_name)}</td><td>${badgeFor(a.status)} <span class="muted">${esc(a.mode)}</span></td>
            <td><button class="btn small danger" data-d="${a.doctor_id}">${t("disconnect")}</button></td></tr>`).join("")}</table></section>`;
        $("#wa-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          await api("/api/v1/admin/whatsapp/accounts", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
          load("whatsapp");
        });
        $$("[data-d]", body).forEach((b) => b.addEventListener("click", async () => {
          await api(`/api/v1/admin/whatsapp/accounts/${b.dataset.d}/disconnect`, { method: "POST" });
          load("whatsapp");
        }));
      } else if (tab === "patients") {
        const { patients } = await api("/api/v1/admin/patients");
        body.innerHTML = `<section class="card"><table>${patients.map((p) => `<tr><td>${esc(p.full_name)}</td><td>${esc(p.phone)}</td></tr>`).join("")}</table></section>`;
      } else if (tab === "users") {
        const { users } = await api("/api/v1/admin/users");
        body.innerHTML = `<section class="card"><h3>${t("users")}</h3>
          <form id="user-form" class="search-form">
            <div><label>${t("email")}</label><input name="email" type="email" required></div>
            <div><label>${t("password")}</label><input name="password" required></div>
            <div><label>${t("status")}</label><select name="role"><option>admin</option><option>payment_verifier</option><option>support_agent</option><option>doctor</option></select></div>
            <div style="align-self:end"><button class="btn" type="submit">${t("add")}</button></div>
          </form></section>
          <section class="card"><table>${users.map((u) => `<tr><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${badgeFor(u.status)}</td></tr>`).join("")}</table></section>`;
        $("#user-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          await api("/api/v1/admin/users", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
          load("users");
        });
      } else if (tab === "settings") {
        const { settings } = await api("/api/v1/admin/settings");
        body.innerHTML = `<section class="card"><h3>${t("settings")}</h3>
          <form id="settings-form">${Object.entries(settings).map(([k, v]) => `<label>${esc(k)}</label><input name="${esc(k)}" value="${esc(v)}">`).join("")}
          <button class="btn" style="margin-top:10px" type="submit">${t("save")}</button></form></section>`;
        $("#settings-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          await api("/api/v1/admin/settings", { method: "POST", body: { settings: Object.fromEntries(new FormData(e.target)) } });
          load("settings");
        });
      } else if (tab === "audit") {
        const { audit } = await api("/api/v1/admin/audit");
        body.innerHTML = `<section class="card"><table>${audit.map((a) => `<tr><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(a.entity)} ${esc(a.entity_id)}</td><td>${esc(a.created_at)}</td></tr>`).join("")}</table></section>`;
      } else if (tab === "monitoring") {
        const m = await api("/api/v1/admin/monitoring");
        body.innerHTML = `<section class="card"><h3>${t("monitoring")}</h3>
          <p>WhatsApp: ${m.whatsapp.map((w) => `${esc(w.status)}=${w.n}`).join(", ")}</p>
          <p>${t("status")} failed messages: ${m.failed_messages} · webhooks: ${m.webhook_events} (unprocessed: ${m.unprocessed_webhooks}) · sync failed: ${m.sync_failed}</p>
          <table>${m.integration_logs.map((l) => `<tr><td>${esc(l.kind)}</td><td>${esc(l.detail)}</td><td>${esc(l.created_at)}</td></tr>`).join("")}</table></section>`;
      }
    } catch (err) { body.innerHTML = ""; body.append(alertBox(err.message)); }
  };
  $$(".tabs button[data-tab]").forEach((b) => b.addEventListener("click", () => load(b.dataset.tab)));
  load("dashboard");
}

/* ------------------------------------------------------------------ doctor portal */
async function viewDoctorPortal() {
  if (!USER) return viewLogin();
  const app = $("#app");
  const { doctor } = await api("/api/v1/doctor/me");
  const { appointments } = await api("/api/v1/doctor/appointments");
  app.innerHTML = `<section class="card"><h2>${esc(doctor.full_name)}</h2>
    <p class="muted">${esc(doctor.specialty)} · ${esc(doctor.status)}</p>
    <p>${t("whatsapp")} : ${badgeFor(doctor.whatsapp?.status || "muted")} <span class="muted">${esc(doctor.whatsapp?.mode || "")}</span></p></section>
    <section class="card"><h3>${t("my_appointments")}</h3>
    <table><tr><th>${t("ref")}</th><th>${t("name")}</th><th>${t("status")}</th><th></th></tr>
    ${appointments.map((a) => `<tr><td>${esc(a.ref)}</td><td>${esc(a.patient_name)}</td><td>${badgeFor(a.status)}</td>
      <td><button class="btn small" data-r="accept" data-id="${a.id}">${t("accept")}</button>
      <button class="btn small secondary" data-r="reschedule" data-id="${a.id}">${t("reschedule")}</button>
      <button class="btn small danger" data-r="reject" data-id="${a.id}">${t("reject")}</button></td></tr>`).join("")}</table></section>
    <section class="card"><h3>${t("block_date")}</h3>
      <form id="block-form" class="search-form"><div><label>${t("choose_date")}</label><input type="date" name="date" required></div>
      <div><label>${t("reason")}</label><input name="reason"></div>
      <div style="align-self:end"><button class="btn" type="submit">${t("block_date")}</button></div></form></section>`;
  $$("[data-r]", app).forEach((b) => b.addEventListener("click", async () => {
    await api(`/api/v1/doctor/appointments/${b.dataset.id}/respond`, { method: "POST", body: { action: b.dataset.r } });
    viewDoctorPortal();
  }));
  $("#block-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await api("/api/v1/doctor/availability", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
    viewDoctorPortal();
  });
}

/* ------------------------------------------------------------------ router */
function refreshNav() {
  $("#nav-login").hidden = !!USER;
  $("#nav-admin").hidden = !(USER && USER.role !== "doctor" && USER.role !== "patient");
  $("#nav-doctor").hidden = !(USER && USER.role === "doctor");
}

async function route() {
  const hash = location.hash || "#/";
  try {
    if (hash === "#/" || hash === "#") return viewHome();
    if (hash === "#/track") return viewTrack();
    if (hash === "#/login") return viewLogin();
    if (hash === "#/admin") return viewAdmin();
    if (hash === "#/doctor-portal") return viewDoctorPortal();
    const m = hash.match(/^#\/doctor\/(\d+)$/);
    if (m) return viewDoctor(m[1]);
    return viewHome();
  } catch (err) {
    $("#app").innerHTML = "";
    $("#app").append(alertBox(err.message));
  }
}

$("#lang-toggle").addEventListener("click", () => setLang(LANG === "fr" ? "ar" : "fr"));
window.addEventListener("hashchange", route);
(async () => {
  try {
    const me = await api("/api/v1/auth/me");
    USER = me.user; CSRF = me.csrf_token;
  } catch { /* guest */ }
  refreshNav();
  setLang(LANG);
})();
