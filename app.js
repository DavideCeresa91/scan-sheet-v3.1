import {APP_CONFIG} from './config.js';
import {loadSettings, saveSettings, openDatabase, listRecords, addRecord, acknowledgeRecord, deleteSentRecords, csvText} from './storage.js';
import {GoogleBridge, normalizeEndpoint} from './transport.js';
import {
  googleConfigReady, googleConfigError, oauthRedirectUri,
  openOAuthWindow, waitForOAuthResult, pickSpreadsheet,
  storePendingOAuth, takePendingOAuth, clearPendingOAuth, takeOAuthResult
} from './google-auth.js';

const $ = id => document.getElementById(id);
const DEFAULT_PREFS = Object.freeze({
  operator:'',
  theme:'burgundy',
  customColor:'#923753',
  scanMode:'hold',
  vibrationEnabled:true,
  autoFlashEnabled:false,
  cameraRatio:'tall',
  cameraFit:'cover'
});
const THEMES = new Set(['green','blue','petrol','burgundy','purple','orange','graphite','custom']);

let settings = {...DEFAULT_PREFS, ...loadSettings()};
let records = [];
let bridge = null;
let storageReady = false;
let syncing = false;
let recording = false;
let configuring = false;
let retryTimer = null;
let retryDelay = 15000;
let installPrompt = null;
let googleNeedsReauth = false;
let syncStatus = '';
let syncStatusType = '';

let stream = null;
let cameraActive = false;
let cameraStarting = false;
let cameraGeneration = 0;
let reading = false;
let scanSession = 0;
let readTimer = null;
let torchOn = false;
let autoTorchEngaged = false;
let nativeDetector = null;
let zxingReader = null;
let decodeCanvas = null;
let decodeContext = null;

const timeFormat = new Intl.DateTimeFormat('it-IT', {
  day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit'
});

function persistSettings() {
  saveSettings(settings);
}

function validOperator(value) {
  return typeof value === 'string' && Boolean(value.trim()) && value.trim().length <= 80 &&
    !/[\x00-\x1f\x7f]/.test(value) && !/^[=+@]/.test(value.trim());
}

function validBarcode(value) {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 512 &&
    !/[\x00-\x1f\x7f]/.test(value) && !/^[=+@]/.test(value.trim());
}

function staticBackendEndpoint() {
  const value = APP_CONFIG.backendEndpoint;
  if (typeof value !== 'string' || !value.trim() || value.includes('INSERISCI_')) return '';
  try { return normalizeEndpoint(value); }
  catch { return ''; }
}

function backendEndpoint() {
  const configured = staticBackendEndpoint();
  if (configured) return configured;
  // Migrazione silenziosa dalla v3.1 sullo stesso browser.
  try { return settings.endpoint ? normalizeEndpoint(settings.endpoint) : ''; }
  catch { return ''; }
}

function backendReady() {
  return Boolean(backendEndpoint());
}

function pairingReady() {
  return Boolean(settings.linkId && settings.linkSecret);
}

function destinationReady() {
  return pairingReady() && Boolean(settings.spreadsheetId);
}

function registrationReady() {
  return storageReady && validOperator(settings.operator) && backendReady() && googleConfigReady() && destinationReady();
}

function feedback(text, type = 'success', element = $('feedback')) {
  element.textContent = text;
  element.className = 'feedback ' + type;
  element.hidden = false;
}

function hideFeedback(element = $('feedback')) {
  element.hidden = true;
  element.textContent = '';
}

function resetBridge() {
  bridge?.destroy();
  bridge = null;
}

function getBridge() {
  const endpoint = backendEndpoint();
  if (!endpoint) throw new Error('Il backend non è configurato nel file site/config.js.');
  if (!bridge || bridge.endpoint !== endpoint) {
    resetBridge();
    bridge = new GoogleBridge(endpoint);
  }
  return bridge;
}

function hexToRgb(hex) {
  const clean = String(hex).trim().replace('#','');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return {r:parseInt(clean.slice(0,2),16), g:parseInt(clean.slice(2,4),16), b:parseInt(clean.slice(4,6),16)};
}

function rgbToHex({r,g,b}) {
  const c = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2,'0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

function mix(hexA, hexB, amount) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  if (!a || !b) return hexA;
  return rgbToHex({r:a.r+(b.r-a.r)*amount, g:a.g+(b.g-a.g)*amount, b:a.b+(b.b-a.b)*amount});
}

function clearCustomThemeProperties() {
  const root = document.documentElement;
  ['--accent','--accent-hover','--accent-soft','--accent-border','--focus'].forEach(p => root.style.removeProperty(p));
}

function applyCustomColor(hex) {
  const normalized = String(hex || '').trim().toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(normalized)) return false;
  const root = document.documentElement;
  root.style.setProperty('--accent', normalized);
  root.style.setProperty('--accent-hover', mix(normalized,'#000000',.2));
  root.style.setProperty('--accent-soft', mix(normalized,'#FFFFFF',.9));
  root.style.setProperty('--accent-border', mix(normalized,'#FFFFFF',.68));
  root.style.setProperty('--focus', mix(normalized,'#FFFFFF',.38));
  document.querySelector('meta[name="theme-color"]').content = normalized;
  return true;
}

