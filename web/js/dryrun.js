// The dry run (local clone only): merge the selection into the base in memory, in order,
// and show next to each selected branch whether it would merge cleanly.

import { showConflicts } from './conflicts.js';
import { $, count, el } from './dom.js';
import { dragging, renderSelected } from './selected.js';
import { source } from './sources/index.js';
import { session, state } from './state.js';

// The result, keyed by what was checked (base + selected branches and their tips):
// a reorder or a new tip checks again.
const NONE = { key: null, pending: false, results: {}, error: null };
export let dry = NONE;
let run = 0;
let timer = null;

const dryKey = () => JSON.stringify([state.base, session.shas[state.base], state.selected.map((n) => [n, session.shas[n]])]);

/** The branches merged before the selected branch at `i`, as "base + a + b". */
export const mergedBefore = (i) => [state.base, ...state.selected.slice(0, i)].join(' + ');

/** Forget the last result, so the next scheduleDryRun checks again (a fix was saved). */
export const forgetDryRun = () => { dry = NONE; };

export function scheduleDryRun() {
  if (!source().dryRun || !state.selected.length || !state.base || !session.branches.length) {
    dry = NONE;
    return;
  }
  const key = dryKey();
  if (key === dry.key) return;
  dry = { ...NONE, key, pending: true };
  clearTimeout(timer);
  timer = setTimeout(() => runDryRun(key), 300);
}

async function runDryRun(key) {
  const thisRun = ++run;
  let next;
  try {
    next = { ...NONE, key, results: await source().dryRun(state.base, state.selected) };
  } catch (e) {
    next = { ...NONE, key, error: e.message };
  }
  if (thisRun !== run || key !== dryKey()) return; // the selection changed meanwhile
  dry = next;
  if (!dragging()) renderSelected(); // else shown when the drag ends
}

/** Badge for a selected branch: would it merge cleanly at its position? */
export function dryBadge(name, i) {
  if (!dry.key) return null;
  if (dry.pending) return el('span', { class: 'ab', title: 'Dry run…' }, '…');
  const r = dry.results[name];
  if (!r) return null;
  const after = mergedBefore(i);
  if (r.status === 'clean' && r.fixed) {
    return el('span', { class: 'tag ok', title: `Merges into ${after} with a saved fix for:\n${r.fixed.join('\n')}` }, '✓ fix');
  }
  if (r.status === 'clean') return el('span', { class: 'tag ok', title: `Merges cleanly into ${after}` }, '✓');
  if (r.status === 'contained') return el('span', { class: 'tag', title: `Already contained in ${after}: nothing to merge` }, 'in base');
  if (r.status === 'conflict') {
    return el('button', {
      class: 'tag err',
      title: `Conflicts with ${after} in:\n${r.files.join('\n')}\n\nClick to see the conflicts`,
      onclick: () => showConflicts(name),
    }, `✗ ${count(r.files.length, 'file', 'files')}`);
  }
  return el('span', { class: 'tag warn', title: r.message || 'Could not check' }, '?');
}

export function renderDrySummary() {
  const box = $('drySummary');
  box.className = 'muted';
  box.title = '';
  box.onclick = null;
  if (!dry.key) { box.textContent = ''; return; }
  if (dry.pending) { box.textContent = 'Dry run…'; return; }
  if (dry.error) { box.className = 'err'; box.textContent = `Dry run failed: ${dry.error}`; return; }
  const conflicts = state.selected.filter((n) => dry.results[n]?.status === 'conflict');
  if (!conflicts.length) {
    box.className = 'ok';
    box.textContent = `Dry run: all ${state.selected.length} merge cleanly`;
    return;
  }
  box.className = 'err clickable';
  box.textContent = `Dry run: ${count(conflicts.length, 'conflict', 'conflicts')}, Apply would stop at ${conflicts[0]}`;
  box.title = `${conflicts.map((n) => `${n}: ${dry.results[n].files.join(', ')}`).join('\n')}\n\nClick to see the conflicts`;
  box.onclick = () => showConflicts(conflicts[0]);
}
