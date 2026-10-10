const namespace = 'scan-sheet:' + new URL('./', import.meta.url).pathname;
const settingsKey = namespace + ':settings:barcode-bipper-v1';
const legacySettingsKeys = [namespace + ':settings:v3.1', namespace + ':settings:v3'];
let database;

function parseJSON(raw) {
  try { return JSON.parse(raw || '{}'); }
  catch { return {}; }
}

function cleanSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const next = {...source};
  // ACCESS_KEY non deve più restare nel nuovo storage.
  delete next.accessKey;
  return next;
}

export function loadSettings() {
  const current = parseJSON(localStorage.getItem(settingsKey));
  if (Object.keys(current).length) return cleanSettings(current);

  for (const key of legacySettingsKeys) {
    const legacy = parseJSON(localStorage.getItem(key));
    if (!Object.keys(legacy).length) continue;
    const migrated = cleanSettings(legacy);
    try { localStorage.setItem(settingsKey, JSON.stringify(migrated)); } catch {}
    return migrated;
  }
  return {};
}

export function saveSettings(settings) {
  localStorage.setItem(settingsKey, JSON.stringify(cleanSettings(settings)));
}

// Usiamo lo stesso database della v3.1 per non perdere record pending durante l'upgrade.
export function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(namespace + ':records', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('records')) {
        const store = request.result.createObjectStore('records', {keyPath:'id'});
        store.createIndex('scannedAt', 'scannedAt');
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Chiudi le altre finestre di Barcode Bipper e riprova.'));
  });
  return database;
}

export async function listRecords() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('records').objectStore('records').getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => a.scannedAt.localeCompare(b.scannedAt)));
    request.onerror = () => reject(request.error);
  });
}

export async function addRecord(record) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite');
    tx.objectStore('records').add(record);
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Salvataggio locale non riuscito.'));
  });
}

export async function acknowledgeRecord(id, savedAt) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite');
    const store = tx.objectStore('records');
    const request = store.get(id);
    request.onsuccess = () => {
      if (request.result) store.put({...request.result, status:'sent', savedAt});
    };
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Conferma locale non riuscita.'));
  });
}

export async function deleteSentRecords() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let removed = 0;
    const tx = db.transaction('records', 'readwrite');
    const store = tx.objectStore('records');
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (cursor.value?.status === 'sent') {
        cursor.delete();
        removed++;
      }
      cursor.continue();
    };
    tx.oncomplete = () => resolve(removed);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Pulizia cronologia non riuscita.'));
  });
}

export function csvText(records) {
  const cell = value => {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const rows = [
    ['Timestamp ISO','Codice','Quantità','Operatore','Stato','ID registrazione','Confermato ISO'],
    ...records.map(r => [r.scannedAt, r.barcode, r.quantity, r.operator, r.status === 'sent' ? 'Salvato' : 'Da inviare', r.id, r.savedAt || ''])
  ];
  return '\ufeff' + rows.map(row => row.map(cell).join(';')).join('\r\n');
}