function applyTheme() {
  const theme = THEMES.has(settings.theme) ? settings.theme : 'burgundy';
  settings.theme = theme;
  document.documentElement.dataset.theme = theme === 'custom' ? 'burgundy' : theme;
  if (theme === 'custom') {
    applyCustomColor(settings.customColor || DEFAULT_PREFS.customColor);
  } else {
    clearCustomThemeProperties();
    requestAnimationFrame(() => {
      document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    });
  }
  $('custom-theme-controls').hidden = theme !== 'custom';
}

function applyCameraOptions() {
  const panel = $('camera-panel');
  panel.classList.remove('ratio-wide','ratio-tall','ratio-portrait','fit-cover','fit-contain');
  panel.classList.add('ratio-' + settings.cameraRatio, 'fit-' + settings.cameraFit);
}

function renderScanMode() {
  const continuous = settings.scanMode === 'continuous';
  document.body.classList.toggle('scan-mode-continuous', continuous);
  if (!reading) $('scan-label').textContent = 'Registra';
  if (continuous) {
    $('hold-hint').textContent = reading ? 'Ricerca del codice in corso…' : 'Premi per leggere';
    $('scan-mode-note').textContent = 'Premi Registra: la fotocamera cerca finché trova un codice o annulli.';
  } else {
    $('hold-hint').textContent = reading ? 'Lettura attiva · rilascia per fermare' : 'Tieni premuto per leggere';
    $('scan-mode-note').textContent = 'Il lettore è attivo soltanto mentre tieni premuto Registra.';
  }
}

function renderSettings() {
  $('operator').value = settings.operator || '';
  $('theme').value = THEMES.has(settings.theme) ? settings.theme : 'burgundy';
  $('custom-color').value = settings.customColor || DEFAULT_PREFS.customColor;
  $('custom-hex').value = (settings.customColor || DEFAULT_PREFS.customColor).toUpperCase();
  $('scan-mode').value = settings.scanMode === 'continuous' ? 'continuous' : 'hold';
  $('vibration-enabled').checked = settings.vibrationEnabled !== false;
  $('auto-flash-enabled').checked = Boolean(settings.autoFlashEnabled);
  $('camera-ratio').value = ['wide','tall','portrait'].includes(settings.cameraRatio) ? settings.cameraRatio : 'tall';
  $('camera-fit').value = settings.cameraFit === 'contain' ? 'contain' : 'cover';
  applyTheme();
  applyCameraOptions();
  renderScanMode();
}

function renderSetup() {
  $('operator-label').textContent = validOperator(settings.operator) ? settings.operator.trim() : 'Da impostare';
  $('destination-label').textContent = settings.destinationLabel || settings.spreadsheetName || (settings.spreadsheetId ? 'Google Sheet collegato' : 'Da configurare');
  $('network').textContent = navigator.onLine ? 'Online' : 'Senza rete';
  $('network').classList.toggle('offline', !navigator.onLine);
  $('submit-record').disabled = !registrationReady() || recording;

  let target = '';
  if (!validOperator(settings.operator)) {
    $('setup-title').textContent = 'Imposta l’operatore';
    $('setup-text').textContent = 'Serve solo il nome usato nelle registrazioni.';
    target = 'settings';
  } else if (!backendReady() || !googleConfigReady()) {
    $('setup-title').textContent = 'App da completare';
    $('setup-text').textContent = 'La configurazione tecnica del sito non è completa.';
    target = 'config';
  } else if (!destinationReady()) {
    $('setup-title').textContent = 'Collega il registro';
    $('setup-text').textContent = 'Collega Google e scegli il foglio una sola volta.';
    target = 'config';
  }
  $('setup-notice').hidden = !target;
  $('setup-action').dataset.target = target;
}

function renderConfigDialog() {
  const linked = pairingReady();
  $('google-status').textContent = googleNeedsReauth ? 'Da ricollegare' : (linked ? 'Collegato' : 'Non collegato');
  $('connect-google').textContent = googleNeedsReauth || linked ? 'Ricollega Google' : 'Collega Google';
  $('selected-sheet').textContent = settings.spreadsheetName || (settings.spreadsheetId ? 'Google Sheet collegato' : 'Non selezionato');
  $('selected-tab').textContent = settings.spreadsheetId ? (settings.sheetName ? 'Foglio: ' + settings.sheetName : '') : '';
  $('pick-sheet').textContent = settings.spreadsheetId ? 'Cambia' : 'Scegli';
  $('pick-sheet').disabled = configuring || !backendReady() || !googleConfigReady();
  $('connect-google').disabled = configuring || !backendReady() || !googleConfigReady();
  $('test-connection').disabled = configuring || !destinationReady() || !backendReady() || !navigator.onLine;

  const configError = $('config-error');
  const errors = [];
  if (!backendReady()) errors.push('Imposta BACKEND_ENDPOINT in site/config.js.');
  if (!googleConfigReady()) errors.push(googleConfigError());
  if (errors.length) {
    configError.textContent = errors.join(' ');
    configError.hidden = false;
  } else {
    configError.hidden = true;
  }

  const state = $('connection-state');
  state.classList.remove('ok','warning','error');
  if (googleNeedsReauth) {
    state.classList.add('warning');
    $('connection-state-text').textContent = 'Autorizzazione Google da rinnovare';
  } else if (destinationReady()) {
    state.classList.add('ok');
    $('connection-state-text').textContent = settings.destinationLabel ? 'Pronto · ' + settings.destinationLabel : 'Configurazione completata';
  } else if (linked) {
    state.classList.add('warning');
    $('connection-state-text').textContent = 'Google collegato · scegli il registro';
  } else {
    $('connection-state-text').textContent = 'Configurazione non completata';
  }
}

