// The History panel: the last applies, each with a button to select its branches again.

import { $, el } from './dom.js';
import { renderAll } from './main.js';
import { branchUrl } from './sources/github.js';
import { HISTORY_LIMIT, save, session, state } from './state.js';

/** Record one apply: { name, base, branches, rebuilt, ok, result, source, pushed }. */
export function addHistory(entry) {
  state.history = [{ at: Date.now(), ...entry }, ...state.history].slice(0, HISTORY_LIMIT);
  save();
  renderHistory();
}

function reuse(entry) {
  state.selected = [...entry.branches];
  if (!session.branches.length || session.branches.includes(entry.base)) state.base = entry.base;
  save();
  renderAll();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** The new branch: a link when it is on GitHub, else its name tagged "local". */
function branchCell(entry) {
  const tag = (text, title) => el('span', { class: 'tag', style: 'margin-left:6px', title }, text);
  const rebuilt = entry.rebuilt ? tag('rebuilt', 'An environment branch, rebuilt in place') : null;
  if (entry.ok && (entry.source !== 'local' || entry.pushed)) {
    return [el('a', { href: branchUrl(entry.name), target: '_blank', rel: 'noopener' }, entry.name), rebuilt];
  }
  return [entry.name, rebuilt, entry.source === 'local' ? tag('local') : null];
}

export function renderHistory() {
  const box = $('history');
  if (!state.history.length) {
    box.replaceChildren(el('div', { class: 'empty' }, 'Nothing applied yet.'));
    return;
  }
  const head = ['When', 'New branch', 'Base', 'Branches', 'Result', ''];
  box.replaceChildren(el('table', {},
    el('tr', {}, head.map((h) => el('th', {}, h))),
    state.history.map((entry) => el('tr', {},
      el('td', { class: 'muted' }, new Date(entry.at).toLocaleString()),
      el('td', {}, branchCell(entry)),
      el('td', {}, entry.base),
      el('td', {}, entry.branches.join(', ')),
      el('td', { class: entry.ok ? 'ok' : 'err' }, entry.result),
      el('td', {}, el('button', { class: 'icon', title: 'Select these branches again', onclick: () => reuse(entry) }, 'Reuse')),
    ))));
}

export function wireHistory() {
  $('clearHistory').addEventListener('click', () => { state.history = []; save(); renderHistory(); });
}
