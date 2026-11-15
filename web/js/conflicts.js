// The conflict view (local clone only): the conflicting lines of one selected branch,
// read on demand, file by file, from the in-memory merge tree the dry run wrote.

import { $, el } from './dom.js';
import { dry, mergedBefore } from './dryrun.js';
import { source } from './sources/index.js';
import { state } from './state.js';

// the selected branch whose conflicts are shown, if any
let head = null;

export function showConflicts(name) {
  head = name;
  $('conflictBox').dataset.key = '';
  renderConflicts();
  $('conflictBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export function renderConflicts() {
  const box = $('conflictBox');
  if (!head || !dry.key) { box.hidden = true; return; }
  // a new dry run is on its way: keep the last view, dimmed, until it lands
  box.style.opacity = dry.pending ? '.5' : '';
  if (dry.pending) return;
  const r = dry.results[head];
  if (r?.status !== 'conflict') { head = null; box.hidden = true; return; }

  const after = mergedBefore(state.selected.indexOf(head));
  box.hidden = false;
  // unrelated redraws must not collapse what is open
  const key = JSON.stringify([head, r.tree, after]);
  if (box.dataset.key === key) return;
  box.dataset.key = key;

  $('conflictTitle').textContent = `Conflicts: ${head}`;
  $('conflictSub').replaceChildren(
    `Dry run of merging it into ${after}: nothing is written. `,
    el('span', { class: 'legend', style: 'background:var(--ours-bg)' }), `ours (${after})`,
    el('span', { class: 'legend', style: 'background:var(--base-bg)' }), 'common ancestor',
    el('span', { class: 'legend', style: 'background:var(--theirs-bg)' }), `theirs (${head})`,
  );
  const labels = { after, head };
  $('conflictFiles').replaceChildren(...r.files.map((path, n) => {
    const notes = r.notes?.[path] || [];
    const kinds = [...new Set(notes.map((m) => m.match(/^CONFLICT \(([^)]+)\)/)?.[1]).filter(Boolean))];
    const body = el('div', {}, el('div', { class: 'muted' }, 'Loading…'));
    const details = el('details', {
      ontoggle: () => { if (details.open) loadHunks(r.tree, path, body, notes, labels); },
    },
      el('summary', {}, el('code', {}, path), ...kinds.map((k) => el('span', { class: 'tag err' }, k))),
      body);
    if (n === 0) details.open = true;
    return details;
  }));
}

const MARKERS = {
  'm-ours': ({ after }) => `<<<<<<< ours: ${after}`,
  'm-base': () => '||||||| common ancestor',
  'm-sep': () => '=======',
  'm-theirs': ({ head }) => `>>>>>>> theirs: ${head}`,
};

async function loadHunks(tree, path, body, notes, labels) {
  if (body.dataset.loaded) return;
  body.dataset.loaded = '1';
  let res;
  try {
    res = await source().conflict(tree, path);
  } catch (e) {
    res = { status: 0, data: { error: e.message } };
  }
  const { status, data } = res;
  body.replaceChildren(...notes.map((m) => el('div', { class: 'note' }, m)));
  if (status !== 200) {
    body.append(el('div', { class: 'err' }, data?.error || `Could not read the conflict (${status})`));
    delete body.dataset.loaded; // try again on the next open
    return;
  }
  const say = (text) => body.append(el('div', { class: 'muted', style: 'margin-top:6px' }, text));
  if (data.missing) return say('Not in the merged result (deleted on one side): see the note above.');
  if (data.binary) return say('Binary file: no line view.');
  if (!data.hunks.length) return say('No conflict markers in the file: see the note above.');
  for (const hunk of data.hunks) {
    body.append(el('div', { class: 'hunk' }, el('div', { class: 'hunk-rows' },
      hunk.map(([n, kind, text]) => el('div', { class: `hl ${kind}` },
        el('span', { class: 'ln' }, String(n)),
        el('span', {}, MARKERS[kind] ? MARKERS[kind](labels) : text))))));
  }
  if (data.truncated) say('Truncated: the file has more conflicted lines than shown.');
}

export function wireConflicts() {
  $('closeConflicts').addEventListener('click', () => { head = null; renderConflicts(); });
  // opening a file loads its conflicts (the toggle event), so Expand all loads them all
  const setOpen = (open) => { for (const d of $('conflictFiles').querySelectorAll('details')) d.open = open; };
  $('expandConflicts').addEventListener('click', () => setOpen(true));
  $('collapseConflicts').addEventListener('click', () => setOpen(false));
}