function renderSyncStatus() {
  const el = $('sync-message');
  if (!syncStatus) {
    el.hidden = true;
    el.textContent = '';
    el.className = 'sync-message';
    return;
  }
  el.hidden = false;
  el.textContent = syncStatus;
  el.className = 'sync-message' + (syncStatusType === 'error' ? ' error' : '');
}

async function renderRecords() {
  records = await listRecords();
  const pending = records.filter(r => r.status === 'pending').length;
  const sent = records.filter(r => r.status === 'sent').length;
  $('pending-count').textContent = pending + ' in attesa';
  $('pending-count').classList.toggle('waiting', pending > 0);
  $('sync-now').hidden = pending === 0;
  $('sync-now').disabled = pending === 0 || syncing || !navigator.onLine || !destinationReady();
  $('export-history').disabled = records.length === 0;
  $('clear-history').disabled = sent === 0;
  $('empty-state').hidden = records.length > 0;
  $('clear-pending-note').hidden = pending === 0;

  const nodes = records.slice(-10).reverse().map(record => {
    const li = document.createElement('li');
    li.className = 'record';
    const top = document.createElement('div'); top.className = 'record-top';
    const code = document.createElement('strong'); code.className = 'record-code'; code.textContent = record.barcode;
    const qty = document.createElement('span'); qty.className = 'record-qty'; qty.textContent = 'Qtà ' + new Intl.NumberFormat('it-IT').format(record.quantity);
    top.append(code, qty);
    const bottom = document.createElement('div'); bottom.className = 'record-bottom';
    const meta = document.createElement('span'); meta.className = 'record-meta'; meta.textContent = timeFormat.format(new Date(record.scannedAt)) + ' · ' + record.operator;
    const status = document.createElement('span'); status.className = 'record-state ' + record.status; status.textContent = record.status === 'sent' ? 'Salvato' : 'Da inviare';
    bottom.append(meta, status); li.append(top, bottom); return li;
  });
  $('records').replaceChildren(...nodes);
  renderSyncStatus();
}

function openDialog(dialog) {
  closeDrawer();
  setTimeout(() => {
    if (!dialog.open) dialog.showModal();
    syncModalLock();
  }, 100);
}

function openSettings() {
  renderSettings();
  openDialog($('settings-dialog'));
}

function openConfiguration() {
  renderConfigDialog();
  openDialog($('config-dialog'));
}

function openDrawer() {
  $('drawer-backdrop').hidden = false;
  requestAnimationFrame(() => {
    $('drawer-backdrop').classList.add('open');
    $('app-drawer').classList.add('open');
  });
  $('app-drawer').setAttribute('aria-hidden','false');
  $('menu-open').setAttribute('aria-expanded','true');
  document.body.classList.add('drawer-open');
}

function closeDrawer() {
  $('drawer-backdrop').classList.remove('open');
  $('app-drawer').classList.remove('open');
  $('app-drawer').setAttribute('aria-hidden','true');
  $('menu-open').setAttribute('aria-expanded','false');
  document.body.classList.remove('drawer-open');
  setTimeout(() => {
    if (!$('app-drawer').classList.contains('open')) $('drawer-backdrop').hidden = true;
  }, 180);
}

function syncModalLock() {
  document.body.classList.toggle('modal-open', Boolean(document.querySelector('dialog[open]')));
}

async function setupDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const supported = await BarcodeDetector.getSupportedFormats();
      const wanted = ['ean_13','ean_8','code_128','code_39','code_93','upc_a','upc_e','itf','codabar','qr_code']
        .filter(format => supported.includes(format));
      nativeDetector = new BarcodeDetector({formats:wanted.length ? wanted : supported});
    } catch { nativeDetector = null; }
  }
  if (!nativeDetector && window.ZXingBrowser) {
    zxingReader = new ZXingBrowser.BrowserMultiFormatReader();
    decodeCanvas = document.createElement('canvas');
    decodeContext = decodeCanvas.getContext('2d', {willReadFrequently:true});
  }
}

async function detectBarcodeFrame() {
  const video = $('video');
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return '';
  if (nativeDetector) {
    try {
      const codes = await nativeDetector.detect(video);
      return codes?.[0]?.rawValue || '';
    } catch { return ''; }
  }
  if (!zxingReader || !decodeContext) return '';
  const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
  decodeCanvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  decodeCanvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  decodeContext.drawImage(video, 0, 0, decodeCanvas.width, decodeCanvas.height);
  try { return zxingReader.decodeFromCanvas(decodeCanvas).getText() || ''; }
  catch { return ''; }
}

async function setTorch(next, {silent=false} = {}) {
  const track = stream?.getVideoTracks?.()[0];
  if (!track || !cameraActive) return false;
  let available = false;
  try { available = Boolean(track.getCapabilities?.().torch); } catch {}
  if (!available) return false;
  try {
    await track.applyConstraints({advanced:[{torch:Boolean(next)}]});
    torchOn = Boolean(next);
    $('torch-label').textContent = torchOn ? 'Spegni' : 'Torcia';
    $('torch').setAttribute('aria-pressed', String(torchOn));
    return true;
  } catch {
    torchOn = false;
    $('torch-label').textContent = 'Torcia';
    $('torch').setAttribute('aria-pressed','false');
    if (!silent) $('camera-message').textContent = 'Torcia non disponibile.';
    return false;
  }
}

async function toggleTorch() {
  await setTorch(!torchOn);
}

