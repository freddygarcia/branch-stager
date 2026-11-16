// Source "Local clone": local and origin branches, merged by the helper with git in a
// temporary worktree (the user's checkout is not touched). Only this source has a dry run
// and the conflict view.

import { helper, helperPost } from '../api.js';
import { state } from '../state.js';

/** Local and origin branches, after fetching origin: { name: { sha, kind, remote, shadowed } }. */
async function listBranches() {
  const fetched = await helper('/fetch', { method: 'POST' });
  if (fetched.status !== 200) console.warn('git fetch failed, listing what is already known', fetched.data);
  const { status, data } = await helper('/branches');
  if (status !== 200) throw new Error(`Listing branches failed (${status}): ${data?.error || ''}`);
  return Object.fromEntries(data.branches.map((b) => [b.name, b]));
}

async function compare(base, head) {
  const { status, data } = await helper(`/compare?base=${base}&head=${head}`);
  return status === 200 ? data : { error: `${status} ${data?.error || ''}`.trim() };
}

async function apply({ name, base, branches, ff, push, deleteOnFail, rebuild, log }) {
  const data = await helperPost('/apply', { name, base, branches, deleteOnFail, push, ff, rebuild }, 'Apply failed');
  for (const line of data.log) log(line.text, line.cls);
  return {
    ok: data.ok,
    result: data.result,
    pushed: data.pushed,
    where: data.pushed ? 'remote' : data.created ? 'local' : null,
  };
}

/** The dry run's result for each branch: { head: { status, files, tree, notes, message } }. */
async function dryRun(base, branches) {
  const data = await helperPost('/dry-run', { base, branches }, 'Dry run failed');
  return Object.fromEntries(data.results.map((r) => [r.head, r]));
}

/** The conflicted regions of `path` in a dry-run merge tree: { status, data }. */
const conflict = (tree, path) => helper(`/conflict?tree=${tree}&path=${encodeURIComponent(path)}`);

export default {
  id: 'local',
  settingField: 'localPath',
  notReadyText: 'Enter the repository folder in Settings, then Reload.',
  missingText: 'Not in the local clone',
  canPush: true,
  ready: () => Boolean(state.localPath),
  summary: () => `local clone${state.localPath ? ` · ${state.localPath}` : ' · no folder'}`,
  listBranches,
  compare,
  apply,
  dryRun,
  conflict,
};
