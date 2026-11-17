// Apply: build the target branch from the base plus the selection, in order, through the
// current source. Every target is treated as an environment branch: the first Apply
// creates it, later ones rebuild it in place, and it only changes if every merge succeeds.
// Also the controls around it: target branch and push. The merge strategy is in Settings.

import { $, el, stamp } from './dom.js';
import { addHistory } from './history.js';
import { reload } from './main.js';
import { activeProfile, envTarget, setEnvTarget } from './profiles.js';
import { renderSelected } from './selected.js';
import { branchUrl, compareUrl, repoUrl } from './sources/github.js';
import { ready, source } from './sources/index.js';
import { recordBuild } from './stale.js';
import { isProtected, save, session, state } from './state.js';

const DEPLOY_WORKFLOW = 'cd.fullstack.deploy.yml';

/** Point the target at a new timestamped branch (↻). */
export function renewName() {
  setEnvTarget(state.prefix + stamp());
  $('target').value = envTarget();
}

// "Push to origin" is chosen again on every page load: not saved.
const pushNew = () => source().canPush && $('pushNew').checked;

function renderMergeHint() {
  $('mergeHint').textContent = state.mergeFf
    ? 'A branch that is ahead of the target moves it forward with no merge commit. Branches that have diverged still get a merge commit.'
    : 'Every branch gets its own merge commit, so the history shows what was merged and when.';
}

/** Why `name` can't be the target branch, or null. */
function targetProblem(name) {
  const same = (n) => n === name || n === `origin/${name}`;
  if (!name) return 'Name the branch to build, e.g. env/staging, or press ↻ for a new one.';
  if (isProtected(name)) return `${name} is a protected branch name: pick another one, e.g. env/${name}.`;
  if (same(state.base)) return `${name} is the base branch: it can't also be rebuilt from it.`;
  if (state.selected.some(same)) return `${name} is in the selection: remove it, or pick another target branch.`;
  return null;
}

function renderTarget(running) {
  const p = activeProfile();
  const name = envTarget();
  $('targetProfile').textContent = p ? `· profile ${p.name}` : '';
  if (document.activeElement !== $('target')) $('target').value = name;
  $('target').disabled = running;
  $('renew').disabled = running;
  const problem = targetProblem(name);
  const where = source().id === 'github' ? 'on GitHub' : 'in the local clone';
  const exists = session.branches.includes(name);
  const hint = $('targetHint');
  hint.className = `hint${problem ? ' err' : exists ? ' warn' : ''}`;
  hint.textContent = problem || (exists
    ? `Apply replaces ${name} ${where} with the base plus the selection.`
    : `Apply creates ${name} ${where}; later Applies rebuild it in place.`);
  hint.title = problem ? '' : 'The branch only changes if every merge succeeds.'
    + (source().canPush ? ' Push replaces origin\'s copy with --force-with-lease: a push someone made since the last Reload is not overwritten.' : '');
}

export function renderApplyControls() {
  const { running } = session;
  const name = envTarget();
  renderTarget(running);
  $('apply').disabled = running || !state.selected.length || !state.base || !ready() || Boolean(targetProblem(name));
  const verb = session.branches.includes(name) ? 'Rebuild' : 'Create';
  $('apply').textContent = `${verb}${pushNew() ? ' & push' : ''}`;
  $('apply').title = `${verb} ${name}`;
  $('pushBox').hidden = !source().canPush;
  $('pushBox').title = `After all merges succeed, push ${name || 'the target'} to origin, replacing origin's copy (git push --force-with-lease). Off by default on every page load.`;
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

/** How to push and check out a branch that only exists in the local clone. */
function localLinks(name, rebuild) {
  const push = `git push ${rebuild ? '--force-with-lease ' : ''}-u origin ${name}:refs/heads/${name}`;
  $('runLinks').append(
    el('span', { class: 'muted' }, rebuild ? 'Rebuilt locally. Push it:' : 'Created locally. Push it:'),
    el('code', {}, push),
    el('button', { class: 'icon', title: 'Copy the push command', onclick: () => navigator.clipboard?.writeText(push) }, 'Copy'),
    el('span', { class: 'muted' }, '· check it out with'),
    el('code', {}, `git switch ${name}`),
  );
}

// ---------------------------------------------------------------- apply

/** Why the branch can't be made (or rebuilt), or null. */
function refusal({ name, branches }) {
  const problem = targetProblem(name);
  if (problem) return problem;
  const missing = branches.filter((n) => session.branches.length && !session.branches.includes(n));
  if (missing.length) return `${source().missingText}: ${missing.join(', ')}. Remove them first.`;
  return null;
}

async function apply() {
  const src = source();
  setEnvTarget($('target').value.trim()); // what is typed, even if it was never committed with Enter
  const run = {
    name: envTarget(),
    rebuild: true, // every target is an environment branch: created, then rebuilt in place
    base: state.base,
    branches: [...state.selected],
    ff: state.mergeFf,
    push: pushNew(),
    deleteOnFail: state.deleteOnFail,
    profile: activeProfile()?.name || '', // named in the commit that describes a rebuild
  };
  // the tip seen at the last Reload: GitHub only replaces the branch while it is still there
  run.lease = session.shas[run.name] ?? null;
  const refused = refusal(run);
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
  if (outcome.where === 'local') localLinks(run.name, run.rebuild);
  addHistory({
    name: run.name, base: run.base, branches: run.branches, rebuilt: run.rebuild,
    ok: outcome.ok, result: outcome.result, source: src.id, pushed: outcome.pushed,
  });
  if (outcome.ok) recordBuild(run, outcome.built);
  session.running = false;
  renderSelected();
  await reload(); // the new branch, and its merges, are in the list now
}

export function wireApply() {
  $('apply').addEventListener('click', apply);
  $('renew').addEventListener('click', () => { renewName(); renderSelected(); });
  $('pushNew').addEventListener('change', renderApplyControls);
  // typing updates the hint and the button; the profile tabs follow when the field is left
  $('target').addEventListener('input', (e) => { setEnvTarget(e.target.value.trim()); renderApplyControls(); });
  $('target').addEventListener('change', renderSelected);
  $('mergeMode').addEventListener('change', (e) => {
    state.mergeFf = e.target.value === 'ff';
    save();
    renderMergeHint();
  });
  document.querySelector(`input[name="mergeMode"][value="${state.mergeFf ? 'ff' : 'no-ff'}"]`).checked = true;
  $('pushNew').checked = false; // no form restore: off on every page load
  renderMergeHint();
}
