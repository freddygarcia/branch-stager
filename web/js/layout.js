// Layouts (Settings > Layout). Classic is the page as it always was. Guided puts the branch
// pickers in tabs next to the build plan, under a navy bar with Settings in a drawer.
//
// There is one copy of each panel (the other modules find them by id): a layout moves
// them into its slots, and app.css themes the page by <html data-layout>. A comment marks
// each panel's place in the classic page, so it can go back there.

import { $ } from './dom.js';
import { save, session, state } from './state.js';

const LAYOUTS = ['classic', 'guided'];
export const layout = () => (LAYOUTS.includes(state.layout) ? state.layout : 'classic');

// in the order they are appended to a shared slot
const MOVABLE = ['branchesPanel', 'jiraBox'];
const PLACES = {
  classic: {},
  guided: { branchesPanel: 'pickBody', jiraBox: 'pickBody' },
};
const TITLES = { classic: 'Selected', guided: 'Build plan' };
const homes = new Map();

/** Guided shows the Jira panel as a tab, always open. */
export const jiraAlwaysOpen = () => layout() === 'guided';

/** Open Settings: the panel in Classic, the drawer in the other layouts. */
export function showSettings() {
  $('settingsBox').open = true;
  if (layout() === 'classic') return;
  document.documentElement.classList.add('settings-open');
  $('scrim').hidden = false;
  $('settingsBtn').setAttribute('aria-expanded', 'true');
  $('settingsClose').focus();
}

function closeSettings() {
  const html = document.documentElement;
  if (!html.classList.contains('settings-open')) return;
  html.classList.remove('settings-open');
  $('scrim').hidden = true;
  $('settingsBtn').setAttribute('aria-expanded', 'false');
  if (layout() !== 'classic') $('settingsBtn').focus();
}

/** Guided: which picker tab shows, all branches or Jira issues. */
function renderPickTabs() {
  const jira = state.pickTab === 'jira';
  $('tabJira').setAttribute('aria-selected', String(jira));
  $('tabBranches').setAttribute('aria-selected', String(!jira));
  $('jiraBox').classList.toggle('tab-off', !jira);
  $('branchesPanel').classList.toggle('tab-off', jira);
}

/** Guided: the step bar follows the work, pick → order and check → build. */
export function renderSteps() {
  if (layout() !== 'guided') return;
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
    if (places[id]) $(places[id]).append($(id));
    else homes.get(id).after($(id));
  }
  $('selectedTitle').textContent = TITLES[name];
  $('selectedSub').hidden = name !== 'classic';
  if (name === 'classic') closeSettings();
  renderPickTabs();
  renderSteps();
}

function onKey(e) {
  const name = layout();
  if (e.key === 'Escape' && document.documentElement.classList.contains('settings-open')) {
    closeSettings();
    return;
  }
  if (name === 'classic') return;
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
  $('settingsBtn').addEventListener('click', () => {
    if (document.documentElement.classList.contains('settings-open')) closeSettings();
    else showSettings();
  });
  $('settingsClose').addEventListener('click', closeSettings);
  $('scrim').addEventListener('click', closeSettings);
  $('historyBtn').addEventListener('click', () => {
    closeSettings();
    $('historyDetails').open = true;
    $('historyBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  for (const [id, tab] of [['tabJira', 'jira'], ['tabBranches', 'branches']]) {
    $(id).addEventListener('click', () => { state.pickTab = tab; save(); renderPickTabs(); });
  }
  document.addEventListener('keydown', onKey);
  applyLayout();
}
