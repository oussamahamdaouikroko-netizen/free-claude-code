/**
 * UI sound effects, synthesized with the Web Audio API.
 *
 * Why synthesized and not .mp3 files:
 *  - zero bytes added to the installer, nothing to license;
 *  - no resource loaded → the strict CSP of this app stays untouched;
 *  - the clinic can turn sounds off, and they never play before a real click
 *    (browsers require a user gesture anyway).
 *
 * Sounds are short, soft and low-volume on purpose: a dental office, not an
 * arcade. All of them can be muted from Settings → Sounds.
 *
 *   SFX.click()     soft tick on any button / nav item
 *   SFX.success()   two-note rising chime (saved, payment recorded)
 *   SFX.error()     short low buzz (validation failed)
 *   SFX.open()      airy whoosh (modal / screen change)
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'dentardv.sounds';
  const VOLUME = 0.12; // deliberately quiet; a click must not startle

  let context = null;
  let enabled = readPreference();

  function readPreference() {
    try {
      return localStorage.getItem(STORAGE_KEY) !== 'off';
    } catch (error) {
      return true; // private mode: default on, nothing to persist
    }
  }

  /** Create (or resume) the AudioContext. Must run inside a user gesture. */
  function ctx() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    if (!context) context = new Ctor();
    if (context.state === 'suspended') context.resume().catch(() => {});
    return context;
  }

  /**
   * One tiny synthesised note.
   * @param {{freq: number, to?: number, type?: OscillatorType, at?: number,
   *          duration?: number, gain?: number}} spec
   */
  function tone({ freq, to, type = 'sine', at = 0, duration = 0.06, gain = 1 }) {
    const audio = ctx();
    if (!audio) return;
    const start = audio.currentTime + at;
    const osc = audio.createOscillator();
    const amp = audio.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (to && to !== freq) osc.frequency.exponentialRampToValueAtTime(to, start + duration);

    // Fast attack, exponential decay: the classic "tick".
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(VOLUME * gain, start + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(amp).connect(audio.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  function guarded(fn) {
    return (...args) => {
      if (!enabled) return;
      try {
        fn(...args);
      } catch (error) {
        /* a silent UI is better than a broken one */
      }
    };
  }

  const click = guarded(() => {
    // Two short components: a soft wooden tick, not a beep.
    tone({ freq: 1250, to: 720, type: 'triangle', duration: 0.045, gain: 0.55 });
    tone({ freq: 320, to: 260, type: 'sine', at: 0.004, duration: 0.05, gain: 0.35 });
  });

  const success = guarded(() => {
    tone({ freq: 660, type: 'sine', duration: 0.1, gain: 0.7 });
    tone({ freq: 990, type: 'sine', at: 0.08, duration: 0.16, gain: 0.55 });
  });

  const error = guarded(() => {
    tone({ freq: 220, to: 165, type: 'square', duration: 0.14, gain: 0.32 });
  });

  const open = guarded(() => {
    tone({ freq: 520, to: 900, type: 'sine', duration: 0.09, gain: 0.34 });
  });

  function setEnabled(value) {
    enabled = Boolean(value);
    try {
      localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
    } catch (error) {
      /* ignore */
    }
    if (enabled) click(); // immediate feedback when turning sounds on
    return enabled;
  }

  /** Global delegation: every button click and nav item makes the same tick. */
  function install() {
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target instanceof Element ? event.target.closest('button, .nav-item, .tag, label.switch') : null;
        if (!target || target.disabled) return;
        if (target.dataset.silent === 'true') return;
        click();
      },
      { capture: true, passive: true },
    );
  }

  window.SFX = {
    click,
    success,
    error,
    open,
    install,
    setEnabled,
    isEnabled: () => enabled,
    /** Used by tests: the preference is read from localStorage. */
    readPreference,
  };
})();
