// The Jira panel: issues from a JQL query or a saved filter, each with the branches whose
// name contains its key. Jira does not accept calls from other sites' pages, so the helper
// calls it for the page. Results are not saved.

import { filterBranches } from './branches.js';
import { $, count, el } from './dom.js';
import { helperPost } from './api.js';
import { setSelected } from './selected.js';
import { ARCHIVED, isProtected, listed, save, session, state } from './state.js';

const jira = { filters: [], url: '', issues: [], next: null, jql: '', loading: false, error: null, setup: null };
let run = 0;
// sent with every Jira request; all empty: the helper uses its JIRA_* environment
const settings = () => ({ url: state.jiraUrl, email: state.jiraEmail, token: state.jiraToken });

/** Listed branches whose name has the issue key as a whole token: ODS-38 is not ODS-382. */
function branchesFor(key) {
  const re = new RegExp(`(^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`, 'i');
  return listed().filter((n) =>
    re.test(n) && n !== state.base && !isProtected(n) && (!state.hideArchived || !ARCHIVED.test(n)));
}

export async function loadJiraFilters() {
  try {
    const data = await helperPost('/jira/filters', { jira: settings() }, 'Loading Jira filters failed');
    jira.filters = data.filters;
    jira.url = data.url;
    jira.setup = null;
  } catch (e) {
    jira.filters = [];
    jira.setup = e.message;
  }
  renderJiraFilters();
  renderJira();
  if (!jira.setup && state.jql) searchJira();
}

async function searchJira(more = false) {
  const jql = more ? jira.jql : $('jql').value.trim();
  if (!jql) return;
  const thisRun = ++run;
  jira.loading = true;
  jira.error = null;
  if (!more) Object.assign(jira, { issues: [], next: null, jql });
  renderJira();
  try {
    const data = await helperPost('/jira/search', { jql, next: more ? jira.next : null, jira: settings() }, 'Jira search failed');
    if (thisRun !== run) return; // a newer search started meanwhile
    jira.issues = [...jira.issues, ...data.issues];
    jira.next = data.next;
    jira.url = data.url;
  } catch (e) {
    if (thisRun !== run) return;
    jira.error = e.message;
  }
  jira.loading = false;
  renderJira();
}

/** Add the branches of these issues to the selection; with `toggle`, remove them if all are in it. */
function selectForIssues(keys, { toggle = false } = {}) {
  const names = [...new Set(keys.flatMap(branchesFor))];
  if (!names.length) return;
  const { selected } = state;
  setSelected(toggle && names.every((n) => selected.includes(n))
    ? selected.filter((n) => !names.includes(n))
    : [...selected, ...names.filter((n) => !selected.includes(n))]);
}

export function renderJiraFilters() {
  const select = $('jiraFilter');
  select.replaceChildren(el('option', { value: '' }, 'Custom JQL'));
  for (const f of jira.filters) {
    select.append(el('option', { value: f.id, selected: f.id === state.jiraFilter }, `${f.favourite ? '★ ' : ''}${f.name}`));
  }
  if (!jira.filters.some((f) => f.id === state.jiraFilter)) select.value = '';
}

function branchButton(issue) {
  if (!session.branches.length) return null;
  const names = branchesFor(issue.key);
  if (!names.length) return el('span', { class: 'tag', title: `No branch name contains ${issue.key}` }, 'no branch');
  const picked = names.filter((n) => state.selected.includes(n)).length;
  const all = picked === names.length;
  return el('button', {
    class: `tag${all ? ' ok' : ''}`,
    title: `${names.join('\n')}\n\n${all ? 'Click to remove them from the selection' : 'Click to add them to the selection'}`,
    disabled: session.running,
    onclick: () => selectForIssues([issue.key], { toggle: true }),
  }, all ? `✓ ${names.length} selected` : `+ ${count(names.length - picked, 'branch', 'branches')}`);
}

