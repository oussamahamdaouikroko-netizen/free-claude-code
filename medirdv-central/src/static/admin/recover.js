'use strict';
/**
 * Administrator recovery screen (local installs only).
 *
 * The server exposes /api/recovery/status and /api/recovery/reset, which are
 * enabled only for a local (loopback) request on an instance that has no
 * external exposure configured. Recovery keeps all business records.
 */
const $ = (id) => document.getElementById(id);
const message = () => $('recover-message');

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || 'Erreur');
  return data;
}

async function init() {
  try {
    const status = await api('/api/recovery/status');
    if (!status.available) {
      $('recover-form').classList.add('hidden');
      $('recover-unavailable').classList.remove('hidden');
      return;
    }
    if (status.email) $('recover-email').value = status.email;
  } catch {
    $('recover-form').classList.add('hidden');
    $('recover-unavailable').classList.remove('hidden');
  }
}

$('recover-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = $('recover-email').value.trim();
  const password = $('recover-password').value;
  const confirm = $('recover-password2').value;
  const box = message();
  box.className = 'error';
  box.textContent = '';

  if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
    box.textContent = 'Entrez une adresse email valide.';
    return;
  }
  if (password.length < 8) {
    box.textContent = 'Le mot de passe doit contenir au moins 8 caractères.';
    return;
  }
  if (password !== confirm) {
    box.textContent = 'Les mots de passe ne correspondent pas.';
    return;
  }

  $('recover-submit').disabled = true;
  box.textContent = 'Enregistrement…';
  try {
    await api('/api/recovery/reset', { method: 'POST', body: JSON.stringify({ email, password }) });
    box.className = 'success';
    box.textContent = 'Terminé. Vous pouvez vous connecter avec ces identifiants.';
    // Inside the desktop app this returns to the dashboard; in a browser it
    // is harmless.
    setTimeout(() => { window.location.hash = 'done'; }, 900);
  } catch (error) {
    box.className = 'error';
    box.textContent = error.message;
  } finally {
    $('recover-submit').disabled = false;
  }
});

init();