function stopReading() {
  reading = false;
  scanSession++;
  clearTimeout(readTimer);
  readTimer = null;
  $('camera-panel').classList.remove('is-reading');
  $('scan-hold').classList.remove('is-held');
  if (autoTorchEngaged) {
    autoTorchEngaged = false;
    if (torchOn) void setTorch(false, {silent:true});
  }
  renderScanMode();
}

function stopCamera({collapsed=true} = {}) {
  cameraGeneration++;
  cameraStarting = false;
  stopReading();
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  const video = $('video');
  video.pause();
  video.srcObject = null;
  cameraActive = false;
  torchOn = false;
  autoTorchEngaged = false;
  $('torch').hidden = true;
  $('torch-label').textContent = 'Torcia';
  $('torch').setAttribute('aria-pressed','false');
  $('camera-success').hidden = true;
  if (collapsed) {
    $('camera-live').hidden = true;
    $('camera-closed').hidden = false;
  }
}

async function startCamera() {
  if (cameraActive) return true;
  if (cameraStarting) return false;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    $('camera-message').textContent = 'Fotocamera non disponibile; puoi inserire il codice a mano.';
    $('camera-live').hidden = true;
    $('camera-closed').hidden = false;
    return false;
  }

  cameraStarting = true;
  const generation = ++cameraGeneration;
  $('camera-live').hidden = false;
  $('camera-closed').hidden = true;
  $('camera-message').textContent = 'Avvio fotocamera…';
  try {
    const nextStream = await navigator.mediaDevices.getUserMedia({
      audio:false,
      video:{facingMode:{ideal:'environment'}, width:{ideal:1280}, height:{ideal:960}}
    });
    if (generation !== cameraGeneration) {
      nextStream.getTracks().forEach(track => track.stop());
      return false;
    }
    stream = nextStream;
    $('video').srcObject = stream;
    await $('video').play();
    if (generation !== cameraGeneration) {
      stream.getTracks().forEach(track => track.stop());
      return false;
    }
    cameraActive = true;
    cameraStarting = false;
    const track = stream.getVideoTracks()[0];
    let torchAvailable = false;
    try { torchAvailable = Boolean(track?.getCapabilities?.().torch); } catch {}
    $('torch').hidden = !torchAvailable;
    track?.addEventListener('ended', () => {
      if (generation !== cameraGeneration) return;
      stopCamera({collapsed:true});
      $('camera-message').textContent = 'Fotocamera interrotta.';
    }, {once:true});
    $('camera-message').textContent = 'Fotocamera pronta.';
    renderScanMode();
    return true;
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    cameraStarting = false;
    cameraActive = false;
    $('camera-live').hidden = true;
    $('camera-closed').hidden = false;
    const messages = {
      NotAllowedError:'Accesso alla fotocamera negato; puoi inserire il codice a mano.',
      NotFoundError:'Nessuna fotocamera disponibile.',
      NotReadableError:'Fotocamera occupata da un’altra app.'
    };
    $('camera-message').textContent = messages[error.name] || 'Non riesco ad avviare la fotocamera.';
    return false;
  }
}

async function startReading(event) {
  event?.preventDefault?.();
  if (reading || cameraStarting) return;
  if (!cameraActive && !(await startCamera())) return;
  if (!nativeDetector && !zxingReader) {
    $('camera-message').textContent = 'Lettore barcode non disponibile; inserisci il codice a mano.';
    return;
  }

  reading = true;
  const session = ++scanSession;
  $('camera-panel').classList.add('is-reading');
  $('scan-hold').classList.add('is-held');
  if (settings.scanMode === 'continuous') $('scan-label').textContent = 'Annulla lettura';
  renderScanMode();

  if (settings.autoFlashEnabled && !torchOn) {
    autoTorchEngaged = await setTorch(true, {silent:true});
  }

  const attempt = async () => {
    if (!reading || !cameraActive || session !== scanSession) return;
    const value = await detectBarcodeFrame();
    if (!reading || session !== scanSession) return;
    if (validBarcode(value)) {
      completeRead(value.trim());
      return;
    }
    readTimer = setTimeout(attempt, 140);
  };
  void attempt();
}

function completeRead(value) {
  if (!reading) return;
  stopReading();
  $('barcode').value = value;
  if (settings.vibrationEnabled && navigator.vibrate) navigator.vibrate(70);
  stopCamera({collapsed:true});
  $('camera-message').textContent = 'Codice letto.';
}

function cancelContinuousReading(event) {
  event?.preventDefault?.();
  if (!reading) return;
  stopReading();
  $('camera-message').textContent = 'Lettura annullata.';
}

async function authorizeGoogle({force=false} = {}) {
  if (!navigator.onLine) throw new Error('Serve una connessione per collegare Google.');
  if (!backendReady()) throw new Error('Il backend non è configurato nel sito.');
  if (!googleConfigReady()) throw new Error(googleConfigError());

  if (pairingReady() && !force) {
    try {
      return await getBridge().request('pickerToken', {linkId:settings.linkId, linkSecret:settings.linkSecret});
    } catch (error) {
      if (!['AUTH','REAUTH_REQUIRED'].includes(error.code)) throw error;
      googleNeedsReauth = true;
    }
  }

  const popup = openOAuthWindow();
  const begin = await getBridge().request('beginAuth', {
    linkId:pairingReady() ? settings.linkId : '',
    linkSecret:pairingReady() ? settings.linkSecret : '',
    redirectUri:oauthRedirectUri()
  });

  storePendingOAuth({
    endpoint:backendEndpoint(), linkId:begin.linkId, linkSecret:begin.linkSecret,
    state:begin.state, startedAt:Date.now()
  });

  const result = await waitForOAuthResult(popup, begin.authUrl, begin.state);
  await getBridge().request('finishAuth', {
    linkId:begin.linkId, linkSecret:begin.linkSecret,
    code:result.code, state:result.state, redirectUri:oauthRedirectUri()
  });
  clearPendingOAuth();

  settings.linkId = begin.linkId;
  settings.linkSecret = begin.linkSecret;
  settings.endpoint = backendEndpoint();
  googleNeedsReauth = false;
  persistSettings();
  renderSetup();
  renderConfigDialog();

  return getBridge().request('pickerToken', {linkId:settings.linkId, linkSecret:settings.linkSecret});
}

