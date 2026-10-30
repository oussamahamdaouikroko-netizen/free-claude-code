'use strict';
/**
 * Central configurable constants for DentaRDV.
 * Keep operational tunables in one place for easy adjustment.
 */

const APP_NAME = 'DentaRDV';
const CANCEL_COOLDOWN_MINUTES = 30;
const STARTUP_DELAY_SECONDS = 15;
const ALGERIA_TIMEZONE = 'Africa/Algiers'; // UTC+1 year-round (no DST)

const TRAY_TOOLTIP = 'بوت عيادة الأسنان - يعمل';
const TRAY_MENU_OPEN = 'فتح';
const TRAY_MENU_LICENSE = 'الترخيص';
const TRAY_MENU_AUTOSTART_ON = 'تشغيل مع Windows ✓';
const TRAY_MENU_AUTOSTART_OFF = 'تشغيل مع Windows';
const TRAY_MENU_QUIT = 'إغلاق نهائي';
const TRAY_QUIT_CONFIRM_MESSAGE = 'سيتوقف البوت ولن يستقبل المرضى. هل أنت متأكد؟';
const TRAY_BACKGROUND_NOTIFICATION =
  'البرنامج ما زال يعمل في الخلفية، يمكنك فتحه من أيقونة الساعة.';

/**
 * Offline Activation License Plans & Tunables for DentaRDV.
 * Independent keypair + 7-day automatic offline trial on first install.
 */
const PLANS = Object.freeze({
  '1M': 30,
  '6M': 180,
  '1Y': 365,
});
const LICENSE_BIND_TO_MACHINE = true;
const TRIAL_DAYS = 7;
const LICENSE_WARN_DAYS = 7;
const LICENSE_CHECK_INTERVAL_MINUTES = 60;
const LICENSE_CLOCK_SKEW_MINUTES = 10;

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
    const dz = new Date(d.getTime() + 60 * 60 * 1000);
    const hh = String(dz.getUTCHours()).padStart(2, '0');
    const mm = String(dz.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
}

/**
 * Convert a UTC timestamp to `YYYY-MM-DD` in Algeria local time (`Africa/Algiers`, UTC+1).
 */
function algeriaISODate(utcInput) {
  const d = utcInput instanceof Date ? utcInput : new Date(utcInput);
  if (Number.isNaN(d.getTime())) return '';
  const dz = new Date(d.getTime() + 60 * 60 * 1000);
  const yyyy = String(dz.getUTCFullYear()).padStart(4, '0');
  const mm = String(dz.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dz.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Format a UTC timestamp as `DD/MM/YYYY` in Algeria local time (`Africa/Algiers`, UTC+1).
 */
function formatAlgeriaDate(utcInput) {
  const iso = algeriaISODate(utcInput);
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

module.exports = {
  APP_NAME,
  CANCEL_COOLDOWN_MINUTES,
  STARTUP_DELAY_SECONDS,
  ALGERIA_TIMEZONE,
  TRAY_TOOLTIP,
  TRAY_MENU_OPEN,
  TRAY_MENU_LICENSE,
  TRAY_MENU_AUTOSTART_ON,
  TRAY_MENU_AUTOSTART_OFF,
  TRAY_MENU_QUIT,
  TRAY_QUIT_CONFIRM_MESSAGE,
  TRAY_BACKGROUND_NOTIFICATION,
  PLANS,
  LICENSE_BIND_TO_MACHINE,
  TRIAL_DAYS,
  LICENSE_WARN_DAYS,
  LICENSE_CHECK_INTERVAL_MINUTES,
  LICENSE_CLOCK_SKEW_MINUTES,
  formatAlgeriaTime,
  algeriaISODate,
  formatAlgeriaDate,
};
