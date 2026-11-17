"""Arabic / French strings for server-generated messages (Part 11).

The SPA ships its own UI dictionary in static/app.js; this module covers
WhatsApp templates, notifications and error messages sent by the backend.
"""
from __future__ import annotations

STRINGS: dict[str, dict[str, str]] = {
    "booking_request": {
        "fr": (
            "Nouvelle demande de rendez-vous\n\n"
            "Patient : {patient}\n"
            "Référence : {ref}\n"
            "Date : {date}\n"
            "Heure : {time}\n"
            "Clinique : {clinic}\n\n"
            "Veuillez choisir :\n"
            "✅ Accepter le rendez-vous\n"
            "❌ Refuser le rendez-vous\n"
            "🕐 Demander un autre horaire"
        ),
        "ar": (
            "طلب موعد جديد\n\n"
            "المريض: {patient}\n"
            "المرجع: {ref}\n"
            "التاريخ: {date}\n"
            "الوقت: {time}\n"
            "العيادة: {clinic}\n\n"
            "يرجى الاختيار:\n"
            "✅ قبول الموعد\n"
            "❌ رفض الموعد\n"
            "🕐 طلب وقت آخر"
        ),
    },
    "booking_accepted": {
        "fr": "Votre rendez-vous {ref} a été confirmé par le médecin. Date : {date} à {time}.",
        "ar": "تم تأكيد موعدك {ref} من طرف الطبيب. التاريخ: {date} على الساعة {time}.",
    },
    "booking_rejected": {
        "fr": "Votre demande {ref} n'a pas pu être confirmée. Veuillez choisir un autre horaire ou un autre médecin.",
        "ar": "تعذر تأكيد طلبك {ref}. يرجى اختيار وقت آخر أو طبيب آخر.",
    },
    "booking_reschedule": {
        "fr": "Le médecin propose un autre horaire pour {ref}. Vous pouvez accepter ou refuser depuis votre suivi de réservation.",
        "ar": "يقترح الطبيب وقتا آخر للموعد {ref}. يمكنك القبول أو الرفض من تتبع الحجز.",
    },
    "payment_received": {
        "fr": "Votre paiement pour {ref} a été vérifié. Votre demande est transmise au médecin.",
        "ar": "تم التحقق من دفعك للموعد {ref}. تم إرسال طلبك إلى الطبيب.",
    },
    "payment_rejected": {
        "fr": "Votre paiement pour {ref} n'a pas pu être vérifié ({reason}). Veuillez vérifier la référence et réessayer.",
        "ar": "تعذر التحقق من دفعك للموعد {ref} ({reason}). يرجى التحقق من المرجع وإعادة المحاولة.",
    },
    "booking_expired": {
        "fr": "Le délai de réponse du médecin pour {ref} est écoulé. Vous pouvez choisir un autre horaire ou un autre médecin.",
        "ar": "انتهت مهلة رد الطبيب للموعد {ref}. يمكنك اختيار وقت آخر أو طبيب آخر.",
    },
    "booking_cancelled": {
        "fr": "Votre rendez-vous {ref} a été annulé.",
        "ar": "تم إلغاء موعدك {ref}.",
    },
    "reminder": {
        "fr": "Rappel : votre rendez-vous {ref} est prévu le {date} à {time}.",
        "ar": "تذكير: موعدك {ref} مبرمج يوم {date} على الساعة {time}.",
    },
}


def t(key: str, lang: str = "fr", **kwargs: str) -> str:
    lang = lang if lang in ("fr", "ar") else "fr"
    template = STRINGS.get(key, {}).get(lang, key)
    return template.format(**kwargs)
