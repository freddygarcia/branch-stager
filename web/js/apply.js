// Apply: cut the new branch from the base and merge the selection into it, in order,
// through the current source. Also the controls around it: name, merge strategy, push.

import { $, el, stamp } from './dom.js';
import { addHistory } from './history.js';
import { reload } from './main.js';
import { renderSelected } from './selected.js';
import { branchUrl, compareUrl, repoUrl } from './sources/github.js';
import { ready, source } from './sources/index.js';
import { isProtected, session, state } from './state.js';

const DEPLOY_WORKFLOW = 'cd.fullstack.deploy.yml';

export const renewName = () => { $('newName').value = state.prefix + stamp(); };

// Merge strategy and "Push to origin" are chosen again on every page load: not saved.
const mergeFf = () => document.querySelector('input[name="mergeMode"]:checked')?.value === 'ff';
const pushNew = () => source().canPush && $('pushNew').checked;

function renderMergeHint() {
  $('mergeHint').textContent = mergeFf()
    ? 'A branch that is ahead of the new branch moves it forward with no merge commit. Branches that have diverged still get a merge commit.'
    : 'Every branch gets its own merge commit, so the history shows what was merged and when.';
}

export function renderApplyControls() {
  const { running } = session;
  $('apply').disabled = running || !state.selected.length || !state.base || !ready();
  $('apply').textContent = pushNew() ? 'Apply & push' : 'Apply';
  $('pushBox').hidden = !source().canPush;
  $('pushNew').disabled = running;
  $('mergeMode').disabled = running;
}

// ---------------------------------------------------------------- the run panel

function log(text, cls = '') {
  const line = el('div', { class: cls }, text);
  $('log').append(line);
  line.scrollIntoView({ block: 'nearest' });
}

function startRun(...lines) {
  $('runBox').hidden = false;
  $('log').replaceChildren(...lines);
  $('runLinks').replaceChildren();
}

const alertInline = (message) => startRun(el('div', { class: 'err' }, message));

const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener' }, text);
const sep = () => el('span', { class: 'muted' }, '·');

/** Links for a new branch on GitHub. */
function remoteLinks(name, base) {
  $('runLinks').append(
    link(branchUrl(name), 'Open branch'), sep(),
    link(compareUrl(base, name), `Compare with ${base}`), sep(),
    link(`${repoUrl()}/actions/workflows/${DEPLOY_WORKFLOW}`, 'Deploy workflow'),
    el('span', { class: 'muted' }, '(branch:'), el('code', {}, name), el('span', { class: 'muted' }, ')'),
  );
}

/** How to push and check out a new branch that only exists in the local clone. */
function localLinks(name) {
  const push = `git push -u origin ${name}:refs/heads/${name}`;
  $('runLinks').append(
    el('span', { class: 'muted' }, 'Created locally. Push it:'),
    el('code', {}, push),
    el('button', { class: 'icon', title: 'Copy the push command', onclick: () => navigator.clipboard?.writeText(push) }, 'Copy'),
    el('span', { class: 'muted' }, '· check it out with'),
    el('code', {}, `git switch ${name}`),
  );
}

// ---------------------------------------------------------------- apply

/** Why the new branch can't be made, or null. */
function refusal(name, branches) {
  if (!name) return 'Enter a name for the new branch.';
  if (isProtected(name)) return `"${name}" is a protected branch name. Pick another one.`;
  if (session.branches.includes(name)) return `"${name}" already exists. Pick a new name.`;
  const missing = branches.filter((n) => session.branches.length && !session.branches.includes(n));
  if (missing.length) return `${source().missingText}: ${missing.join(', ')}. Remove them first.`;
  return null;
}

async function apply() {
  const src = source();
  const run = {
    name: $('newName').value.trim(),
    base: state.base,
    branches: [...state.selected],
    ff: mergeFf(),
    push: pushNew(),
    deleteOnFail: state.deleteOnFail,
  };
  const refused = refusal(run.name, run.branches);
  if (refused) return alertInline(refused);

  session.running = true;
  renderSelected();
  startRun();

  let outcome;
  try {
    outcome = await src.apply({ ...run, log });
  } catch (e) {
    log(e.message, 'err');
    outcome = { ok: false, result: e.message, pushed: false, where: null };
  }
  if (outcome.where === 'remote') remoteLinks(run.name, run.base.replace(/^origin\//, ''));
  if (outcome.where === 'local') localLinks(run.name);
  addHistory({
    name: run.name, base: run.base, branches: run.branches,
    ok: outcome.ok, result: outcome.result, source: src.id, pushed: outcome.pushed,
  });
  session.running = false;
  if (outcome.ok) renewName();
  renderSelected();
  await reload(); // the new branch, and its merges, are in the list now
}

export function wireApply() {
  $('apply').addEventListener('click', apply);
  $('renew').addEventListener('click', renewName);
  $('pushNew').addEventListener('change', renderApplyControls);
  $('mergeMode').addEventListener('change', renderMergeHint);
  // no form restore: both start from their default on every page load
  document.querySelector('input[name="mergeMode"][value="no-ff"]').checked = true;
  $('pushNew').checked = false;
  renderMergeHint();
}