async function resumeOAuthAfterRedirect() {
  const result = takeOAuthResult();
  if (!result) return false;
  const pending = takePendingOAuth();
  if (!pending || result.state !== pending.state || Date.now() - Number(pending.startedAt || 0) > 12 * 60 * 1000) {
    clearPendingOAuth();
    return false;
  }

  try {
    if (result.error) throw new Error(result.errorDescription || 'Autorizzazione Google annullata.');
    if (!result.code) throw new Error('Google non ha restituito il codice di autorizzazione.');

    // L'endpoint statico può non essere ancora valorizzato durante una migrazione v3.1.
    if (!backendReady() && pending.endpoint) settings.endpoint = pending.endpoint;
    resetBridge();
    await getBridge().request('finishAuth', {
      linkId:pending.linkId, linkSecret:pending.linkSecret,
      code:result.code, state:result.state, redirectUri:oauthRedirectUri()
    });
    settings.linkId = pending.linkId;
    settings.linkSecret = pending.linkSecret;
    settings.endpoint = backendEndpoint();
    googleNeedsReauth = false;
    persistSettings();
    clearPendingOAuth();

    // Se era una ri-autorizzazione, conserva il registro già configurato anche nel fallback a pagina intera.
    if (settings.spreadsheetId) {
      try {
        const ping = await getBridge().request('ping', {linkId:settings.linkId, linkSecret:settings.linkSecret});
        settings.destinationLabel = ping.destinationLabel || settings.destinationLabel;
        settings.spreadsheetName = ping.spreadsheetName || settings.spreadsheetName;
        settings.sheetName = ping.sheetName || settings.sheetName;
        persistSettings();
        syncStatus = 'Google ricollegato. Il registro è rimasto invariato.';
      } catch (error) {
        if (['AUTH','REAUTH_REQUIRED'].includes(error.code)) googleNeedsReauth = true;
        syncStatus = error.message;
        syncStatusType = 'error';
        renderSetup();
        renderConfigDialog();
        return false;
      }
    } else {
      syncStatus = 'Google collegato. Apri Configurazione e scegli il registro.';
    }
    syncStatusType = '';
    renderSetup();
    renderConfigDialog();
    scheduleSync(0);
    return true;
  } catch (error) {
    clearPendingOAuth();
    googleNeedsReauth = true;
    syncStatus = error.message;
    syncStatusType = 'error';
    return false;
  }
}

async function chooseGoogleSheet({forceAuth=false} = {}) {
  if (configuring) return;
  configuring = true;
  renderConfigDialog();
  let dialogWasOpen = $('config-dialog').open;
  try {
    hideFeedback($('config-result'));
    const tokenResponse = await authorizeGoogle({force:forceAuth});
    if (dialogWasOpen) $('config-dialog').close();
    const selected = await pickSpreadsheet(tokenResponse.accessToken);
    if (!selected) {
      if (dialogWasOpen) $('config-dialog').showModal();
      return;
    }

    const response = await getBridge().request('selectFile', {
      linkId:settings.linkId, linkSecret:settings.linkSecret, spreadsheetId:selected.id
    });
    settings.spreadsheetId = selected.id;
    settings.spreadsheetName = response.spreadsheetName || selected.name;
    settings.sheetName = response.sheetName || '';
    settings.destinationLabel = response.destinationLabel || '';
    settings.endpoint = backendEndpoint();
    googleNeedsReauth = false;
    persistSettings();
    renderSetup();
    await renderRecords();
    syncStatus = '';
    syncStatusType = '';
    if (dialogWasOpen) $('config-dialog').showModal();
    feedback('Registro collegato.', 'success', $('config-result'));
    scheduleSync(0);
  } catch (error) {
    resetBridge();
    if (['AUTH','REAUTH_REQUIRED'].includes(error.code)) googleNeedsReauth = true;
    if (dialogWasOpen && !$('config-dialog').open) $('config-dialog').showModal();
    feedback(error.message, 'error', $('config-result'));
  } finally {
    configuring = false;
    renderConfigDialog();
  }
}

async function reconnectExistingGoogle() {
  if (configuring) return;
  if (!settings.spreadsheetId || !pairingReady()) {
    return chooseGoogleSheet({forceAuth:!pairingReady()});
  }
  configuring = true;
  renderConfigDialog();
  hideFeedback($('config-result'));
  try {
    await authorizeGoogle({force:true});
    const response = await getBridge().request('ping', {linkId:settings.linkId, linkSecret:settings.linkSecret});
    settings.destinationLabel = response.destinationLabel || settings.destinationLabel;
    settings.spreadsheetName = response.spreadsheetName || settings.spreadsheetName;
    settings.sheetName = response.sheetName || settings.sheetName;
    googleNeedsReauth = false;
    persistSettings();
    renderSetup();
    feedback('Google ricollegato. Il registro è rimasto invariato.', 'success', $('config-result'));
    scheduleSync(0);
  } catch (error) {
    resetBridge();
    if (['AUTH','REAUTH_REQUIRED'].includes(error.code)) googleNeedsReauth = true;
    feedback(error.message, 'error', $('config-result'));
  } finally {
    configuring = false;
    renderConfigDialog();
  }
}

