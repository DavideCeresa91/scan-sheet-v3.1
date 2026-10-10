import {APP_CONFIG, OAUTH_REDIRECT_URI} from './config.js';

export const OAUTH_RESULT_KEY = 'barcode-bipper:v1:oauth-result';
export const OAUTH_PENDING_KEY = 'barcode-bipper:v1:oauth-pending';
export const OAUTH_RETURN_KEY = 'barcode-bipper:v1:return-after-oauth';
let pickerPromise;

function configuredValue(value, placeholder) {
  return typeof value === 'string' && value.trim() && !value.includes(placeholder);
}

export function googleConfigReady() {
  return configuredValue(APP_CONFIG.google.apiKey, 'INSERISCI_') &&
    configuredValue(APP_CONFIG.google.appId, 'INSERISCI_') &&
    /^https:\/\//.test(OAUTH_REDIRECT_URI);
}

export function googleConfigError() {
  return googleConfigReady() ? '' : 'Completa site/config.js con API key e numero progetto Google Cloud.';
}

export function oauthRedirectUri() { return OAUTH_REDIRECT_URI; }

function loadScript(id, src) {
  const existing = document.getElementById(id);
  if (existing) {
    if (existing.dataset.loaded === 'true') return Promise.resolve();
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', resolve, {once:true});
      existing.addEventListener('error', () => reject(new Error('Impossibile caricare Google Picker.')), {once:true});
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.id = id;
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = () => { script.dataset.loaded = 'true'; resolve(); };
    script.onerror = () => reject(new Error('Impossibile caricare Google Picker.'));
    document.head.append(script);
  });
}

function waitFor(test, message, timeout = 15000) {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (test()) return resolve();
      if (performance.now() - start > timeout) return reject(new Error(message));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function initPicker() {
  if (!googleConfigReady()) throw new Error(googleConfigError());
  if (!pickerPromise) pickerPromise = (async () => {
    await loadScript('google-api', 'https://apis.google.com/js/api.js');
    await waitFor(() => window.gapi, 'Google Picker non si è inizializzato.');
    await new Promise((resolve, reject) => {
      try {
        gapi.load('picker', {callback:resolve, onerror:()=>reject(new Error('Google Picker non disponibile.'))});
      } catch {
        reject(new Error('Google Picker non disponibile.'));
      }
    });
  })().catch(error => { pickerPromise = null; throw error; });
  await pickerPromise;
}

export function storePendingOAuth(data) {
  localStorage.setItem(OAUTH_PENDING_KEY, JSON.stringify(data));
}

export function takePendingOAuth() {
  try {
    const raw = localStorage.getItem(OAUTH_PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearPendingOAuth() {
  localStorage.removeItem(OAUTH_PENDING_KEY);
}

export function takeOAuthResult() {
  try {
    const raw = localStorage.getItem(OAUTH_RESULT_KEY);
    if (!raw) return null;
    localStorage.removeItem(OAUTH_RESULT_KEY);
    return JSON.parse(raw);
  } catch { return null; }
}

export function openOAuthWindow() {
  try { return window.open('about:blank', 'barcode-bipper-oauth', 'popup,width=520,height=720'); }
  catch { return null; }
}

export async function waitForOAuthResult(popup, authUrl, expectedState) {
  localStorage.removeItem(OAUTH_RESULT_KEY);

  if (popup && !popup.closed) {
    popup.location.replace(authUrl);
  } else {
    localStorage.setItem(OAUTH_RETURN_KEY, location.href);
    location.assign(authUrl);
    return new Promise(() => {});
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => done(reject, new Error('Autorizzazione Google non completata. Riprova.')), 300000);
    const poll = setInterval(checkStored, 400);
    const onStorage = event => { if (event.key === OAUTH_RESULT_KEY) checkStored(); };
    const onMessage = event => {
      if (event.origin !== location.origin || event.data?.type !== 'barcode-bipper:oauth-result') return;
      consume(event.data.result);
    };

    function cleanup() {
      clearTimeout(timeout);
      clearInterval(poll);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('message', onMessage);
    }
    function done(fn, value) {
      if (settled) return;
      settled = true;
      cleanup();
      try { if (popup && !popup.closed) popup.close(); } catch {}
      fn(value);
    }
    function consume(result) {
      if (!result) return;
      localStorage.removeItem(OAUTH_RESULT_KEY);
      if (result.state !== expectedState) return done(reject, new Error('Risposta OAuth non valida. Riprova il collegamento.'));
      if (result.error) return done(reject, new Error(result.errorDescription || 'Autorizzazione Google annullata.'));
      if (!result.code) return done(reject, new Error('Google non ha restituito il codice di autorizzazione.'));
      done(resolve, {code:result.code, state:result.state});
    }
    function checkStored() { consume(takeOAuthResult()); }

    window.addEventListener('storage', onStorage);
    window.addEventListener('message', onMessage);
    checkStored();
  });
}

export async function pickSpreadsheet(accessToken) {
  if (typeof accessToken !== 'string' || accessToken.length < 20) throw new Error('Token Google Picker non valido.');
  await initPicker();
  return new Promise((resolve, reject) => {
    const view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS)
      .setIncludeFolders(false)
      .setMode(google.picker.DocsViewMode.LIST);

    const picker = new google.picker.PickerBuilder()
      .addView(view)
      .enableFeature(google.picker.Feature.NAV_HIDDEN)
      .setOAuthToken(accessToken)
      .setDeveloperKey(APP_CONFIG.google.apiKey)
      .setAppId(APP_CONFIG.google.appId)
      .setOrigin(location.origin)
      .setLocale('it')
      .setTitle('Scegli il registro Barcode Bipper')
      .setCallback(data => {
        if (data.action === google.picker.Action.CANCEL) return resolve(null);
        if (data.action !== google.picker.Action.PICKED) return;
        const doc = data[google.picker.Response.DOCUMENTS]?.[0];
        const id = doc?.[google.picker.Document.ID] || doc?.id;
        const name = doc?.[google.picker.Document.NAME] || doc?.name || 'Google Sheet';
        if (!id) return reject(new Error('Google Picker non ha restituito un file valido.'));
        resolve({id, name});
      })
      .build();
    picker.setVisible(true);
  });
}
