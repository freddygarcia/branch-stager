// Profiles: saved merges (selection, order and base), shown as tabs in the top bar.

import { $, el } from './dom.js';
import { renderAll } from './main.js';
import { staleBadge } from './stale.js';
import { save, session, state } from './state.js';

/** True when the selection and base are exactly what the profile saved. */
const matches = (p) => p.base === state.base
  && p.branches.length === state.selected.length && p.branches.every((n, i) => n === state.selected[i]);

export const activeProfile = () => state.profiles.find((p) => p.name === state.activeProfile);

/**
 * The branch Apply builds (and rebuilds in place on later Applies): the active profile's,
 * else the one typed with no profile active. '' when there is none.
 */
export const envTarget = () => activeProfile()?.target || state.target || '';

/** Set the target branch, on the active profile if there is one (saved at once: it is not part of the selection). */
export function setEnvTarget(target) {
  const p = activeProfile();
  if (p) p.target = target;
  else state.target = target;
  save();
}

// A second click within 3 s deletes, so a stray click cannot lose a profile.
// `armed` holds a profile name, or ALL while Delete all waits for its second click.
const ALL = Symbol('all');
const CONFIRM_MS = 3000;
let armed = null;

function tab(p) {
  const { running } = session;
  const isActive = p.name === state.activeProfile;
  const dirty = isActive && !matches(p);
  const isArmed = armed === p.name;
  return el('button', {
    class: `ptab${isActive ? ' active' : ''}`,
    role: 'tab',
    ariaSelected: String(isActive),
    disabled: running,
    title: `${p.target ? `${p.target} = ` : ''}${p.base} ← ${p.branches.join(', ')}${dirty ? '\n(unsaved changes)' : ''}`,
    onclick: () => loadProfile(p.name),
  },
    el('span', { class: 'pname' }, p.name),
    p.target ? el('span', { class: 'penv' }, `→ ${p.target}`) : null,
    el('span', { class: 'pcount' }, String(p.branches.length)),
    staleBadge(p),
    dirty ? el('span', { class: 'pdirty', title: 'Unsaved changes' }) : null,
    el('span', {
      class: `pdel${isArmed ? ' armed' : ''}`,
      role: 'button',
      title: isArmed ? 'Click again to delete' : `Delete ${p.name}`,
      onclick: (e) => { e.stopPropagation(); deleteProfile(p.name); },
    }, isArmed ? 'Delete?' : '×'),
  );
}

export function renderProfiles() {
  const { running } = session;
  const tabs = $('profileTabs');
  tabs.replaceChildren(...state.profiles.map(tab));
  if (!state.profiles.length) {
    tabs.append(el('span', { class: 'hint' }, 'Select branches, then Save as… to keep this merge as a profile.'));
  }
  const active = activeProfile();
  $('profileActions').hidden = !$('profileForm').hidden;
  $('profileSave').hidden = !active;
  $('profileSave').disabled = running || !state.selected.length || matches(active || { branches: [] });
  $('profileSaveAs').disabled = running || !state.selected.length;
  const all = $('profileDeleteAll');
  all.hidden = !state.profiles.length;
  all.disabled = running;
  all.classList.toggle('armed', armed === ALL);
  all.textContent = armed === ALL ? `Delete ${state.profiles.length}?` : 'Delete all';
  tabs.querySelector('.ptab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/**
 * Save the current selection and base as profile `name` (overwritten if it exists).
 * An existing profile keeps its environment branch and its last build.
 */
function storeProfile(name) {
  const i = state.profiles.findIndex((p) => p.name === name);
  const old = state.profiles[i];
  // a new profile takes the target branch shown now
  const target = old ? old.target || '' : envTarget();
  const entry = { name, base: state.base, branches: [...state.selected], at: Date.now(), target, built: old?.built };
  if (i >= 0) state.profiles[i] = entry;
  else state.profiles = [...state.profiles, entry].sort((a, b) => a.name.localeCompare(b.name));
  state.activeProfile = name;
  save();
}

function loadProfile(name) {
  const p = state.profiles.find((x) => x.name === name);
  if (!p || session.running) return;
  state.selected = p.branches.filter((n) => n !== p.base);
  if (!session.branches.length || session.branches.includes(p.base)) state.base = p.base;
  state.activeProfile = p.name;
  save();
  renderAll();
}

function deleteProfile(name) {
  if (armed !== name) {
    armed = name;
    renderProfiles();
    setTimeout(() => { if (armed === name) { armed = null; renderProfiles(); } }, CONFIRM_MS);
    return;
  }
  armed = null;
  state.profiles = name === ALL ? [] : state.profiles.filter((p) => p.name !== name);
  if (name === ALL || state.activeProfile === name) state.activeProfile = '';
  save();
  renderProfiles();
}

function openSaveAs() {
  $('profileForm').hidden = false;
  $('profileName').value = '';
  renderProfiles();
  $('profileName').focus();
}

function closeSaveAs() {
  $('profileForm').hidden = true;
  renderProfiles();
}

export function wireProfiles() {
  $('profileSave').addEventListener('click', () => { if (activeProfile()) { storeProfile(state.activeProfile); renderProfiles(); } });
  $('profileSaveAs').addEventListener('click', openSaveAs);
  $('profileDeleteAll').addEventListener('click', () => deleteProfile(ALL));
  $('profileCancel').addEventListener('click', closeSaveAs);
  $('profileName').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSaveAs(); });
  $('profileForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('profileName').value.trim();
    if (!name || !state.selected.length) { $('profileName').focus(); return; }
    storeProfile(name);
    closeSaveAs();
  });
}
