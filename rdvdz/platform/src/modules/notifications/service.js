/**
 * Notifications centralisées.
 *
 * Canaux : in-app (toujours disponible), e-mail (adaptateur), WhatsApp
 * (API officielle si configurée, sinon **repli clic-pour-discuter**), SMS
 * (adaptateur, désactivé sans fournisseur).
 *
 * Règles :
 *  - aucun contenu médical dans un message sortant (seuls date, heure, nom du
 *    médecin, référence de rendez-vous) ;
 *  - une préférence utilisateur désactivée bloque l'envoi sur ce canal ;
 *  - `dedupe_key` empêche tout doublon (rappels rejoués par le worker).
 */

import { db, many, one } from '../../db.js';
import { config } from '../../config.js';
import { audit } from '../../lib/audit.js';
import { normalizePhone } from '../../lib/crypto.js';

export const EVENTS = [
  'booking.created',
  'booking.confirmed',
  'booking.cancelled',
  'booking.reminder',
  'booking.rescheduled',
  'payment.received',
  'payment.refunded',
  'consultation.created',
  'consultation.answered',
  'consultation.closed',
  'review.moderated',
  'branch.assigned',
];

/** Modèles par défaut (AR/FR). Remplaçables en base sans redéploiement. */
const DEFAULT_TEMPLATES = [
  {
    code: 'booking.confirmed',
    channel: 'IN_APP',
    locale: 'fr',
    subject: 'Rendez-vous confirmé',
    body: 'Votre rendez-vous {{reference}} avec Dr {{doctor}} est confirmé le {{date}} à {{time}}.',
  },
  {
    code: 'booking.confirmed',
    channel: 'IN_APP',
    locale: 'ar',
    subject: 'تم تأكيد الموعد',
    body: 'موعدكم {{reference}} مع الدكتور {{doctor}} مؤكد يوم {{date}} على الساعة {{time}}.',
  },
  {
    code: 'booking.confirmed',
    channel: 'WHATSAPP',
    locale: 'fr',
    subject: '',
    body: 'RDV DZ : rendez-vous confirmé ({{reference}}) le {{date}} à {{time}}. Ne répondez pas avec vos données médicales.',
    whatsapp_template_name: 'booking_confirmed_fr',
  },
  {
    code: 'booking.confirmed',
    channel: 'WHATSAPP',
    locale: 'ar',
    subject: '',
    body: 'RDV DZ: تم تأكيد الموعد ({{reference}}) يوم {{date}} على الساعة {{time}}. لا ترسلوا معطياتكم الطبية عبر هذه الرسالة.',
    whatsapp_template_name: 'booking_confirmed_ar',
  },
  {
    code: 'booking.reminder',
    channel: 'WHATSAPP',
    locale: 'fr',
    body: 'Rappel RDV DZ : {{reference}} demain {{date}} à {{time}} avec Dr {{doctor}}.',
    whatsapp_template_name: 'booking_reminder_fr',
  },
  {
    code: 'booking.reminder',
    channel: 'WHATSAPP',
    locale: 'ar',
    body: 'تذكير RDV DZ: {{reference}} غدا {{date}} على الساعة {{time}} مع الدكتور {{doctor}}.',
    whatsapp_template_name: 'booking_reminder_ar',
  },
  {
    code: 'booking.cancelled',
    channel: 'IN_APP',
    locale: 'fr',
    subject: 'Rendez-vous annulé',
    body: 'Le rendez-vous {{reference}} du {{date}} a été annulé.',
  },
  {
    code: 'booking.cancelled',
    channel: 'IN_APP',
    locale: 'ar',
    subject: 'تم إلغاء الموعد',
    body: 'تم إلغاء الموعد {{reference}} المبرمج يوم {{date}}.',
  },
  {
    code: 'consultation.answered',
    channel: 'IN_APP',
    locale: 'fr',
    subject: 'Réponse de votre médecin',
    body: 'Le Dr {{doctor}} a répondu à votre consultation {{reference}}.',
  },
  {
    code: 'consultation.answered',
    channel: 'IN_APP',
    locale: 'ar',
    subject: 'رد الطبيب',
    body: 'أجاب الدكتور {{doctor}} على استشارتكم {{reference}}.',
  },
  {
    code: 'consultation.created',
    channel: 'IN_APP',
    locale: 'fr',
    subject: 'Nouvelle demande de téléconsultation',
    body: 'Une nouvelle demande de téléconsultation {{reference}} vous est adressée.',
  },
  {
    code: 'consultation.created',
    channel: 'IN_APP',
    locale: 'ar',
    subject: 'طلب استشارة عن بعد جديد',
    body: 'وصل طلب استشارة عن بعد جديد بالمرجع {{reference}}.',
  },
  {
    code: 'consultation.closed',
    channel: 'IN_APP',
    locale: 'fr',
    subject: 'Consultation clôturée',
    body: 'La consultation {{reference}} est clôturée.',
  },
  {
    code: 'consultation.closed',
    channel: 'IN_APP',
    locale: 'ar',
    subject: 'تم إغلاق الاستشارة',
    body: 'تم إغلاق الاستشارة {{reference}}.',
  },
  {
    code: 'payment.received',
    channel: 'IN_APP',
    locale: 'fr',
    subject: 'Paiement reçu',
    body: 'Nous avons reçu votre paiement de {{amount}} DZD pour {{reference}}.',
  },
  {
    code: 'consultation.created',
    channel: 'IN_APP',
    locale: 'fr',
    subject: 'Nouvelle demande de téléconsultation',
    body: 'Une nouvelle demande de téléconsultation {{reference}} vous est adressée.',
  },
  {
    code: 'consultation.created',
    channel: 'IN_APP',
    locale: 'ar',
    subject: 'طلب استشارة عن بعد جديد',
    body: 'وصل طلب استشارة عن بعد جديد بالمرجع {{reference}}.',
  },
  {
    code: 'consultation.closed',
    channel: 'IN_APP',
    locale: 'fr',
    subject: 'Consultation clôturée',
    body: 'La consultation {{reference}} est clôturée.',
  },
  {
    code: 'consultation.closed',
    channel: 'IN_APP',
    locale: 'ar',
    subject: 'تم إغلاق الاستشارة',
    body: 'تم إغلاق الاستشارة {{reference}}.',
  },
  {
    code: 'payment.received',
    channel: 'IN_APP',
    locale: 'ar',
    subject: 'تم استلام الدفع',
    body: 'استلمنا دفعكم بقيمة {{amount}} دج بعنوان {{reference}}.',
  },
];

