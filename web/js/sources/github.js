// Source "GitHub": remote branches only, merged through the GitHub API.
// The token is stored in this browser and only ever sent to api.github.com.

import { gh } from '../api.js';
import { state } from '../state.js';

const refPath = (name) => name.split('/').map(encodeURIComponent).join('/');
export const repoUrl = () => `https://github.com/${state.owner}/${state.repo}`;
export const branchUrl = (name) => `${repoUrl()}/tree/${refPath(name)}`;
export const compareUrl = (base, name) => `${repoUrl()}/compare/${refPath(base)}...${refPath(name)}`;

async function listBranches() {
  const found = {};
  for (let page = 1; page < 50; page++) {
    const { status, data } = await gh(`/branches?per_page=100&page=${page}`);
    if (status !== 200) throw new Error(`Listing branches failed (${status}): ${data?.message || ''}`);
    for (const b of data) found[b.name] = { sha: b.commit.sha };
    if (data.length < 100) break;
  }
  return found;
}

async function compare(base, head) {
  // compare by sha (no escaping of branch names); per_page=1 keeps the payload small
  const { status, data } = await gh(`/compare/${base}...${head}?per_page=1`);
  return status === 200
    ? { ahead: data.ahead_by, behind: data.behind_by }
    : { error: `${status} ${data?.message || ''}`.trim() };
}

// GitHub's merge API always makes a merge commit. For --ff, move `name` to `head` when
// `head` is strictly ahead of it; true if done. Otherwise false, and the caller merges.
async function fastForward(name, head, log) {
  const cmp = await gh(`/compare/${refPath(name)}...${refPath(head)}`);
  if (cmp.status !== 200 || cmp.data?.status !== 'ahead') return false;
  const headRef = await gh(`/git/ref/heads/${refPath(head)}`);
  if (headRef.status !== 200) return false;
  const sha = headRef.data.object.sha;
  // force: false, so GitHub refuses the update unless it is a fast-forward
  const moved = await gh(`/git/refs/heads/${refPath(name)}`, { method: 'PATCH', body: { sha, force: false } });
  if (moved.status !== 200) return false;
  log(`  ✓ ${head}  → ${sha.slice(0, 8)}  (fast-forward)`, 'ok');
  return true;
}

async function apply({ name, base, branches, ff, deleteOnFail, log }) {
  log(`Base ${base}`);
  const baseRef = await gh(`/git/ref/heads/${refPath(base)}`);
  if (baseRef.status !== 200) throw new Error(`Could not read ${base} (${baseRef.status}): ${baseRef.data?.message || ''}`);
  const sha = baseRef.data.object.sha;
  log(`  at ${sha.slice(0, 8)}`, 'muted');
  log(ff ? 'Merge mode: --ff (fast-forward when possible)' : 'Merge mode: --no-ff (always a merge commit)', 'muted');

  const created = await gh('/git/refs', { method: 'POST', body: { ref: `refs/heads/${name}`, sha } });
  if (created.status !== 201) throw new Error(`Could not create ${name} (${created.status}): ${created.data?.message || ''}`);
  log(`Created ${name}`, 'ok');

  let merged = 0;
  let fastForwarded = 0;
  let upToDate = 0;
  for (const [i, head] of branches.entries()) {
    if (ff && await fastForward(name, head, log)) {
      merged++;
      fastForwarded++;
      continue;
    }
    const res = await gh('/merges', {
      method: 'POST',
      body: { base: name, head, commit_message: `Merge branch '${head}' into ${name}` },
    });
    if (res.status === 201) {
      merged++;
      log(`  ✓ ${head}  → ${res.data.sha.slice(0, 8)}`, 'ok');
      continue;
    }
    if (res.status === 204) {
      upToDate++;
      log(`  = ${head}  already contained, nothing to merge`, 'muted');
      continue;
    }
    const why = res.status === 409
      ? `conflicts with ${[base, ...branches.slice(0, i)].join(' + ')}`
      : `${res.status}: ${res.data?.message || 'merge failed'}`;
    log(`  ✗ ${head}  ${why}`, 'err');
    const failed = { ok: false, result: `Conflict: ${head}`, pushed: false, where: null };
    if (!deleteOnFail) {
      log(`${name} kept with the merges before ${head}`, 'warn');
      return { ...failed, where: 'remote' };
    }
    const del = await gh(`/git/refs/heads/${refPath(name)}`, { method: 'DELETE' });
    log(del.status === 204 ? `Deleted ${name}` : `Could not delete ${name} (${del.status})`, del.status === 204 ? 'warn' : 'err');
    return failed;
  }

  const ffNote = fastForwarded ? ` (${fastForwarded} fast-forwarded)` : '';
  log(`Done: ${merged} merged${ffNote}, ${upToDate} already contained.`, 'ok');
  return { ok: true, result: `${merged} merged${ffNote}${upToDate ? `, ${upToDate} up to date` : ''}`, pushed: false, where: 'remote' };
}

export default {
  id: 'github',
  settingField: 'token',
  notReadyText: 'Add a token in Settings, then Reload.',
  missingText: 'Not on the remote any more',
  canPush: false, // the new branch is on GitHub already
  ready: () => Boolean(state.token),
  summary: () => `${state.owner}/${state.repo}${state.token ? '' : ' · no token'}`,
  listBranches,
  compare,
  apply,
};
