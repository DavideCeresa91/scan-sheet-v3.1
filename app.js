import {loadSettings, saveSettings, openDatabase, listRecords, addRecord, acknowledgeRecord, csvText} from './storage.js';
import {GoogleBridge, normalizeEndpoint} from './transport.js';
import {googleConfigReady, googleConfigError, oauthRedirectUri, openOAuthWindow, waitForOAuthResult, pickSpreadsheet} from './google-auth.js';

const $ = id => document.getElementById(id);
let settings = loadSettings();
let records = [];
let bridge;
let syncing = false;
let recording = false;
let testing = false;
let storageReady = false;
let scanSession = 0;
let cameraGeneration = 0;
let cameraStarting = false;
let reading = false;
let readTimer;
let readDeadlineTimer;
let cameraActive = false;
let torchOn = false;
let installPrompt;
let lastVerified;
let pendingSpreadsheet;
let pendingLink;
let retryTimer;
let retryDelay = 15000;
const timeFormat = new Intl.DateTimeFormat('it-IT', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit'});

const themeNames = new Set(['green', 'blue', 'petrol', 'burgundy', 'purple', 'orange', 'graphite']);

function applyTheme() {
  const theme = themeNames.has(settings.theme) ? settings.theme : 'burgundy';
  document.documentElement.dataset.theme = theme;
  $('theme').value = theme;
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
}

function changeTheme() {
  try {
    const next = {...settings, theme:$('theme').value};
    saveSettings(next); settings = next; applyTheme();
    $('theme-status').textContent = 'Tema salvato su questo dispositivo.';
  } catch {
    applyTheme(); $('theme-status').textContent = 'Non è stato possibile salvare il tema. Riprova.';
  }
}

const configured = () => Boolean(settings.operator && settings.endpoint && settings.accessKey && settings.linkId && settings.linkSecret && settings.spreadsheetId);

function feedback(text, type = 'success', element = $('feedback')) {
  element.textContent = text; element.className = 'feedback ' + type; element.hidden = false;
}

function resetBridge() { bridge?.destroy(); bridge = null; }
function getBridge(endpoint) {
  if (!bridge || bridge.endpoint !== endpoint) { resetBridge(); bridge = new GoogleBridge(endpoint); }
  return bridge;
}

function renderConfiguration() {
  $('operator-label').textContent = settings.operator || 'Da impostare';
  $('destination-label').textContent = settings.destinationLabel || settings.spreadsheetName || (settings.spreadsheetId ? 'Google Sheet collegato · da verificare' : 'Da configurare');
  $('setup-notice').hidden = configured() && googleConfigReady();
  $('submit-record').disabled = !storageReady || !configured() || !googleConfigReady() || recording;
  $('network').textContent = navigator.onLine ? 'Online' : 'Senza rete';
  $('network').classList.toggle('offline', !navigator.onLine);
}

async function renderRecords() {
  records = await listRecords();
  const pending = records.filter(r => r.status === 'pending').length;
  if (records.length && $('sync-message').textContent === 'Le registrazioni compariranno qui.') {
    $('sync-message').textContent = pending ? 'Registrazioni in attesa di invio.' : 'Le registrazioni locali risultano salvate su Google.';
  }
  $('pending-count').textContent = pending + ' da inviare';
  $('pending-count').classList.toggle('waiting', pending > 0);
  $('sync-now').disabled = pending === 0 || syncing || !navigator.onLine || !configured();
  $('sync-now').textContent = syncing ? 'Invio in corso…' : 'Invia registrazioni in attesa';
  $('export').disabled = records.length === 0;
  $('empty-state').hidden = records.length > 0;
  const nodes = records.slice(-10).reverse().map(record => {
    const li = document.createElement('li'); li.className = 'record';
    const top = document.createElement('div'); top.className = 'record-top';
    const code = document.createElement('strong'); code.className = 'record-code'; code.textContent = record.barcode;
    const qty = document.createElement('span'); qty.className = 'record-qty'; qty.textContent = 'Qtà ' + new Intl.NumberFormat('it-IT').format(record.quantity);
    top.append(code, qty);
    const bottom = document.createElement('div'); bottom.className = 'record-bottom';
    const meta = document.createElement('span'); meta.className = 'record-meta'; meta.textContent = timeFormat.format(new Date(record.scannedAt)) + ' · ' + record.operator;
    const status = document.createElement('span'); status.className = 'record-state ' + record.status;
    status.textContent = record.status === 'sent' ? 'Salvato' : 'Da inviare';
    bottom.append(meta, status); li.append(top, bottom); return li;
  });
  $('records').replaceChildren(...nodes);
}

function activeLink() {
  return pendingLink || (settings.linkId && settings.linkSecret ? {linkId:settings.linkId, linkSecret:settings.linkSecret} : null);
}

function renderSelectedSheet() {
  const sheet = pendingSpreadsheet || (settings.spreadsheetId ? {id:settings.spreadsheetId, name:settings.spreadsheetName || 'Google Sheet collegato'} : null);
  $('selected-sheet').textContent = sheet ? sheet.name : (activeLink() ? 'Google collegato · scegli il foglio' : 'Google non collegato');
  $('pick-sheet').textContent = activeLink() ? (sheet ? 'Cambia Google Sheet' : 'Scegli Google Sheet') : 'Collega Google';
}

function openSettings() {
  stopCamera(); applyTheme();
  $('theme-status').textContent = 'Il colore si salva appena lo scegli.';
  $('operator').value = settings.operator || '';
  $('endpoint').value = settings.endpoint || '';
  $('access-key').value = settings.accessKey || '';
  pendingSpreadsheet = settings.spreadsheetId ? {id:settings.spreadsheetId, name:settings.spreadsheetName || 'Google Sheet collegato'} : null;
  pendingLink = settings.linkId && settings.linkSecret ? {linkId:settings.linkId, linkSecret:settings.linkSecret} : null;
  renderSelectedSheet(); $('settings-result').hidden = true; lastVerified = null;
  $('settings-dialog').showModal();
  if (!googleConfigReady()) feedback(googleConfigError(), 'error', $('settings-result'));
}

function baseSettingsFromForm() {
  const operator = $('operator').value.trim();
  const accessKey = $('access-key').value.trim();
  if (!operator || operator.length > 80 || /[\x00-\x1f\x7f]/.test(operator) || /^[=+@]/.test(operator)) throw new Error('Inserisci un nome operatore valido, fino a 80 caratteri.');
  if (accessKey.length < 32 || accessKey.length > 256 || /\s/.test(accessKey)) throw new Error('La chiave deve contenere almeno 32 caratteri, senza spazi. Copiala dalle proprietà dello script.');
  return {operator, endpoint:normalizeEndpoint($('endpoint').value), accessKey};
}

function settingsFromForm() {
  const base = baseSettingsFromForm();
  if (!pendingLink?.linkId || !pendingLink?.linkSecret) throw new Error('Collega Google una volta da questo dispositivo.');
  if (!pendingSpreadsheet?.id) throw new Error('Scegli il Google Sheet da autorizzare.');
  return {...base, ...pendingLink, spreadsheetId:pendingSpreadsheet.id, spreadsheetName:pendingSpreadsheet.name};
}

function setSettingsBusy(value) {
  testing = value;
  for (const control of $('settings-form').querySelectorAll('button,input,select')) control.disabled = value;
}

async function authorizePersistentGoogle(candidate, popup) {
  const current = activeLink();
  const begin = await getBridge(candidate.endpoint).request('beginAuth', {
    accessKey:candidate.accessKey,
    linkId:current?.linkId || '', linkSecret:current?.linkSecret || '',
    redirectUri:oauthRedirectUri()
  });
  pendingLink = {linkId:begin.linkId, linkSecret:begin.linkSecret};
  const result = await waitForOAuthResult(popup, begin.authUrl, begin.state);
  await getBridge(candidate.endpoint).request('finishAuth', {
    accessKey:candidate.accessKey, linkId:pendingLink.linkId, linkSecret:pendingLink.linkSecret,
    code:result.code, state:result.state, redirectUri:oauthRedirectUri()
  });
}

async function chooseGoogleSheet() {
  if (!navigator.onLine) return feedback('Serve una connessione per collegare Google.', 'waiting', $('settings-result'));
  let popup = null;
  const dialog = $('settings-dialog');
  try {
    if (!googleConfigReady()) throw new Error(googleConfigError());
    const candidate = baseSettingsFromForm();
    setSettingsBusy(true);
    feedback(activeLink() ? 'Apertura del registro Google…' : 'Collegamento Google…', 'waiting', $('settings-result'));

    let tokenResponse;
    const current = activeLink();
    if (current) {
      try {
        tokenResponse = await getBridge(candidate.endpoint).request('pickerToken', {
          accessKey:candidate.accessKey, linkId:current.linkId, linkSecret:current.linkSecret
        });
      } catch (error) {
        if (error.code !== 'AUTH') throw error;
      }
    }

    if (!tokenResponse) {
      popup = openOAuthWindow();
      await authorizePersistentGoogle(candidate, popup);
      tokenResponse = await getBridge(candidate.endpoint).request('pickerToken', {
        accessKey:candidate.accessKey, linkId:pendingLink.linkId, linkSecret:pendingLink.linkSecret
      });
    } else if (popup && !popup.closed) popup.close();

    if (dialog.open) dialog.close();
    const selected = await pickSpreadsheet(tokenResponse.accessToken);
    if (!selected) {
      if (!dialog.open) dialog.showModal();
      return feedback('Selezione annullata.', 'waiting', $('settings-result'));
    }
    const link = activeLink();
    const selectedResponse = await getBridge(candidate.endpoint).request('selectFile', {
      accessKey:candidate.accessKey, linkId:link.linkId, linkSecret:link.linkSecret, spreadsheetId:selected.id
    });
    pendingSpreadsheet = {id:selected.id, name:selected.name};
    lastVerified = {...candidate, ...link, spreadsheetId:selected.id, spreadsheetName:selected.name, destinationLabel:selectedResponse.destinationLabel};
    if (!dialog.open) dialog.showModal();
    renderSelectedSheet();
    feedback('Google collegato in modo persistente a ' + selectedResponse.destinationLabel + '. Puoi salvare.', 'success', $('settings-result'));
  } catch (error) {
    try { if (popup && !popup.closed) popup.close(); } catch {}
    if (!dialog.open) dialog.showModal();
    resetBridge();
    feedback(error.message, 'error', $('settings-result'));
  } finally { setSettingsBusy(false); }
}

async function testConnection() {
  if (syncing) return feedback('Attendi il completamento dell’invio in corso.', 'waiting', $('settings-result'));
  if (!navigator.onLine) return feedback('Serve una connessione per verificare Google.', 'waiting', $('settings-result'));
  try {
    const candidate = settingsFromForm();
    setSettingsBusy(true); feedback('Verifica in corso…', 'waiting', $('settings-result'));
    const response = await getBridge(candidate.endpoint).request('ping', {
      accessKey:candidate.accessKey, linkId:candidate.linkId, linkSecret:candidate.linkSecret
    });
    lastVerified = {...candidate, destinationLabel:response.destinationLabel};
    feedback('Collegato a ' + response.destinationLabel + '. Puoi salvare le impostazioni.', 'success', $('settings-result'));
  } catch (error) {
    resetBridge();
    feedback(error.code === 'AUTH' ? 'Autorizzazione Google da rinnovare: premi “Collega Google”.' : error.message, 'error', $('settings-result'));
  } finally { setSettingsBusy(false); }
}

async function commitSettings(event) {
  event.preventDefault();
  if (testing) return;
  try {
    if (syncing) throw new Error('Attendi il completamento dell’invio in corso.');
    const candidate = settingsFromForm();
    const currentRecords = await listRecords();
    if (currentRecords.some(r => r.status === 'pending' && (r.endpoint !== candidate.endpoint || r.spreadsheetId !== candidate.spreadsheetId))) {
      throw new Error('Invia prima le registrazioni in attesa alla loro destinazione. Il cambio di registro è bloccato per evitare invii al foglio sbagliato.');
    }
    const verified = lastVerified?.endpoint === candidate.endpoint && lastVerified?.linkId === candidate.linkId && lastVerified?.spreadsheetId === candidate.spreadsheetId;
    const sameDestination = settings.endpoint === candidate.endpoint && settings.linkId === candidate.linkId && settings.spreadsheetId === candidate.spreadsheetId;
    const next = {...settings, ...candidate, destinationLabel:verified ? lastVerified.destinationLabel : (sameDestination ? settings.destinationLabel : '')};
    saveSettings(next); settings = next; pendingSpreadsheet = null; pendingLink = null; resetBridge();
    $('settings-dialog').close(); renderConfiguration(); await renderRecords();
    feedback('Impostazioni salvate. Da ora Google resta collegato su questo dispositivo.');
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    scheduleSync(0);
  } catch (error) { feedback(error.message, 'error', $('settings-result')); }
}

// Preview and decoding have independent lifetimes: only readNow starts the decoder.
function renderCameraControls() {
  $('scan').disabled = cameraStarting || reading;
  $('scan-label').textContent = reading ? 'Lettura in corso…' : 'Leggi ora';
  $('camera-toggle').textContent = cameraActive || cameraStarting ? 'Camera on · Spegni' : 'Camera off · Accendi';
  $('camera-toggle').setAttribute('aria-pressed', String(cameraActive || cameraStarting));
}

function stopReading() {
  scanSession++;
  clearTimeout(readTimer);
  clearTimeout(readDeadlineTimer);
  reading = false;
  $('camera-panel').classList.remove('is-reading');
  renderCameraControls();
}

function stopCamera({success = false} = {}) {
  cameraGeneration++;
  cameraStarting = false;
  cameraActive = false;
  stopReading();
  const video = $('video');
  video.srcObject?.getTracks().forEach(track => track.stop());
  video.pause();
  video.srcObject = null;
  $('camera-panel').hidden = !success;
  $('camera-panel').classList.toggle('is-success', success);
  $('camera-success').hidden = !success;
  $('torch').hidden = true;
  $('torch').setAttribute('aria-pressed', 'false');
  torchOn = false;
  renderCameraControls();
}

async function startCamera() {
  if (cameraActive) return true;
  if (cameraStarting) return false;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    $('camera-message').textContent = 'La fotocamera richiede HTTPS. Apri il sito pubblicato su GitHub Pages; puoi comunque inserire il codice a mano.';
    return false;
  }
  stopCamera();
  cameraStarting = true;
  const generation = ++cameraGeneration;
  renderCameraControls();
  $('camera-panel').hidden = false;
  $('camera-message').textContent = 'Avvio fotocamera… Consenti l’accesso se richiesto.';
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio: false, video: {facingMode: {ideal: 'environment'}, width: {ideal: 1280}, height: {ideal: 720}}});
    if (generation !== cameraGeneration) { stream.getTracks().forEach(track => track.stop()); return false; }
    $('video').srcObject = stream;
    await $('video').play();
    if (generation !== cameraGeneration) { stream.getTracks().forEach(track => track.stop()); return false; }
    cameraActive = true;
    cameraStarting = false;
    const track = stream.getVideoTracks()[0];
    let torchAvailable = false;
    try { torchAvailable = Boolean(track?.getCapabilities?.().torch); } catch { /* Optional capability. */ }
    $('torch').hidden = !torchAvailable;
    $('torch').textContent = 'Torcia';
    track?.addEventListener('ended', () => {
      if (generation !== cameraGeneration) return;
      stopCamera();
      $('camera-message').textContent = 'La fotocamera si è interrotta. Premi Camera on/off per riattivarla.';
    }, {once: true});
    renderCameraControls();
    $('camera-message').textContent = 'Inquadra il codice, poi premi Leggi ora.';
    return true;
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    if (generation !== cameraGeneration) return false;
    stopCamera();
    const messages = {NotAllowedError: 'Accesso alla fotocamera negato. Abilitalo nelle impostazioni del browser oppure inserisci il codice a mano.', NotFoundError: 'Nessuna fotocamera disponibile. Inserisci il codice a mano.', NotReadableError: 'Fotocamera occupata. Chiudi le altre app che la usano e riprova.'};
    $('camera-message').textContent = messages[error.name] || 'Non riesco ad avviare la fotocamera. Riprova o inserisci il codice a mano.';
    return false;
  }
}