async function testConnection() {
  if (configuring || !destinationReady()) return;
  configuring = true;
  renderConfigDialog();
  try {
    const response = await getBridge().request('ping', {linkId:settings.linkId, linkSecret:settings.linkSecret});
    settings.destinationLabel = response.destinationLabel || settings.destinationLabel;
    settings.spreadsheetName = response.spreadsheetName || settings.spreadsheetName;
    settings.sheetName = response.sheetName || settings.sheetName;
    googleNeedsReauth = false;
    persistSettings();
    renderSetup();
    renderConfigDialog();
    feedback('Connessione verificata.', 'success', $('config-result'));
  } catch (error) {
    resetBridge();
    if (['AUTH','REAUTH_REQUIRED'].includes(error.code)) googleNeedsReauth = true;
    feedback(error.message, 'error', $('config-result'));
  } finally {
    configuring = false;
    renderConfigDialog();
  }
}

async function recordScan(event) {
  event.preventDefault();
  if (recording || !storageReady) return;
  if (!validOperator(settings.operator)) { openSettings(); return; }
  if (!backendReady() || !googleConfigReady() || !destinationReady()) { openConfiguration(); return; }

  const barcode = $('barcode').value.trim();
  const rawQuantity = $('quantity').value.trim();
  const quantity = Number(rawQuantity.replace(',', '.'));
  if (!validBarcode(barcode)) return feedback('Inserisci un codice valido.', 'error');
  if (!rawQuantity || !Number.isFinite(quantity) || quantity < 0 || quantity > 1e9) return feedback('Inserisci una quantità valida.', 'error');

  recording = true;
  renderSetup();
  try {
    const endpoint = backendEndpoint();
    await addRecord({
      id:crypto.randomUUID(), scannedAt:new Date().toISOString(), barcode, quantity,
      operator:settings.operator.trim(), endpoint, spreadsheetId:settings.spreadsheetId,
      linkId:settings.linkId, status:'pending'
    });
    $('barcode').value = '';
    $('quantity').value = '1';
    await renderRecords();
    feedback(navigator.onLine ? 'Registrazione salvata. Invio a Google…' : 'Registrazione salvata sul dispositivo.', 'waiting');
    scheduleSync(0);
    if (settings.scanMode === 'hold' && !document.hidden) void startCamera();
  } catch {
    feedback('Salvataggio locale non riuscito. I campi non sono stati cancellati.', 'error');
  } finally {
    recording = false;
    renderSetup();
  }
}

function scheduleSync(delay = 0) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { void synchronize(); }, delay);
}

async function synchronize() {
  if (syncing || configuring || !storageReady || !destinationReady() || !backendReady() || !navigator.onLine || document.hidden) return;
  syncing = true;
  let sentCount = 0;
  let failed = false;
  try {
    await renderRecords();
    let todo = records.filter(r => r.status === 'pending');
    if (!todo.length) return;
    syncStatus = 'Invio in corso…';
    syncStatusType = '';
    await renderRecords();

    while (todo.length && navigator.onLine && !document.hidden) {
      const record = todo[0];
      const currentEndpoint = backendEndpoint();
      if ((record.endpoint && record.endpoint !== currentEndpoint) ||
          (record.spreadsheetId && record.spreadsheetId !== settings.spreadsheetId) ||
          (record.linkId && record.linkId !== settings.linkId)) {
        throw new Error('Una registrazione in attesa appartiene a un’altra configurazione. Ripristina la destinazione originale prima di inviarla.');
      }

      const response = await getBridge().request('append', {
        linkId:settings.linkId,
        linkSecret:settings.linkSecret,
        record:{id:record.id, scannedAt:record.scannedAt, barcode:record.barcode, quantity:record.quantity, operator:record.operator}
      });
      if (response.id !== record.id || !response.savedAt || !Number.isFinite(Date.parse(response.savedAt))) {
        throw new Error('Conferma Google non valida. La registrazione resta in attesa.');
      }
      await acknowledgeRecord(record.id, response.savedAt);
      sentCount++;
      if (response.destinationLabel && response.destinationLabel !== settings.destinationLabel) {
        settings.destinationLabel = response.destinationLabel;
        persistSettings();
        renderSetup();
      }
      await renderRecords();
      todo = records.filter(r => r.status === 'pending');
    }

    retryDelay = 15000;
    googleNeedsReauth = false;
    syncStatus = '';
    syncStatusType = '';
    if (sentCount) feedback(sentCount === 1 ? 'Registrazione inviata a Google.' : sentCount + ' registrazioni inviate a Google.');
  } catch (error) {
    failed = true;
    resetBridge();
    if (['AUTH','REAUTH_REQUIRED'].includes(error.code)) {
      googleNeedsReauth = true;
      syncStatus = 'Google va ricollegato. Le registrazioni restano sul dispositivo.';
      syncStatusType = 'error';
      feedback('Invio in attesa: ricollega Google da Configurazione.', 'waiting');
    } else {
      syncStatus = error.message;
      syncStatusType = 'error';
      feedback('Invio non confermato. I dati restano sul dispositivo.', 'waiting');
    }
    retryDelay = Math.min(retryDelay * 2, 120000);
  } finally {
    syncing = false;
    renderConfigDialog();
    await renderRecords().catch(() => {});
    if (records.some(r => r.status === 'pending') && destinationReady() && navigator.onLine) {
      scheduleSync(failed ? retryDelay : 15000);
    }
  }
}

