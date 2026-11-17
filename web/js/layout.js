// Layouts (Settings > Layout). Classic is the page as it always was. Guided fits one
// window: the branch pickers in tabs next to the build plan (which also shows conflicts and
// the run log), under a navy bar that opens Settings and History as drawers.
//
// There is one copy of each panel (the other modules find them by id): a layout moves
// them into its slots, and app.css themes the page by <html data-layout>. A comment marks
// each panel's place in the classic page, so it can go back there.

import { $ } from './dom.js';
import { save, session, state } from './state.js';

const LAYOUTS = ['classic', 'guided'];
export const layout = () => (LAYOUTS.includes(state.layout) ? state.layout : 'classic');
const guided = () => layout() === 'guided';

// in the order they are placed; a place is a container's id (appended to it) or
// { before: id } (put just before that element)
const MOVABLE = ['branchesPanel', 'jiraBox', 'conflictBox', 'runBox'];
const PLACES = {
  classic: {},
  guided: {
    branchesPanel: 'pickBody', jiraBox: 'pickBody',
    conflictBox: { before: 'buildControls' }, runBox: { before: 'buildControls' },
  },
};
const TITLES = { classic: 'Selected', guided: 'Build plan' };
const homes = new Map();

/** Guided shows Jira as a tab and History as a drawer: both always open. */
export const jiraAlwaysOpen = guided;
export const historyAlwaysOpen = guided;

// ---------------------------------------------------------------- drawers (Guided)

// `details`: the collapsible section inside; its summary is hidden in a drawer, so a
// drawer always opens it (or the drawer would look empty)
const DRAWERS = {
  settings: { panel: 'settingsPanel', details: 'settingsBox', button: 'settingsBtn', close: 'settingsClose' },
  history: { panel: 'historyBox', details: 'historyDetails', button: 'historyBtn', close: 'historyClose' },
};
const openDrawer = () => document.documentElement.dataset.drawer || '';

function showDrawer(name) {
  closeDrawer({ refocus: false });
  $(DRAWERS[name].details).open = true;
  document.documentElement.dataset.drawer = name;
  $('scrim').hidden = false;
  $(DRAWERS[name].button).setAttribute('aria-expanded', 'true');
  $(DRAWERS[name].close).focus();
}

function closeDrawer({ refocus = true } = {}) {
  const name = openDrawer();
  if (!name) return;
  delete document.documentElement.dataset.drawer;
  $('scrim').hidden = true;
  $(DRAWERS[name].button).setAttribute('aria-expanded', 'false');
  if (refocus && guided()) $(DRAWERS[name].button).focus();
}

const toggleDrawer = (name) => (openDrawer() === name ? closeDrawer() : showDrawer(name));

/** Open Settings: the panel in Classic, the drawer in Guided. */
export function showSettings() {
  $('settingsBox').open = true;
  if (guided()) showDrawer('settings');
}

// ---------------------------------------------------------------- guided's pieces

/** Which picker tab shows, all branches or Jira issues. */
function renderPickTabs() {
  const jira = state.pickTab === 'jira';
  $('tabJira').setAttribute('aria-selected', String(jira));
  $('tabBranches').setAttribute('aria-selected', String(!jira));
  $('jiraBox').classList.toggle('tab-off', !jira);
  $('branchesPanel').classList.toggle('tab-off', jira);
}

/** The step bar follows the work, pick → order and check → build. */
export function renderSteps() {
  if (!guided()) return;
  const now = session.running || !$('runBox').hidden ? 3 : state.selected.length ? 2 : 1;
  for (const li of $('steps').children) {
    const n = Number(li.dataset.step);
    li.className = n === now ? 'now' : n < now ? 'done' : '';
    if (n === now) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  }
}

/** Arrange the page for the chosen layout. */
function applyLayout() {
  const name = layout();
  document.documentElement.dataset.layout = name;
  $('layout').value = name;
  const places = PLACES[name];
  for (const id of MOVABLE) {
    const to = places[id];
    if (!to) homes.get(id).after($(id));
    else if (to.before) $(to.before).before($(id));
    else $(to).append($(id));
  }
  $('selectedTitle').textContent = TITLES[name];
  $('selectedSub').hidden = name !== 'classic';
  if (name === 'classic') closeDrawer();
  renderPickTabs();
  renderSteps();
}

function onKey(e) {
  if (e.key === 'Escape' && openDrawer()) {
    closeDrawer();
    return;
  }
  if (!guided()) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    if (e.target.closest?.('textarea, #settingsPanel')) return;
    e.preventDefault();
    if (!$('apply').disabled) $('apply').click();
  }
}

/** Wire the layout controls and arrange the page. `rerender`: draw every panel again. */
export function wireLayout(rerender) {
  for (const id of MOVABLE) {
    const mark = document.createComment(`home of #${id}`);
    $(id).before(mark);
    homes.set(id, mark);
  }
  $('applyKbd').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ Enter' : 'Ctrl Enter';
  $('layout').addEventListener('change', (e) => {
    state.layout = e.target.value;
    save();
    applyLayout();
    rerender();
  });
  for (const [name, d] of Object.entries(DRAWERS)) {
    $(d.button).addEventListener('click', () => toggleDrawer(name));
    $(d.close).addEventListener('click', () => closeDrawer());
  }
  $('scrim').addEventListener('click', () => closeDrawer());
  for (const [id, tab] of [['tabJira', 'jira'], ['tabBranches', 'branches']]) {
    $(id).addEventListener('click', () => { state.pickTab = tab; save(); renderPickTabs(); });
  }
  document.addEventListener('keydown', onKey);
  applyLayout();
}
