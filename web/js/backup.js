// Settings > Backup: everything this page stores, copied as JSON and imported back.
// localStorage belongs to one origin, so each port keeps its own data: this moves it.

import { saveCompares } from './aheadbehind.js';
import { $, count, el } from './dom.js';
import { showSettings } from './layout.js';
import { KEY, PREFIX, save, session, state } from './state.js';

const BACKUP_FORMAT = 'branch-merger-backup';
// state fields left out of a backup unless "Include tokens and secrets" is ticked
const SECRETS = ['token', 'jiraToken'];
const hasSecrets = (s) => SECRETS.some((k) => s?.[k]);
// shown once after the reload that follows an import
const IMPORTED_NOTE = 'branchMerger:imported';

/** Every localStorage key of this page (all start with PREFIX). */
function ownKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(PREFIX)) keys.push(k);
  }
  return keys.sort();
}

/** The backup as JSON text, and the main state it holds. */
function exportData(includeSecrets) {
  save();
  saveCompares();
  const data = {};
  for (const k of ownKeys()) {
    try { data[k] = JSON.parse(localStorage.getItem(k)); } catch { data[k] = localStorage.getItem(k); }
  }
  if (!includeSecrets && data[KEY]) data[KEY] = { ...data[KEY], ...Object.fromEntries(SECRETS.map((k) => [k, ''])) };
  const backup = { format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), data };
  return { text: JSON.stringify(backup, null, 2), stored: data[KEY] || {} };
}

/** Replace this page's stored data with a backup's. Throws when the text is not a backup. */
function importData(text) {
  let file;
  try { file = JSON.parse(text); } catch { throw new Error('This is not JSON.'); }
  if (file?.format !== BACKUP_FORMAT || !file.data || typeof file.data !== 'object') {
    throw new Error('This is not a Branch Merger backup (copied with Export to clipboard).');
  }
  const entries = Object.entries(file.data).filter(([k]) => k.startsWith(PREFIX));
  if (!entries.length) throw new Error('The backup holds no data.');
  const incoming = Object.fromEntries(entries);
  // a backup made without the secrets keeps the ones already in this browser. The Jira
  // token only belongs to the backup's Jira site and email, so it is kept only when they match.
  const kept = {};
  const inc = incoming[KEY];
  if (inc && !inc.token && state.token) kept.token = state.token;
  if (inc && !inc.jiraToken && state.jiraToken
    && (inc.jiraUrl || '').trim() === state.jiraUrl.trim()
    && (inc.jiraEmail || '').trim() === state.jiraEmail.trim()) kept.jiraToken = state.jiraToken;
  if (inc) incoming[KEY] = { ...inc, ...kept };
  for (const k of ownKeys()) localStorage.removeItem(k);
  for (const [k, v] of Object.entries(incoming)) {
    localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  return incoming[KEY] || {};
}

const describe = (s) => [
  count(s.profiles?.length || 0, 'profile', 'profiles'),
  count(s.history?.length || 0, 'history entry', 'history entries'),
  ...(s.jiraUrl ? [`Jira ${s.jiraUrl.replace(/^https:\/\//, '')}`] : []),
].join(', ');

function status(text, cls) {
  const box = $('backupStatus');
  box.hidden = false;
  box.className = cls;
  box.textContent = text;
}

async function exportToClipboard() {
  let backup;
  try {
    backup = exportData($('exportToken').checked);
  } catch (e) {
    status(`Export failed: ${e.message}`, 'err');
    return;
  }
  const { text, stored } = backup;
  const secret = hasSecrets(stored); // false when left out
  const tokenNote = secret ? ', tokens and secrets included: keep it private' : ', without tokens or secrets';
  try {
    await navigator.clipboard.writeText(text);
    status(`Copied ${describe(stored)} to the clipboard${tokenNote}.`, secret ? 'warn' : 'ok');
  } catch {
    // clipboard blocked (permissions, insecure origin): show the text to copy by hand
    $('importForm').hidden = true;
    status(`The browser blocked the clipboard. Copy the text below by hand (${describe(stored)}${tokenNote}).`, 'warn');
    const box = el('textarea', { class: 'mono-box', rows: 6, readOnly: true, spellcheck: false, value: text, style: 'margin-top:6px' });
    $('backupStatus').append(box);
    box.select();
  }
}

function closeImport() {
  $('importForm').hidden = true;
  $('importText').value = '';
}

/** After the reload that follows an import: say what was imported. */
export function showImportedNote() {
  try {
    const note = sessionStorage.getItem(IMPORTED_NOTE);
    if (!note) return;
    sessionStorage.removeItem(IMPORTED_NOTE);
    showSettings();
    status(note, 'ok');
  } catch { /* note only */ }
}

export function wireBackup() {
  $('exportData').addEventListener('click', exportToClipboard);
  $('importData').addEventListener('click', () => {
    if (session.running) return;
    $('backupStatus').hidden = true;
    $('importForm').hidden = false;
    $('importText').focus();
  });
  $('importCancel').addEventListener('click', closeImport);
  $('importText').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeImport(); });
  $('importForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('importText').value.trim();
    if (!text) { $('importText').focus(); return; }
    let s;
    try {
      s = importData(text);
    } catch (err) {
      status(`Import failed: ${err.message} Nothing was changed.`, 'err');
      return;
    }
    try { sessionStorage.setItem(IMPORTED_NOTE, `Imported ${describe(s)}.`); } catch { /* note only */ }
    // start over from the imported data, exactly as on a fresh page load
    location.reload();
  });
}