async function exportRecords() {
  try {
    const data = await listRecords();
    if (!data.length) return;
    const url = URL.createObjectURL(new Blob([csvText(data)], {type:'text/csv;charset=utf-8'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'barcode-bipper-' + new Date().toISOString().slice(0,10) + '.csv';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch {
    feedback('Esportazione non riuscita.', 'error');
  }
}

async function clearHistory() {
  try {
    const removed = await deleteSentRecords();
    await renderRecords();
    feedback(removed ? 'Cronologia locale svuotata.' : 'Nessun record inviato da rimuovere.');
  } catch {
    feedback('Non è stato possibile svuotare la cronologia.', 'error');
  }
}

function commitCustomHex(value) {
  let next = String(value || '').trim().toUpperCase();
  if (!next.startsWith('#')) next = '#' + next;
  const valid = /^#[0-9A-F]{6}$/.test(next);
  $('custom-color-error').hidden = valid;
  if (!valid) return;
  settings.customColor = next;
  $('custom-color').value = next;
  $('custom-hex').value = next;
  persistSettings();
  if (settings.theme === 'custom') applyCustomColor(next);
}

function resetPreferenceDefaults() {
  const preserved = {
    operator:settings.operator,
    endpoint:settings.endpoint,
    linkId:settings.linkId,
    linkSecret:settings.linkSecret,
    spreadsheetId:settings.spreadsheetId,
    spreadsheetName:settings.spreadsheetName,
    sheetName:settings.sheetName,
    destinationLabel:settings.destinationLabel
  };
  settings = {...settings, ...DEFAULT_PREFS, ...preserved};
  persistSettings();
  stopReading();
  renderSettings();
  renderSetup();
  if (settings.scanMode === 'hold' && !cameraActive) void startCamera();
  feedback('Preferenze ripristinate.', 'success');
}

// Drawer / dialogs.
$('menu-open').addEventListener('click', openDrawer);
$('menu-close').addEventListener('click', closeDrawer);
$('drawer-backdrop').addEventListener('click', closeDrawer);
$('drawer-settings').addEventListener('click', openSettings);
$('drawer-config').addEventListener('click', openConfiguration);
$('setup-action').addEventListener('click', () => $('setup-action').dataset.target === 'settings' ? openSettings() : openConfiguration());
document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('app-drawer').classList.contains('open')) closeDrawer(); });
for (const dialog of document.querySelectorAll('dialog')) {
  new MutationObserver(syncModalLock).observe(dialog, {attributes:true, attributeFilter:['open']});
  dialog.addEventListener('close', syncModalLock);
  dialog.addEventListener('cancel', () => setTimeout(syncModalLock, 0));
}

// Settings.
$('operator').addEventListener('input', () => {
  const value = $('operator').value.trim();
  const valid = !value || validOperator(value);
  $('operator-error').hidden = valid;
  if (!valid) return;
  settings.operator = value;
  persistSettings();
  renderSetup();
});
$('theme').addEventListener('change', () => {
  settings.theme = $('theme').value;
  persistSettings();
  applyTheme();
});
$('custom-color').addEventListener('input', () => commitCustomHex($('custom-color').value));
$('custom-hex').addEventListener('change', () => commitCustomHex($('custom-hex').value));
$('scan-mode').addEventListener('change', () => {
  stopReading();
  settings.scanMode = $('scan-mode').value === 'continuous' ? 'continuous' : 'hold';
  persistSettings();
  renderScanMode();
  if (settings.scanMode === 'continuous') stopCamera({collapsed:true});
  else void startCamera();
});
$('vibration-enabled').addEventListener('change', () => {
  settings.vibrationEnabled = $('vibration-enabled').checked;
  persistSettings();
});
$('auto-flash-enabled').addEventListener('change', () => {
  settings.autoFlashEnabled = $('auto-flash-enabled').checked;
  if (!settings.autoFlashEnabled && autoTorchEngaged) {
    autoTorchEngaged = false;
    if (torchOn) void setTorch(false, {silent:true});
  }
  persistSettings();
});
$('camera-ratio').addEventListener('change', () => {
  settings.cameraRatio = ['wide','tall','portrait'].includes($('camera-ratio').value) ? $('camera-ratio').value : 'tall';
  persistSettings();
  applyCameraOptions();
});
$('camera-fit').addEventListener('change', () => {
  settings.cameraFit = $('camera-fit').value === 'contain' ? 'contain' : 'cover';
  persistSettings();
  applyCameraOptions();
});
$('reset-defaults').addEventListener('click', resetPreferenceDefaults);

// Configuration.
$('connect-google').addEventListener('click', () => {
  if (settings.spreadsheetId && pairingReady()) void reconnectExistingGoogle();
  else void chooseGoogleSheet({forceAuth:!pairingReady()});
});
$('pick-sheet').addEventListener('click', () => { void chooseGoogleSheet({forceAuth:false}); });
$('test-connection').addEventListener('click', () => { void testConnection(); });

// Camera interactions. Use touch prevention to avoid native long-press haptics/context menus.
const holdButton = $('scan-hold');
holdButton.addEventListener('contextmenu', event => event.preventDefault());
holdButton.addEventListener('selectstart', event => event.preventDefault());
holdButton.addEventListener('dragstart', event => event.preventDefault());
holdButton.addEventListener('touchstart', event => {
  event.preventDefault();
  if (settings.scanMode === 'hold' && !reading) void startReading(event);
}, {passive:false});
holdButton.addEventListener('touchend', event => {
  event.preventDefault();
  if (settings.scanMode === 'hold') stopReading();
  else if (reading) cancelContinuousReading(event);
  else void startReading(event);
}, {passive:false});
holdButton.addEventListener('touchcancel', event => {
  event.preventDefault();
  if (settings.scanMode === 'hold') stopReading();
}, {passive:false});
holdButton.addEventListener('pointerdown', event => {
  if (event.pointerType === 'touch') return;
  event.preventDefault();
  if (settings.scanMode === 'hold') {
    try { holdButton.setPointerCapture(event.pointerId); } catch {}
    if (!reading) void startReading(event);
  }
}, {passive:false});
holdButton.addEventListener('pointerup', event => {
  if (event.pointerType === 'touch') return;
  event.preventDefault();
  if (settings.scanMode === 'hold') stopReading();
  else if (reading) cancelContinuousReading(event);
  else void startReading(event);
}, {passive:false});
holdButton.addEventListener('pointercancel', event => {
  if (event.pointerType === 'touch') return;
  if (settings.scanMode === 'hold') stopReading();
});
holdButton.addEventListener('keydown', event => {
  if (!['Space','Enter'].includes(event.code)) return;
  event.preventDefault();
  if (settings.scanMode === 'hold') {
    if (!event.repeat && !reading) void startReading(event);
  } else if (!event.repeat) {
    if (reading) cancelContinuousReading(event);
    else void startReading(event);
  }
});
holdButton.addEventListener('keyup', event => {
  if (settings.scanMode === 'hold' && ['Space','Enter'].includes(event.code)) {
    event.preventDefault();
    stopReading();
  }
});
holdButton.addEventListener('click', event => event.preventDefault());
$('camera-closed').addEventListener('click', async () => {
  const started = await startCamera();
  if (started && settings.scanMode === 'continuous') void startReading();
});
$('torch').addEventListener('click', toggleTorch);

// Form/history.
$('record-form').addEventListener('submit', recordScan);
for (const [id, delta] of [['minus',-1],['plus',1]]) {
  $(id).addEventListener('click', () => {
    const old = Number($('quantity').value.replace(',','.')) || 0;
    $('quantity').value = String(Math.min(1e9, Math.max(0, Math.round((old + delta) * 1e6) / 1e6)));
  });
}
$('sync-now').addEventListener('click', () => { void synchronize(); });
$('export-history').addEventListener('click', exportRecords);
$('clear-history').addEventListener('click', () => $('clear-history-dialog').showModal());
$('confirm-clear-history').addEventListener('click', () => { void clearHistory(); });

// Network/lifecycle.
window.addEventListener('online', () => { renderSetup(); scheduleSync(0); });
window.addEventListener('offline', () => { renderSetup(); void renderRecords(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera({collapsed:true});
  else {
    void renderRecords();
    scheduleSync(0);
    if (settings.scanMode === 'hold' && !cameraActive) void startCamera();
  }
});
window.addEventListener('pagehide', () => stopCamera({collapsed:true}));
window.addEventListener('storage', () => {
  settings = {...DEFAULT_PREFS, ...loadSettings()};
  renderSettings();
  renderSetup();
  renderConfigDialog();
});

// Install PWA.
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  $('install-now').hidden = false;
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('install-now').hidden = true;
});
$('install-help').addEventListener('click', () => $('install-dialog').showModal());
$('install-now').addEventListener('click', async () => {
  if (!installPrompt) return;
  await installPrompt.prompt();
  installPrompt = null;
  $('install-now').hidden = true;
});

