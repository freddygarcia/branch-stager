// Entry point: the Settings panel, Reload, and starting the page.
//
// Modules, by panel: profiles.js (top bar), backup.js and the settings here, jira.js,
// branches.js (+ aheadbehind.js), selected.js (+ dryrun.js, conflicts.js), apply.js,
// history.js. sources/ holds what differs between GitHub and the local clone. layout.js
// arranges the panels for the layout picked in Settings.

import { helper } from './api.js';
import { renewName, wireApply } from './apply.js';
import { showImportedNote, wireBackup } from './backup.js';
import { renderBase, renderBranches, wireBranches } from './branches.js';
import { wireConflicts } from './conflicts.js';
import { $, el } from './dom.js';
import { renderHistory, wireHistory } from './history.js';
import { loadJiraFilters, renderJiraFilters, wireJira } from './jira.js';
import { showSettings, wireLayout } from './layout.js';
import { envTarget, wireProfiles } from './profiles.js';
import { renderSelected, wireSelected } from './selected.js';
import { ready, source } from './sources/index.js';
import { clearBranches, save, setBranches, setProtected, state } from './state.js';

function renderSettings() {
  const src = source();
  for (const node of document.querySelectorAll('[data-source]')) node.hidden = node.dataset.source !== src.id;
  $('source').value = src.id;
  for (const id of ['localPath', 'owner', 'repo', 'token', 'prefix', 'jiraUrl', 'jiraEmail', 'jiraToken']) {
    $(id).value = state[id];
  }
  $('hideArchived').checked = state.hideArchived;
  $('hideRemote').checked = state.hideRemote;
  $('staleOnly').checked = state.staleOnly;
  $('staleDays').value = state.staleDays;
  if (!(Number(state.staleDays) > 0)) $('staleOnlyLabel').hidden = true; // 0 turns stale tags off
  $('settingsSummary').textContent = `— ${src.summary()}`;
  if (!src.ready()) $('settingsBox').open = true;
}

export function renderAll() {
  renderSettings();
  renderBase();
  renderBranches();
  renderSelected();
  renderHistory();
}

/** List the branches again (the local clone fetches origin first). */
export async function reload() {
  if (!ready()) {
    showSettings();
    $(source().settingField).focus();
    return;
  }
  $('reload').disabled = true;
  $('branchList').replaceChildren(el('div', { class: 'empty' }, 'Loading…'));
  try {
    setBranches(await source().listBranches());
  } catch (e) {
    clearBranches();
    $('branchList').replaceChildren(el('div', { class: 'empty err' }, e.message));
    return;
  } finally {
    $('reload').disabled = false;
  }
  renderBase();
  renderBranches();
  renderSelected();
}

function wireSettings() {
  // a new repository, or a new source (branch names differ: origin/ prefix), starts over
  // from an empty list and the default base
  const startOver = () => {
    clearBranches();
    state.base = '';
    save();
    renderAll();
    if (ready()) reload();
  };
  for (const id of ['localPath', 'owner', 'repo']) {
    $(id).addEventListener('change', (e) => {
      const value = e.target.value.trim();
      if (state[id] === value) return;
      state[id] = value;
      startOver();
    });
  }
  $('source').addEventListener('change', (e) => { state.source = e.target.value; startOver(); });
  $('token').addEventListener('change', (e) => {
    state.token = e.target.value.trim();
    save();
    renderAll();
    if (state.token && ready()) reload();
  });
  $('forgetToken').addEventListener('click', () => { state.token = ''; save(); clearBranches(); renderAll(); });
  $('prefix').addEventListener('change', (e) => { state.prefix = e.target.value.trim(); save(); });
  $('staleDays').addEventListener('change', (e) => {
    const days = Math.round(Number(e.target.value));
    state.staleDays = days >= 0 ? days : 15; // 0 turns stale tags and the Stale only filter off
    e.target.value = state.staleDays;
    save();
    renderSettings();
    renderBranches();
    renderSelected();
  });
  $('reload').addEventListener('click', reload);
}

/** Ask the helper for the protected-branch pattern and the --repo folder. False if it can't answer. */
async function loadInfo() {
  try {
    const { status, data } = await helper('/info');
    if (status !== 200 || typeof data?.protected !== 'string') throw new Error(data?.error || `status ${status}`);
    setProtected(data.protected);
    // first visit: start from the folder given to the helper with --repo
    if (!state.localPath && data.repo) { state.localPath = data.repo; save(); }
    return true;
  } catch (e) {
    $('helperDown').hidden = false;
    $('helperDown').textContent = `The helper (main.py) did not answer: ${e.message}. Restart it and reload the page.`;
    return false;
  }
}

async function start() {
  $('needsHelper').hidden = true; // modules run: the page is served by the helper
  wireLayout(renderAll); // first: the other modules draw into the panels where the layout puts them
  wireSettings();
  wireProfiles();
  wireBackup();
  wireJira();
  wireBranches();
  wireSelected();
  wireConflicts();
  wireApply();
  wireHistory();
  showImportedNote();
  if (!envTarget()) renewName(); // first visit: a timestamped target to start from
  $('jql').value = state.jql;
  renderJiraFilters();

  const helperUp = await loadInfo();
  renderAll();
  if (!helperUp) return;
  if (!ready()) showSettings(); // Guided keeps Settings in a drawer: open it once
  if (ready()) reload();
  loadJiraFilters();
}

start();
