// The Jira panel: issues from a JQL query or a saved filter, each with the branches whose
// name contains its key; issues that have a branch are listed first. Jira does not accept calls from other sites' pages, so the helper
// calls it for the page. Results are not saved.
//
// Also the issue status of each selected branch (the key in its name), flagged when the
// issue is done or not in Settings > Jira > Expected statuses.

import { filterBranches } from './branches.js';
import { $, count, el } from './dom.js';
import { helperPost } from './api.js';
import { jiraAlwaysOpen } from './layout.js';
import { renderSelected, setSelected } from './selected.js';
import { ARCHIVED, isProtected, listed, save, session, state } from './state.js';

const jira = { filters: [], url: '', issues: [], next: null, jql: '', loading: false, error: null, setup: null };
let run = 0;
// sent with every Jira request; all empty: the helper uses its JIRA_* environment
const settings = () => ({ url: state.jiraUrl, email: state.jiraEmail, token: state.jiraToken });

/** Listed branches whose name has the issue key as a whole token: ODS-38 is not ODS-382. */
function branchesFor(key) {
  const re = new RegExp(`(^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`, 'i');
  return listed().filter((n) =>
    re.test(n) && n !== state.base && !isProtected(n) && !ARCHIVED.test(n));
}

// ---------------------------------------------------------------- selected branches' issues

// key -> issue; null when Jira doesn't know the key, or the lookup failed. Kept until Reload.
const known = new Map();
const asking = new Set();

/** The issue key in a branch name, upper-cased: feature/ods-3821-fix -> ODS-3821; else null. */
export function keyOf(name) {
  const m = /(?:^|[^a-z0-9])([a-z][a-z0-9_]+-[0-9]+)(?![0-9])/i.exec(name);
  return m ? m[1].toUpperCase() : null;
}

/** The issue of branch `name`, if loaded. */
export const issueOf = (name) => known.get(keyOf(name)) || null;

/** Why the issue of a selected branch looks wrong for an environment, or null. */
export function issueProblem(issue) {
  if (!issue) return null;
  const expect = state.jiraExpect.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (expect.length) {
    return expect.includes(issue.status.toLowerCase()) ? null : `${issue.key} is ${issue.status}, not ${state.jiraExpect}`;
  }
  return issue.category === 'done' ? `${issue.key} is ${issue.status}` : null;
}

/** Look up the issues of branches `names` not known yet; then `redraw()`, if any arrived. */
export async function loadIssues(names, redraw) {
  if (jira.setup) return;
  const keys = [...new Set(names.map(keyOf).filter(Boolean))].filter((k) => !known.has(k) && !asking.has(k));
  if (!keys.length) return;
  keys.forEach((k) => asking.add(k));
  try {
    const data = await helperPost('/jira/issues', { keys, jira: settings() }, 'Jira lookup failed');
    jira.url = data.url;
    for (const issue of data.issues) known.set(issue.key, issue);
  } catch (e) {
    console.warn('Jira lookup failed', e);
  } finally {
    for (const k of keys) {
      asking.delete(k);
      if (!known.has(k)) known.set(k, null); // not asked again until Reload
    }
  }
  redraw();
}

/** Look the issues up again on the next render (Reload). */
export const forgetIssues = () => known.clear();

/** The status of a selected branch's issue, a link to it; warn-colored when flagged. */
export function issueTag(name) {
  const issue = issueOf(name);
  if (!issue) return null;
  const problem = issueProblem(issue);
  const cls = problem ? 'warn' : { done: 'ok', indeterminate: 'prog' }[issue.category] || '';
  return el('a', {
    class: `tag ${cls}`,
    href: `${jira.url}/browse/${encodeURIComponent(issue.key)}`,
    target: '_blank',
    rel: 'noopener',
    draggable: false,
    title: `${issue.key}: ${issue.summary}${problem ? `\n\n${problem}` : ''}`,
  }, issue.status);
}

// ---------------------------------------------------------------- the panel

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
    for (const issue of data.issues) known.set(issue.key, issue);
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
  $('jiraDetails').open = state.jiraOpen || jiraAlwaysOpen();
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
  // issues with a branch first; the sort is stable, so Jira's order holds within each group
  const withBranch = (i) => (branchesFor(i.key).length ? 0 : 1);
  list.replaceChildren(...[...jira.issues].sort((a, b) => withBranch(a) - withBranch(b)).map(issueRow));
}

export function wireJira() {
  // a changed Jira connection starts over: new filters, no results from the old one
  const changed = () => {
    run++;
    Object.assign(jira, { issues: [], next: null, jql: '', loading: false, error: null });
    forgetIssues();
    save();
    loadJiraFilters().then(renderSelected);
  };
  for (const id of ['jiraUrl', 'jiraEmail', 'jiraToken']) {
    $(id).addEventListener('change', (e) => { state[id] = e.target.value.trim(); changed(); });
  }
  $('jiraExpect').addEventListener('change', (e) => { state.jiraExpect = e.target.value.trim(); save(); renderSelected(); });
  $('forgetJiraToken').addEventListener('click', () => { state.jiraToken = ''; $('jiraToken').value = ''; changed(); });
  // opened by the Guided layout is not the user's choice: not saved
  $('jiraDetails').addEventListener('toggle', (e) => { if (!jiraAlwaysOpen()) { state.jiraOpen = e.target.open; save(); } });
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