async function autoStartCamera() {
  const generation = cameraGeneration;
  try {
    const permission = await navigator.permissions?.query({name: 'camera'});
    if (permission?.state === 'granted' && generation === cameraGeneration && !document.hidden && !$('settings-dialog').open) await startCamera();
  } catch { /* Camera permission queries vary by browser; explicit controls remain available. */ }
}

function validBarcode(value) {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value) && !/^[=+@]/.test(value.trim());
}

async function readNow() {
  if (reading || cameraStarting) return;
  if (!window.ZXingBrowser) {
    $('camera-message').textContent = 'Lettore non caricato. Riapri l’app online oppure inserisci il codice a mano.';
    return;
  }
  if (!cameraActive && !(await startCamera())) return;
  const reader = new ZXingBrowser.BrowserMultiFormatReader();
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', {willReadFrequently: true});
  const video = $('video');
  reading = true;
  const session = ++scanSession;
  const deadline = performance.now() + 20000;
  $('camera-panel').classList.add('is-reading');
  renderCameraControls();
  $('camera-message').textContent = 'Lettura attiva: tieni fermo il codice. Massimo 20 secondi.';
  const expired = () => {
    if (session !== scanSession) return;
    stopReading();
    $('camera-message').textContent = 'Nessun codice letto. Migliora luce o distanza e premi di nuovo Leggi ora.';
  };
  readDeadlineTimer = setTimeout(expired, 20000);
  const attempt = () => {
    if (!reading || !cameraActive || session !== scanSession) return;
    if (performance.now() >= deadline) { expired(); return; }
    let value;
    if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
      const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      try { value = reader.decodeFromCanvas(canvas).getText(); }
      catch { /* No complete barcode in this frame. */ }
    }
    if (performance.now() >= deadline) { expired(); return; }
    if (validBarcode(value)) {
      stopCamera({success: true});
      $('barcode').value = value.trim();
      $('camera-message').textContent = 'Codice letto. Camera spenta. Controlla la quantità e premi Registra.';
      if (navigator.vibrate) navigator.vibrate(70);
      // Never focus quantity or another input after recognition.
      return;
    }
    readTimer = setTimeout(attempt, 200);
  };
  attempt();
}

