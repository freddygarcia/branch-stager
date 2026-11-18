// Settings > Old builds: the branches named with "Prefix of new names" (integration/…),
// local and on origin, ticked and deleted in bulk. A profile's target branch, the base
// and the selection are never listed. Each branch is deleted only while it is still at
// the commit seen at the last Reload.

import { $, ago, count, el } from './dom.js';
import { reload } from './main.js';
import { envTarget } from './profiles.js';
import { source } from './sources/index.js';
import { isProtected, session, state } from './state.js';

const bare = (name) => name.replace(/^origin\//, '');
const CONFIRM_MS = 3000;
const ticked = new Set();
let armed = false;
let busy = false;

/** The old builds, oldest first. */
function oldBuilds() {
  if (!state.prefix) return [];
  const keep = new Set([envTarget(), state.target, ...state.profiles.map((p) => p.target)].filter(Boolean));
  const date = (n) => session.meta[n]?.date || 0;
  return session.branches
    .filter((n) => bare(n).startsWith(state.prefix) && !keep.has(bare(n)) && !isProtected(bare(n))
      && n !== state.base && !state.selected.includes(n))
    .sort((a, b) => date(a) - date(b) || a.localeCompare(b));
}

function status(lines, cls = '') {
  const box = $('oldBuildsStatus');
  box.hidden = !lines.length;
  box.className = cls;
  box.replaceChildren(...lines.map((l) => el('div', { class: l.cls || '' }, l.text)));
}

function row(name) {
  const m = session.meta[name] || {};
  const id = `ob-${name}`;
  return el('div', { class: 'item' },
    el('label', { htmlFor: id },
      el('input', {
        type: 'checkbox', id, checked: ticked.has(name), disabled: busy,
        onchange: (e) => { if (e.target.checked) ticked.add(name); else ticked.delete(name); armed = false; renderOldBuilds(); },
      }),
      name),
    m.kind === 'remote' ? el('span', { class: 'tag', title: `On origin${m.shadowed ? ', with a local copy' : ''}` }, 'origin') : null,
    m.kind === 'local' ? el('span', { class: 'tag', title: 'In the local clone' }, 'local') : null,
    m.date ? el('span', { class: 'muted', style: 'font-size:12px;white-space:nowrap' }, ago(m.date * 1000)) : null,
  );
}

export function renderOldBuilds() {
  const list = $('oldBuildsList');
  const builds = oldBuilds();
  for (const n of [...ticked]) if (!builds.includes(n)) ticked.delete(n);
  $('oldBuildsSummary').textContent = !state.prefix
    ? 'Set a prefix of new names first.'
    : session.branches.length
      ? `${count(builds.length, 'branch', 'branches')} starting with ${state.prefix}; profile targets are kept.`
      : 'Reload to list them.';
  list.hidden = !builds.length;
  list.replaceChildren(...builds.map(row));
  const all = $('oldBuildsAll');
  all.hidden = !builds.length;
  all.disabled = busy;
  all.textContent = builds.length && ticked.size === builds.length ? 'Tick none' : 'Tick all';
  const del = $('oldBuildsDelete');
  del.hidden = !builds.length;
  del.disabled = busy || session.running || !ticked.size;
  del.classList.toggle('armed', armed);
  del.textContent = armed ? `Delete ${ticked.size}? Click again` : `Delete ${ticked.size || ''}`.trim();
}

async function deleteTicked() {
  if (!armed) {
    armed = true;
    renderOldBuilds();
    setTimeout(() => { if (armed) { armed = false; renderOldBuilds(); } }, CONFIRM_MS);
    return;
  }
  armed = false;
  busy = true;
  const items = [...ticked].map((name) => ({ name, sha: session.shas[name] }));
  renderOldBuilds();
  status([{ text: `Deleting ${count(items.length, 'branch', 'branches')}…` }], 'muted');
  let results;
  try {
    results = await source().deleteBranches(items);
  } catch (e) {
    results = [{ ok: false, message: e.message }];
  }
  busy = false;
  ticked.clear();
  const failed = results.filter((r) => !r.ok);
  status([
    { text: `${count(results.length - failed.length, 'branch', 'branches')} deleted.`, cls: 'ok' },
    ...failed.map((r) => ({ text: r.message, cls: 'err' })),
  ]);
  await reload();
}

export function wireOldBuilds() {
  $('oldBuildsAll').addEventListener('click', () => {
    const builds = oldBuilds();
    if (ticked.size === builds.length) ticked.clear();
    else builds.forEach((n) => ticked.add(n));
    armed = false;
    renderOldBuilds();
  });
  $('oldBuildsDelete').addEventListener('click', deleteTicked);
}
