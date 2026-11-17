// The Branches panel (every branch, with a checkbox) and the Base branch select.

import { aheadBehind, loadAheadBehind } from './aheadbehind.js';
import { $, el } from './dom.js';
import { setSelected } from './selected.js';
import { ready, source } from './sources/index.js';
import { ARCHIVED, isProtected, isRemote, listed, save, session, staleAge, state } from './state.js';

/** Tag for a local-clone branch: is it on origin, and in sync? */
function localTag(name) {
  const m = session.meta[name];
  if (!m || m.kind !== 'local') return null;
  if (!m.remote) return el('span', { class: 'tag warn', title: 'Only on this machine, not on origin' }, 'local only');
  const { ahead, behind } = m.remote;
  if (ahead && behind) return el('span', { class: 'tag warn', title: `${ahead} commit(s) not pushed, ${behind} on origin not pulled` }, `diverged ↑${ahead} ↓${behind}`);
  if (ahead) return el('span', { class: 'tag warn', title: `${ahead} commit(s) not pushed to origin` }, `unpushed ↑${ahead}`);
  if (behind) return el('span', { class: 'tag', title: `origin has ${behind} commit(s) not in this local branch` }, `behind origin ↓${behind}`);
  return null;
}

/** Tag for a branch with no commits in Settings > Stale after days. */
export function ageTag(name) {
  const days = name === state.base || isProtected(name) ? null : staleAge(name);
  if (days === null) return null;
  const last = new Date(session.meta[name].date * 1000).toLocaleDateString();
  return el('span', { class: 'tag warn', title: `No commits for ${days} days (last ${last}); stale after ${state.staleDays}` }, `stale ${days}d`);
}

function toggle(name, on) {
  const { selected } = state;
  setSelected(on
    ? (selected.includes(name) ? selected : [...selected, name])
    : selected.filter((n) => n !== name));
}

export function renderBranches() {
  const list = $('branchList');
  list.replaceChildren();
  if (!session.branches.length) {
    list.append(el('div', { class: 'empty' }, ready() ? 'No branches loaded. Press Reload.' : source().notReadyText));
    $('branchCount').textContent = '';
    return;
  }
  const q = $('filter').value.trim().toLowerCase();
  const all = listed();
  const staleOnly = state.staleOnly && source().id === 'local' && Number(state.staleDays) > 0;
  const shown = all.filter((name) =>
    (!state.hideArchived || !ARCHIVED.test(name)) && (!state.hideRemote || !isRemote(name)) && (!q || name.toLowerCase().includes(q))
    && (!staleOnly || ageTag(name)));
  $('branchCount').textContent = `${shown.length} of ${all.length}`;

  if (!shown.length) {
    list.append(el('div', { class: 'empty' }, 'Nothing matches the filter.'));
    return;
  }
  for (const name of shown) {
    const isBase = name === state.base;
    const id = `b-${name}`;
    list.append(el('div', { class: `item${isBase ? ' disabled' : ''}` },
      el('label', { htmlFor: id },
        el('input', {
          type: 'checkbox', id, checked: state.selected.includes(name), disabled: isBase,
          onchange: (e) => toggle(name, e.target.checked),
        }),
        name),
      localTag(name),
      ageTag(name),
      aheadBehind(name),
      isBase ? el('span', { class: 'tag' }, 'base') : null,
      isProtected(name) && !isBase ? el('span', { class: 'tag' }, 'protected') : null,
    ));
  }
  loadAheadBehind(shown);
}

/** Show only the branches whose name contains `text`, and scroll to the list. */
export function filterBranches(text) {
  $('filter').value = text;
  renderBranches();
  $('filter').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** The base to use when none is set or it is gone: the newest release candidate, else master. */
function defaultBase(options) {
  // in a local clone origin's copy wins over a local one, which may be stale
  const bare = (n) => n.replace(/^origin\//, '');
  const releases = options
    .filter((n) => /^(origin\/)?release\/\d{8}$/.test(n))
    .sort((a, b) => bare(a).localeCompare(bare(b)) || (a.startsWith('origin/') ? 1 : -1));
  const master = ['origin/master', 'master'].find((n) => options.includes(n));
  return releases.at(-1) || master || options[0] || '';
}

export function renderBase() {
  const { branches } = session;
  const select = $('base');
  select.replaceChildren();
  const options = branches.length ? branches.filter((n) => !ARCHIVED.test(n)) : (state.base ? [state.base] : []);
  if (!state.base || (branches.length && !branches.includes(state.base))) {
    state.base = defaultBase(options);
    save();
  }
  for (const name of options) {
    select.append(el('option', { value: name, selected: name === state.base }, name));
  }
}

export function wireBranches() {
  $('hideArchived').addEventListener('change', (e) => { state.hideArchived = e.target.checked; save(); renderBranches(); });
  $('hideRemote').addEventListener('change', (e) => { state.hideRemote = e.target.checked; save(); renderBranches(); });
  $('staleOnly').addEventListener('change', (e) => { state.staleOnly = e.target.checked; save(); renderBranches(); });
  $('hideBadges').addEventListener('change', (e) => {
    state.hideBadges = e.target.checked;
    save();
    $('branchList').classList.toggle('no-badges', state.hideBadges);
  });
  $('filter').addEventListener('input', renderBranches);
  $('base').addEventListener('change', (e) => {
    state.base = e.target.value;
    setSelected(state.selected.filter((n) => n !== state.base));
  });
}
