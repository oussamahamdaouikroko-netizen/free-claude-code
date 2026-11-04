/** Connexion et inscription (patient ou médecin). */

import { t, getLocale } from '../i18n.js';
import * as api from '../api.js';
import { h, raw, notice } from '../ui.js';
import { bindInteractions } from './bindings.js';

let specialties = null;
async function loadSpecialties() {
  if (specialties) return specialties;
  const data = await api.get('/reference/specialties');
  specialties = data.items;
  return specialties;
}

let wilayas = null;
async function loadWilayas() {
  if (wilayas) return wilayas;
  const data = await api.get('/reference/wilayas');
  wilayas = data.items;
  return wilayas;
}

export async function renderLogin({ state }) {
  bindInteractions();
  void state;
  return String(h`
    <div class="card form-narrow">
      <h1>${t('auth.login')}</h1>
      <p class="muted">${t('auth.loginSubtitle')}</p>
      <form data-form="login" autocomplete="on">
        <div class="field">
          <label for="identifier">${t('auth.identifier')}</label>
          <input id="identifier" name="identifier" type="text" autocomplete="username"
                 required maxlength="190" />
        </div>
        <div class="field">
          <label for="password">${t('common.password')}</label>
          <input id="password" name="password" type="password" autocomplete="current-password"
                 required maxlength="128" />
        </div>
        <div class="btn-row">
          <button class="btn" type="submit">${t('auth.login')}</button>
        </div>
      </form>
      <p class="small muted" style="margin-top:16px">
        ${t('auth.noAccount')} <a href="#/register">${t('auth.register')}</a>
      </p>
    </div>`);
}

export async function renderRegister({ params }) {
  void params;
  const [list, regions] = await Promise.all([loadSpecialties(), loadWilayas()]);
  const ar = getLocale() === 'ar';
  bindInteractions();

  return String(h`
    <div class="card form-narrow">
      <h1>${t('auth.register')}</h1>
      <p class="muted">${t('auth.registerSubtitle')}</p>
      <form data-form="register" autocomplete="on">
        <div class="field">
          <label for="fullName">${t('common.name')}</label>
          <input id="fullName" name="fullName" type="text" required minlength="3" maxlength="160"
                 autocomplete="name" />
        </div>
        <div class="field">
          <label for="phone">${t('common.phone')}</label>
          <input id="phone" name="phone" type="tel" required maxlength="30" autocomplete="tel"
                 inputmode="tel" placeholder="0X XX XX XX XX" />
          <div class="field-hint">0550 12 34 56 · +213550123456</div>
        </div>
        <div class="field">
          <label for="wilaya_code">${t('common.wilaya')}</label>
          <select id="wilaya_code" name="wilaya_code">
            ${raw(regions.map((w) => h`<option value="${w.code}">${w.code} — ${ar ? w.name_ar : w.name_fr}</option>`).join(''))}
          </select>
        </div>
        <div class="field">
          <label for="password">${t('common.password')}</label>
          <input id="password" name="password" type="password" required minlength="10" maxlength="128"
                 autocomplete="new-password" />
          <div class="field-hint">10 ${t('common.required')} · majuscule, minuscule, chiffre, symbole</div>
        </div>

        <fieldset>
          <legend>${t('auth.doctorAccount')}</legend>
          <label class="checkbox">
            <input type="checkbox" name="role" value="DOCTOR" />
            <span>${t('auth.doctorAccount')}</span>
          </label>
          <div class="field">
            <label for="specialtyCode">${t('auth.specialty')}</label>
            <select id="specialtyCode" name="specialtyCode">
              ${raw(list.map((s) => h`<option value="${s.code}">${ar ? s.name_ar : s.name_fr}</option>`).join(''))}
            </select>
          </div>
          <div class="field">
            <label for="licenseNo">${t('auth.license')} (${t('common.optional')})</label>
            <input id="licenseNo" name="licenseNo" type="text" maxlength="60" />
          </div>
          <p class="small muted">${t('auth.doctorPending')}</p>
        </fieldset>

        <label class="checkbox">
          <input type="checkbox" name="consent" required />
          <span>${t('auth.consent')}</span>
        </label>

        <div class="btn-row">
          <button class="btn" type="submit">${t('auth.register')}</button>
        </div>
      </form>
      <p class="small muted" style="margin-top:16px">
        ${t('auth.haveAccount')} <a href="#/login">${t('auth.login')}</a>
      </p>
      ${raw(notice('info', t('footer.legal')))}
    </div>`);
}