/** Insère les modèles par défaut s'ils manquent (idempotent). */
export async function seedTemplates() {
  for (const tpl of DEFAULT_TEMPLATES) {
    await db().query(
      `INSERT INTO notification_templates (code, channel, locale, subject, body, whatsapp_template_name)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code, channel, locale) DO NOTHING`,
      [tpl.code, tpl.channel, tpl.locale, tpl.subject ?? '', tpl.body, tpl.whatsapp_template_name ?? null],
    );
  }
}

/** Remplace les variables `{{…}}` d'un modèle. */
export function render(template, payload = {}) {
  return String(template ?? '').replace(/\{\{(\w+)\}\}/g, (_, key) =>
    payload[key] === undefined || payload[key] === null ? '' : String(payload[key]),
  );
}

/**
 * File un message WhatsApp.
 * Mode officiel : enregistré en attente d'envoi par l'API Cloud.
 * Mode repli   : produit un lien `wa.me` prêt à cliquer (aucun envoi
 *                automatisé, donc aucun risque de blocage du compte).
 */
export async function queueWhatsApp({ phone, templateCode, locale = 'fr', payload = {}, dedupeKey = null }) {
  const normalized = normalizePhone(phone);
  if (!normalized) return { skipped: 'invalid_phone' };

  const template = await one(
    `SELECT * FROM notification_templates WHERE code = $1 AND channel = 'WHATSAPP' AND locale = $2 AND active`,
    [templateCode, locale],
  );
  const body = template ? render(template.body, payload) : render(payload.fallback_body ?? '', payload);
  if (!body) return { skipped: 'no_template' };

  const mode = config.notifications.whatsapp.provider === 'official' && config.notifications.whatsapp.token
    ? 'OFFICIAL_API'
    : 'CLICK_TO_CHAT';

  if (dedupeKey) {
    const existing = await one('SELECT id FROM notifications WHERE dedupe_key = $1', [dedupeKey]);
    if (existing) return { skipped: 'duplicate', notificationId: existing.id };
  }

  const row = await one(
    `INSERT INTO wa_messages (to_phone, template_name, locale, body, mode, status)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, mode, body`,
    [normalized, template?.whatsapp_template_name ?? null, locale, body, mode, mode === 'OFFICIAL_API' ? 'QUEUED' : 'CLICK_READY'],
  );

  const clickToChat = `https://wa.me/${normalized.replace('+', '')}?text=${encodeURIComponent(body.slice(0, 900))}`;
  return {
    messageId: row.id,
    mode,
    body,
    click_to_chat: mode === 'CLICK_TO_CHAT' ? clickToChat : null,
    note:
      mode === 'CLICK_TO_CHAT'
        ? 'Mode repli : le patient envoie lui-même le message (aucun envoi automatique).'
        : 'Envoi par l\'API WhatsApp Business officielle (file d\'envoi).',
  };
}

