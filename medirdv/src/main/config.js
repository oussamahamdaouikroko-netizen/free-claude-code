'use strict';
/**
 * Central configurable constants for MediRDV.
 * Keep operational tunables in one place for easy adjustment.
 */

const APP_NAME = 'MediRDV';
const CANCEL_COOLDOWN_MINUTES = 30;
const STARTUP_DELAY_SECONDS = 15;
const ALGERIA_TIMEZONE = 'Africa/Algiers'; // UTC+1 year-round (no DST)

const TRAY_TOOLTIP = 'بوت العيادة - يعمل';
const TRAY_MENU_OPEN = 'فتح';
const TRAY_MENU_AUTOSTART_ON = 'تشغيل مع Windows ✓';
const TRAY_MENU_AUTOSTART_OFF = 'تشغيل مع Windows';
const TRAY_MENU_QUIT = 'إغلاق نهائي';
const TRAY_QUIT_CONFIRM_MESSAGE = 'سيتوقف البوت ولن يستقبل المرضى. هل أنت متأكد؟';
const TRAY_BACKGROUND_NOTIFICATION =
  'البرنامج ما زال يعمل في الخلفية، يمكنك فتحه من أيقونة الساعة.';

/**
 * Format a UTC timestamp (ms or ISO string) as HH:MM in Algeria local time (UTC+1).
 */
function formatAlgeriaTime(utcInput) {
  const d = utcInput instanceof Date ? utcInput : new Date(utcInput);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('fr-DZ', {
      timeZone: ALGERIA_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
  } catch (_err) {
    // Fallback: Algeria is permanently UTC+1
    const dz = new Date(d.getTime() + 60 * 60 * 1000);
    const hh = String(dz.getUTCHours()).padStart(2, '0');
    const mm = String(dz.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
}

module.exports = {
  APP_NAME,
  CANCEL_COOLDOWN_MINUTES,
  STARTUP_DELAY_SECONDS,
  ALGERIA_TIMEZONE,
  TRAY_TOOLTIP,
  TRAY_MENU_OPEN,
  TRAY_MENU_AUTOSTART_ON,
  TRAY_MENU_AUTOSTART_OFF,
  TRAY_MENU_QUIT,
  TRAY_QUIT_CONFIRM_MESSAGE,
  TRAY_BACKGROUND_NOTIFICATION,
  formatAlgeriaTime,
};
