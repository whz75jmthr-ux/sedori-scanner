// All persistence for this app is localStorage on the viewer's own device —
// there is no backend (a deliberate, confirmed scope decision: the API key
// already lives client-side, so nothing here makes that worse, but it does
// mean corrections/eval records do not sync across devices and are gone if
// the browser data is cleared).

const LS_KEYS = {
  settings: "ss.settings.v1",
  corrections: "ss.corrections.v1",
  evalRecords: "ss.evalRecords.v1"
};

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "gemini-3.7-flash",
  feeRatePercent: 10, // editable, never hardcoded into calculation logic
  defaultShippingCost: 700,
  defaultPackagingCost: 100,
  defaultRepairCost: 0,
  targetProfitMin: 1000,
  targetProfitMax: 5000,
  retentionDays: 30,
  mockMode: false
};

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error("storage read failed for " + key, e);
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error("storage write failed for " + key, e);
  }
}

function getSettings() {
  return Object.assign({}, DEFAULT_SETTINGS, readJSON(LS_KEYS.settings, {}));
}

function saveSettings(patch) {
  const next = Object.assign({}, getSettings(), patch);
  writeJSON(LS_KEYS.settings, next);
  return next;
}

// Corrections: what the AI predicted vs. what the user actually confirmed,
// kept for future evaluation. Never sent anywhere automatically — export is
// a manual, explicit user action (see exportCorrections).
function addCorrection(entry) {
  const list = readJSON(LS_KEYS.corrections, []);
  list.push(Object.assign({ id: "c" + Date.now() + Math.random().toString(36).slice(2, 8), savedAt: new Date().toISOString() }, entry));
  writeJSON(LS_KEYS.corrections, list);
}

function listCorrections() {
  return readJSON(LS_KEYS.corrections, []);
}

function clearCorrections() {
  writeJSON(LS_KEYS.corrections, []);
}

// Evaluation records: one row per (test image, ground truth, prediction)
// so accuracy can be computed instead of eyeballed. See eval.js for the
// aggregate metrics computed from this list.
function addEvalRecord(entry) {
  const list = readJSON(LS_KEYS.evalRecords, []);
  list.push(Object.assign({ id: "e" + Date.now() + Math.random().toString(36).slice(2, 8), savedAt: new Date().toISOString() }, entry));
  writeJSON(LS_KEYS.evalRecords, list);
  return list[list.length - 1];
}

function listEvalRecords() {
  return readJSON(LS_KEYS.evalRecords, []);
}

function clearEvalRecords() {
  writeJSON(LS_KEYS.evalRecords, []);
}

// Retention: drop corrections/eval records older than settings.retentionDays.
// Called once at startup. Images referenced only as data URLs inside these
// records are deleted along with the record itself.
function purgeExpired() {
  const settings = getSettings();
  const cutoff = Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000;
  const keep = (list) => list.filter((r) => new Date(r.savedAt).getTime() >= cutoff);
  writeJSON(LS_KEYS.corrections, keep(readJSON(LS_KEYS.corrections, [])));
  writeJSON(LS_KEYS.evalRecords, keep(readJSON(LS_KEYS.evalRecords, [])));
}

function wipeAllLocalData() {
  writeJSON(LS_KEYS.corrections, []);
  writeJSON(LS_KEYS.evalRecords, []);
}

if (typeof module !== "undefined") {
  module.exports = {
    DEFAULT_SETTINGS,
    getSettings,
    saveSettings,
    addCorrection,
    listCorrections,
    clearCorrections,
    addEvalRecord,
    listEvalRecords,
    clearEvalRecords,
    purgeExpired,
    wipeAllLocalData
  };
}