async function toggleTorch() {
  const track = $('video').srcObject?.getVideoTracks()[0];
  if (!track || !cameraActive) return;
  const generation = cameraGeneration;
  $('torch').disabled = true;
  try {
    const next = !torchOn;
    await track.applyConstraints({advanced:[{torch: next}]});
    if (generation !== cameraGeneration) return;
    torchOn = next;
    $('torch').textContent = torchOn ? 'Spegni torcia' : 'Torcia';
    $('torch').setAttribute('aria-pressed', String(torchOn));
  } catch {
    if (generation === cameraGeneration) $('camera-message').textContent = 'La torcia non è disponibile su questo dispositivo.';
  } finally { $('torch').disabled = false; }
}

async function recordScan(event) {
  event.preventDefault();
  if (recording || !storageReady) return;
  if (!configured() || !googleConfigReady()) { openSettings(); return; }
  const barcode = $('barcode').value.trim();
  const rawQuantity = $('quantity').value.trim();
  const quantity = Number(rawQuantity.replace(',', '.'));
  if (!validBarcode(barcode)) return feedback('Inserisci un codice valido, senza interruzioni di riga e senza =, + o @ iniziali.', 'error');
  if (!rawQuantity || !Number.isFinite(quantity) || quantity < 0 || quantity > 1e9) return feedback('Inserisci una quantità da 0 a 1.000.000.000.', 'error');
  recording = true; renderConfiguration(); stopCamera();
  try {
    await addRecord({id:crypto.randomUUID(), scannedAt:new Date().toISOString(), barcode, quantity,
      operator:settings.operator, endpoint:settings.endpoint, spreadsheetId:settings.spreadsheetId, linkId:settings.linkId, status:'pending'});
    $('barcode').value = ''; $('quantity').value = '1';
    $('camera-message').textContent = 'Puoi scansionare il prossimo codice.';
    await renderRecords().catch(() => {});
    feedback(navigator.onLine ? 'Registrazione conservata sul telefono. Invio a Google in corso…' : 'Registrazione conservata sul telefono. Sarà inviata automaticamente quando torni online.', 'waiting');
    scheduleSync(0);
  } catch {
    feedback('Non è stato possibile salvare sul telefono. I campi sono rimasti compilati: riprova prima di passare al prossimo codice.', 'error');
  } finally { recording = false; renderConfiguration(); }
}