function issueRow(issue) {
  const statusClass = { done: 'ok', indeterminate: 'prog' }[issue.category] || '';
  return el('div', { class: 'item' },
    el('a', { class: 'jira-key', href: `${jira.url}/browse/${encodeURIComponent(issue.key)}`, target: '_blank', rel: 'noopener' }, issue.key),
    el('span', { class: 'jira-summary', title: [issue.type, issue.priority].filter(Boolean).join(' · ') }, issue.summary),
    issue.assignee ? el('span', { class: 'jira-who' }, issue.assignee) : null,
    el('span', { class: `tag ${statusClass}` }, issue.status),
    branchButton(issue),
    el('button', { class: 'icon', title: `Filter the branch list by ${issue.key}`, onclick: () => filterBranches(issue.key) }, '⌕'),
  );
}

export function renderJira() {
  const list = $('jiraList');
  const summary = $('jiraSummary');
  $('jiraDetails').open = state.jiraOpen;
  for (const id of ['jiraFilter', 'jql', 'jiraRun']) $(id).disabled = Boolean(jira.setup);
  $('jiraRun').disabled ||= jira.loading;
  $('jiraMore').hidden = !jira.next;
  $('jiraMore').disabled = jira.loading;

  const empty = (text, cls = '') => {
    list.replaceChildren(el('div', { class: `empty ${cls}` }, text));
    $('jiraCount').textContent = '';
    $('jiraSelectAll').hidden = true;
  };
  if (jira.setup) { summary.textContent = '— not set up'; return empty(jira.setup, 'err'); }

  const issues = `${jira.issues.length}${jira.next ? '+' : ''} issues`;
  summary.textContent = jira.issues.length ? `— ${issues}` : '';
  if (jira.error) return empty(jira.error, 'err');
  if (!jira.issues.length) return empty(jira.loading ? 'Searching…' : jira.jql ? 'No issues match.' : 'Pick a saved filter or type JQL, then Search.');

  const matched = jira.issues.filter((i) => branchesFor(i.key).length).length;
  $('jiraCount').textContent = session.branches.length
    ? `${issues}, ${matched} with a branch`
    : `${issues} · Reload branches to match them`;
  $('jiraSelectAll').hidden = !matched;
  $('jiraSelectAll').disabled = session.running;
  list.replaceChildren(...jira.issues.map(issueRow));
}

export function wireJira() {
  // a changed Jira connection starts over: new filters, no results from the old one
  const changed = () => {
    run++;
    Object.assign(jira, { issues: [], next: null, jql: '', loading: false, error: null });
    save();
    loadJiraFilters();
  };
  for (const id of ['jiraUrl', 'jiraEmail', 'jiraToken']) {
    $(id).addEventListener('change', (e) => { state[id] = e.target.value.trim(); changed(); });
  }
  $('forgetJiraToken').addEventListener('click', () => { state.jiraToken = ''; $('jiraToken').value = ''; changed(); });
  $('jiraDetails').addEventListener('toggle', (e) => { state.jiraOpen = e.target.open; save(); });
  $('jiraFilter').addEventListener('change', (e) => {
    state.jiraFilter = e.target.value;
    const f = jira.filters.find((x) => x.id === state.jiraFilter);
    if (f) { $('jql').value = f.jql; state.jql = f.jql; }
    save();
    if (f) searchJira();
  });
  $('jql').addEventListener('input', (e) => {
    state.jql = e.target.value;
    // edited away from the saved filter: it is custom JQL now
    if (state.jiraFilter && jira.filters.find((x) => x.id === state.jiraFilter)?.jql !== state.jql) {
      state.jiraFilter = '';
      $('jiraFilter').value = '';
    }
    save();
  });
  $('jql').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchJira(); });
  $('jiraRun').addEventListener('click', () => searchJira());
  $('jiraMore').addEventListener('click', () => searchJira(true));
  // unlike a row's button it never removes
  $('jiraSelectAll').addEventListener('click', () => selectForIssues(jira.issues.map((i) => i.key)));
}