/**
 * Envoie une notification sur un ou plusieurs canaux, en respectant les
 * préférences et l'anti-doublon.
 */
export async function notify({
  userId = null,
  patientId = null,
  phone = null,
  templateCode,
  locale = 'fr',
  payload = {},
  channels = ['IN_APP'],
  dedupeKey = null,
}) {
  const results = [];

  for (const channel of channels) {
    if (userId) {
      const pref = await one(
        `SELECT enabled FROM notification_preferences WHERE user_id = $1 AND event_code = $2 AND channel = $3`,
        [userId, templateCode, channel],
      );
      if (pref && pref.enabled === false) {
        results.push({ channel, skipped: 'preference_disabled' });
        continue;
      }
    }

    if (channel === 'WHATSAPP') {
      if (!phone) {
        results.push({ channel, skipped: 'no_phone' });
        continue;
      }
      const sent = await queueWhatsApp({ phone, templateCode, locale, payload, dedupeKey });
      // Marqueur d'envoi : sans lui, `dueReminders()` ne verrait jamais de trace
      // et renverrait le même rappel à chaque passage du worker.
      if (dedupeKey) {
        await db().query(
          `INSERT INTO notifications
             (user_id, patient_id, channel, template_code, locale, payload, body, status, dedupe_key, sent_at)
           VALUES ($1,$2,'WHATSAPP',$3,$4,$5,$6,$7,$8, CASE WHEN $7 = 'SENT' THEN now() ELSE NULL END)
           ON CONFLICT DO NOTHING`,
          [
            userId,
            patientId,
            templateCode,
            locale,
            JSON.stringify(payload),
            sent.body ?? '',
            sent.skipped ? 'FAILED' : 'QUEUED',
            dedupeKey,
          ],
        );
      }
      results.push({ channel, ...sent });
      continue;
    }

    const template = await one(
      `SELECT * FROM notification_templates WHERE code = $1 AND channel = $2 AND locale = $3 AND active`,
      [templateCode, channel, locale],
    );
    const body = template ? render(template.body, payload) : '';
    const subject = template ? render(template.subject, payload) : '';

    try {
      const inserted = await db().query(
        `INSERT INTO notifications
           (user_id, patient_id, channel, template_code, locale, payload, body, status, dedupe_key, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $8 = 'SENT' THEN now() ELSE NULL END)
         -- L index unique sur dedupe_key est partiel (cle non NULL) : Postgres
         -- refuse toute inference de contrainte, d ou la forme sans cible.
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          userId,
          patientId,
          channel,
          templateCode,
          locale,
          JSON.stringify(payload),
          body || subject,
          channel === 'IN_APP' ? 'SENT' : 'QUEUED',
          dedupeKey,
        ],
      );
      results.push({ channel, notificationId: inserted.rows[0]?.id ?? null, body });
    } catch (error) {
      results.push({ channel, error: error.message });
    }
  }

  await audit({
    action: 'notification.queued',
    entity: 'notification',
    entityId: userId ?? patientId ?? undefined,
    details: { template: templateCode, channels, locale },
  });
  return results;
}

/** Notifications in-app d'un utilisateur. */
export async function listForUser(userId, { limit = 30 } = {}) {
  return many(
    `SELECT id, template_code, locale, body, status, read_at, created_at
       FROM notifications
      WHERE user_id = $1 AND channel = 'IN_APP'
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, Math.min(limit, 100)],
  );
}

/** Marque comme lues. */
export async function markRead(userId, notificationId = null) {
  if (notificationId) {
    await db().query(
      `UPDATE notifications SET status = 'READ', read_at = now()
        WHERE id = $1 AND user_id = $2`,
      [notificationId, userId],
    );
  } else {
    await db().query(
      `UPDATE notifications SET status = 'READ', read_at = now()
        WHERE user_id = $1 AND channel = 'IN_APP' AND read_at IS NULL`,
      [userId],
    );
  }
  return { ok: true };
}

/** Préférences (celles qui n'existent pas sont actives par défaut). */
export async function preferences(userId) {
  const rows = await many(
    `SELECT event_code, channel, enabled FROM notification_preferences WHERE user_id = $1`,
    [userId],
  );
  const map = new Map(rows.map((r) => [`${r.event_code}:${r.channel}`, r.enabled]));
  const channels = ['IN_APP', 'EMAIL', 'WHATSAPP', 'SMS'];
  return EVENTS.flatMap((event) =>
    channels.map((channel) => ({
      event_code: event,
      channel,
      enabled: map.get(`${event}:${channel}`) ?? channel === 'IN_APP',
    })),
  );
}

/** Enregistre une préférence. */
export async function setPreference(userId, { eventCode, channel, enabled }) {
  if (!EVENTS.includes(eventCode)) return { error: 'event_unknown' };
  if (!['IN_APP', 'EMAIL', 'WHATSAPP', 'SMS'].includes(channel)) return { error: 'channel_unknown' };
  await db().query(
    `INSERT INTO notification_preferences (user_id, event_code, channel, enabled)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, event_code, channel) DO UPDATE SET enabled = excluded.enabled`,
    [userId, eventCode, channel, Boolean(enabled)],
  );
  return { ok: true };
}

/** Rappels à envoyer : rendez-vous confirmés dans les 24 h suivantes. */
export async function dueReminders() {
  return many(
    `SELECT a.id, a.reference, a.patient_id, p.full_name, p.phone,
            s.starts_at, u.full_name AS doctor_name, u.locale
       FROM appointments a
       JOIN doctor_slots s ON s.id = a.slot_id
       JOIN patients p ON p.id = a.patient_id
       JOIN doctors d ON d.id = a.doctor_id
       JOIN users u ON u.id = d.user_id
      WHERE a.status = 'CONFIRMED'
        AND s.starts_at BETWEEN now() AND now() + interval '24 hours'
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.dedupe_key = 'reminder:' || a.id::text)
      LIMIT 200`,
  );
}

/** Envoie les rappels dus (worker). */
export async function sendDueReminders() {
  const rows = await dueReminders();
  let sent = 0;
  for (const row of rows) {
    const when = new Date(row.starts_at);
    const payload = {
      reference: row.reference,
      date: when.toISOString().slice(0, 10),
      time: when.toISOString().slice(11, 16),
      doctor: row.doctor_name,
    };
    await notify({
      userId: null,
      patientId: row.patient_id,
      phone: row.phone,
      templateCode: 'booking.reminder',
      locale: row.locale === 'ar' ? 'ar' : 'fr',
      payload,
      channels: ['WHATSAPP'],
      dedupeKey: `reminder:${row.id}`,
    });
    sent += 1;
  }
  return { sent };
}