function scheduleSync(delay = 0) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { void synchronize(); }, delay);
}

async function synchronize() {
  if (syncing || testing || !storageReady || !configured() || !navigator.onLine || document.hidden) return;
  syncing = true;
  let count = 0, failed = false;
  try {
    await renderRecords();
    let todo = records.filter(r => r.status === 'pending');
    if (!todo.length) return;
    $('sync-message').textContent = 'Invio delle registrazioni in corso…';
    while (todo.length && navigator.onLine && !document.hidden) {
      const record = todo[0];
      if (record.endpoint !== settings.endpoint || record.spreadsheetId !== settings.spreadsheetId || (record.linkId && record.linkId !== settings.linkId)) {
        throw new Error('Una registrazione appartiene a un altro registro. Ripristina la destinazione originale nelle impostazioni.');
      }
      const payload = {id:record.id, scannedAt:record.scannedAt, barcode:record.barcode, quantity:record.quantity, operator:record.operator};
      const response = await getBridge(settings.endpoint).request('append', {
        accessKey:settings.accessKey, linkId:settings.linkId, linkSecret:settings.linkSecret, record:payload
      });
      if (response.id !== record.id || !response.savedAt || !Number.isFinite(Date.parse(response.savedAt))) {
        throw new Error('Conferma Google non valida. La registrazione resta in attesa.');
      }
      await acknowledgeRecord(record.id, response.savedAt); count++;
      if (response.destinationLabel && settings.destinationLabel !== response.destinationLabel) {
        settings.destinationLabel = response.destinationLabel;
        try { saveSettings(settings); } catch {}
        renderConfiguration();
      }
      await renderRecords(); todo = records.filter(r => r.status === 'pending');
    }
    retryDelay = 15000;
    if (count) feedback(count === 1 ? 'Registrazione salvata su Google Sheets.' : count + ' registrazioni salvate su Google Sheets.');
    $('sync-message').textContent = todo.length ? 'Invio sospeso. Riapri l’app con una connessione per continuare.' : 'Tutte le registrazioni sono state confermate da Google.';
  } catch (error) {
    failed = true; resetBridge();
    if (error.code === 'AUTH') {
      $('sync-message').textContent = 'Collegamento Google scaduto o revocato. Apri Impostazioni e premi “Collega Google”.';
      feedback('Invio in attesa: serve ricollegare Google una volta. I dati restano sul telefono.', 'waiting');
    } else {
      $('sync-message').textContent = error.message;
      feedback('Invio non confermato. I dati restano sul telefono; puoi riprovare dal registro.', 'waiting');
    }
    retryDelay = Math.min(retryDelay * 2, 120000);
  } finally {
    syncing = false; await renderRecords().catch(() => {});
    if (records.some(r => r.status === 'pending') && configured() && errorRetryable(failed)) scheduleSync(failed ? retryDelay : 15000);
  }
}

