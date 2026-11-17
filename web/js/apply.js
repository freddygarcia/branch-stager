// Apply: cut the new branch from the base and merge the selection into it, in order,
// through the current source. Also the controls around it: name, merge strategy, push.

import { $, el, stamp } from './dom.js';
import { addHistory } from './history.js';
import { reload } from './main.js';
import { activeProfile, envTarget, setEnvTarget } from './profiles.js';
import { renderSelected } from './selected.js';
import { branchUrl, compareUrl, repoUrl } from './sources/github.js';
import { ready, source } from './sources/index.js';
import { recordBuild } from './stale.js';
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

/** Where Apply writes: the active profile's environment branch (rebuilt), else a new branch. */
function target() {
  const env = envTarget();
  return env ? { name: env, rebuild: true } : { name: $('newName').value.trim(), rebuild: false };
}

/** Why `name` can't be an environment branch, or null. */
function envProblem(name) {
  const same = (n) => n === name || n === `origin/${name}`;
  if (isProtected(name)) return `${name} is a protected branch name: pick another one, e.g. env/${name}.`;
  if (same(state.base)) return `${name} is the base branch: it can't also be rebuilt from it.`;
  if (state.selected.some(same)) return `${name} is in the selection: remove it, or pick another environment branch.`;
  return null;
}

function renderEnv(running) {
  const p = activeProfile();
  const env = envTarget();
  $('envBox').hidden = !p;
  $('newNameBox').hidden = Boolean(env);
  if (!p) return;
  $('envProfile').textContent = p.name;
  if (document.activeElement !== $('envBranch')) $('envBranch').value = env;
  $('envBranch').disabled = running;
  const problem = env && envProblem(env);
  const where = source().id === 'github' ? 'on GitHub' : 'in the local clone';
  const exists = session.branches.includes(env);
  $('envHint').className = problem ? 'err' : '';
  $('envHint').textContent = problem || (env
    ? (exists
      ? `Apply rebuilds ${env} ${where} from the base and the selection, replacing what it had.`
      : `Apply creates ${env} ${where} from the base and the selection; later Applies rebuild it in place.`)
      + ' It only changes if every merge succeeds.'
      + (source().canPush ? ' Push replaces origin\'s copy with --force-with-lease: a push someone made since the last Reload is not overwritten.' : '')
    : 'Name a branch to rebuild it in place on every Apply, instead of creating a new branch each time.');
}

export function renderApplyControls() {
  const { running } = session;
  const env = envTarget();
  renderEnv(running);
  $('apply').disabled = running || !state.selected.length || !state.base || !ready();
  const verb = env ? `Rebuild ${env}` : 'Apply';
  $('apply').textContent = pushNew() ? `${verb} & push` : verb;
  $('pushBox').hidden = !source().canPush;
  $('pushBox').title = env
    ? `After all merges succeed, push ${env} to origin, replacing origin's copy (git push --force-with-lease). Off by default on every page load.`
    : 'After all merges succeed, push the new branch to origin (git push --set-upstream). Off by default on every page load.';
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
function refusal({ name, rebuild, branches }) {
  if (rebuild) {
    const problem = envProblem(name);
    if (problem) return problem;
  } else {
    if (!name) return 'Enter a name for the new branch.';
    if (isProtected(name)) return `"${name}" is a protected branch name. Pick another one.`;
    if (session.branches.includes(name)) return `"${name}" already exists. Pick a new name.`;
  }
  const missing = branches.filter((n) => session.branches.length && !session.branches.includes(n));
  if (missing.length) return `${source().missingText}: ${missing.join(', ')}. Remove them first.`;
  return null;
}

async function apply() {
  const src = source();
  const run = {
    ...target(),
    base: state.base,
    branches: [...state.selected],
    ff: mergeFf(),
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
  if (outcome.ok && !run.rebuild) renewName();
  renderSelected();
  await reload(); // the new branch, and its merges, are in the list now
}

export function wireApply() {
  $('apply').addEventListener('click', apply);
  $('renew').addEventListener('click', renewName);
  $('pushNew').addEventListener('change', renderApplyControls);
  $('envBranch').addEventListener('change', (e) => { setEnvTarget(e.target.value.trim()); renderSelected(); });
  $('mergeMode').addEventListener('change', renderMergeHint);
  // no form restore: both start from their default on every page load
  document.querySelector('input[name="mergeMode"][value="no-ff"]').checked = true;
  $('pushNew').checked = false;
  renderMergeHint();
}