// Bootstrap.
renderSettings();
renderSetup();
renderConfigDialog();
await setupDetector();
const resumedOAuth = await resumeOAuthAfterRedirect();
try {
  if (!crypto.randomUUID) throw new Error('Usa un browser aggiornato tramite HTTPS.');
  await openDatabase();
  storageReady = true;
  renderSetup();
  await renderRecords();
  scheduleSync(0);
} catch (error) {
  $('boot-error').hidden = false;
  $('boot-error').textContent = 'Archivio locale non disponibile. Evita la navigazione privata e usa un browser aggiornato. ' + error.message;
}

if (resumedOAuth) openConfiguration();

if (settings.scanMode === 'hold' && !document.hidden) {
  void startCamera();
} else {
  $('camera-live').hidden = true;
  $('camera-closed').hidden = false;
  $('camera-message').textContent = 'Premi Registra per leggere.';
}

if ('serviceWorker' in navigator && window.isSecureContext) {
  let controlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (controlled) $('update-notice').hidden = false;
    controlled = true;
  });
  $('reload-app').addEventListener('click', () => {
    if (syncing || recording || $('barcode').value.trim()) {
      feedback('Completa prima la registrazione in corso.', 'waiting');
      return;
    }
    location.reload();
  });
  navigator.serviceWorker.register('./sw.js', {updateViaCache:'none'}).catch(() => {});
}