function errorRetryable(failed) { return !failed || retryDelay <= 120000; }

async function exportRecords() {
  try {
    const data = await listRecords();
    const url = URL.createObjectURL(new Blob([csvText(data)], {type:'text/csv;charset=utf-8'}));
    const link = document.createElement('a');
    link.href = url; link.download = 'scan-sheet-' + new Date().toISOString().slice(0,10) + '.csv';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch { feedback('Esportazione non riuscita. Riprova.', 'error'); }
}

$('settings-open').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', () => { pendingSpreadsheet = null; pendingLink = null; $('settings-dialog').close(); });
$('settings-dialog').addEventListener('cancel', event => { if (testing) event.preventDefault(); });
$('settings-form').addEventListener('submit', commitSettings);
$('pick-sheet').addEventListener('click', chooseGoogleSheet);
$('test-connection').addEventListener('click', testConnection);
$('record-form').addEventListener('submit', recordScan);
$('scan').addEventListener('click', readNow);
$('camera-toggle').addEventListener('click', () => {
  if (cameraActive || cameraStarting) { stopCamera(); $('camera-message').textContent = 'Camera spenta. Puoi inserire il codice manualmente.'; }
  else void startCamera();
});
$('theme').addEventListener('change', changeTheme);
$('torch').addEventListener('click', toggleTorch);
$('sync-now').addEventListener('click', () => { void synchronize(); });
$('export').addEventListener('click', exportRecords);
for (const [id, delta] of [['minus',-1], ['plus',1]]) $(id).addEventListener('click', () => {
  const old = Number($('quantity').value.replace(',','.')) || 0;
  $('quantity').value = String(Math.min(1e9, Math.max(0, Math.round((old + delta) * 1e6) / 1e6)));
});
window.addEventListener('online', () => { renderConfiguration(); scheduleSync(0); });
window.addEventListener('offline', () => { renderConfiguration(); void renderRecords(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera(); else { void renderRecords(); scheduleSync(0); }
});
window.addEventListener('pagehide', stopCamera);
window.addEventListener('storage', () => { settings = loadSettings(); applyTheme(); renderConfiguration(); });
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('install').hidden = false; });
window.addEventListener('appinstalled', () => { installPrompt = null; $('install').hidden = true; });
$('install').addEventListener('click', async () => {
  if (installPrompt) { await installPrompt.prompt(); installPrompt = null; $('install').hidden = true; }
  else $('install-dialog').showModal();
});
$('install-help').addEventListener('click', () => $('install-dialog').showModal());

applyTheme(); renderCameraControls(); void autoStartCamera();
try {
  if (!crypto.randomUUID) throw new Error('Apri l’app da un indirizzo HTTPS usando un browser aggiornato.');
  await openDatabase(); storageReady = true; renderConfiguration(); await renderRecords(); scheduleSync(0);
} catch (error) {
  $('boot-error').hidden = false;
  $('boot-error').textContent = 'Archivio locale non disponibile. Usa un browser aggiornato, fuori dalla navigazione privata. ' + error.message;
}
if ('serviceWorker' in navigator && window.isSecureContext) {
  let controlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (controlled) $('update-notice').hidden = false;
    controlled = true;
  });
  $('reload-app').addEventListener('click', () => {
    if (syncing || recording || $('barcode').value.trim()) {
      feedback('Completa la registrazione e l’invio in corso, poi premi Aggiorna.', 'waiting'); return;
    }
    location.reload();
  });
  navigator.serviceWorker.register('./sw.js', {updateViaCache:'none'}).catch(() => {
    $('sync-message').textContent = 'Avvio offline non disponibile. Riapri l’app online per completare la preparazione.';
  });
}
