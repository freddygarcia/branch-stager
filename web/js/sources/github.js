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
// `head` is strictly ahead of it; its sha if done. Otherwise null, and the caller merges.
async function fastForward(name, head, log) {
  const cmp = await gh(`/compare/${refPath(name)}...${refPath(head)}`);
  if (cmp.status !== 200 || cmp.data?.status !== 'ahead') return null;
  const headRef = await gh(`/git/ref/heads/${refPath(head)}`);
  if (headRef.status !== 200) return null;
  const sha = headRef.data.object.sha;
  // force: false, so GitHub refuses the update unless it is a fast-forward
  const moved = await gh(`/git/refs/heads/${refPath(name)}`, { method: 'PATCH', body: { sha, force: false } });
  if (moved.status !== 200) return null;
  log(`  ✓ ${head}  → ${sha.slice(0, 8)}  (fast-forward)`, 'ok');
  return sha;
}

/** The message of the empty commit that ends a rebuild: the same as the helper's describe_build. */
function buildMessage(name, base, baseSha, heads, profile) {
  const n = heads.length;
  return [
    `Build ${name}: ${base} + ${n} branch${n === 1 ? '' : 'es'}`,
    '',
    `Rebuilt by Branch Merger${profile ? ` from profile ${profile}` : ''}: the base and these branches, merged in this order.`,
    '',
    `Branch-Merger-Base: ${base} ${baseSha}`,
    ...heads.map(([head, sha]) => `Branch-Merger-Branch: ${head} ${sha}`),
    ...(profile ? [`Branch-Merger-Profile: ${profile}`] : []),
  ].join('\n') + '\n';
}

/** Add the empty commit describing the build on top of `tip`: { sha } or { error }. */
async function describe(tip, { name, base, branches, profile, built }) {
  const heads = [];
  for (const head of branches) {
    let sha = built?.heads?.[head];
    if (!sha) { // already contained: the merges API doesn't say at which commit
      const ref = await gh(`/git/ref/heads/${refPath(head)}`);
      sha = ref.status === 200 ? ref.data.object.sha : '?';
    }
    heads.push([head, sha]);
  }
  const commit = await gh(`/git/commits/${tip}`);
  if (commit.status !== 200) return { error: `Could not read ${tip.slice(0, 8)} (${commit.status})` };
  const oneLine = (profile || '').split(/\s+/).filter(Boolean).join(' ');
  const made = await gh('/git/commits', {
    method: 'POST',
    body: { message: buildMessage(name, base, built?.base || '?', heads, oneLine), tree: commit.data.tree.sha, parents: [tip] },
  });
  if (made.status !== 201) return { error: `Could not add the commit describing the build (${made.status}): ${made.data?.message || ''}` };
  return { sha: made.data.sha };
}

/**
 * Rebuild `name` in place: build on a temporary branch, then move `name` there once every
 * merge succeeded. `lease` is the tip of `name` seen at the last Reload (null: it did not
 * exist); `name` is only moved while it is still there, so nobody's push is overwritten.
 */
async function rebuild({ name, base, branches, ff, lease, profile, log }) {
  const tmp = `${name}-rebuild-${Date.now()}`;
  log(`Rebuild ${name}${lease ? ` (now at ${lease.slice(0, 8)})` : ' (new)'}, on ${tmp} first`);
  const outcome = await build({ name: tmp, into: name, base, branches, ff, deleteOnFail: true, log });
  if (!outcome.ok) {
    log(`${name} not changed`, 'warn');
    return { ...outcome, where: lease ? 'remote' : null };
  }
  const tip = await gh(`/git/ref/heads/${refPath(tmp)}`);
  const removeTmp = () => gh(`/git/refs/heads/${refPath(tmp)}`, { method: 'DELETE' });
  const fail = async (why) => {
    log(`${why}: ${name} not changed`, 'err');
    await removeTmp();
    return { ok: false, result: why, pushed: false, where: lease ? 'remote' : null };
  };
  if (tip.status !== 200) return fail(`Could not read ${tmp} (${tip.status})`);
  const described = await describe(tip.data.object.sha, { name, base, branches, profile, built: outcome.built });
  if (described.error) return fail(described.error);
  const { sha } = described;
  log(`  ✎ described the build in ${sha.slice(0, 8)}`, 'muted');
  const now = await gh(`/git/ref/heads/${refPath(name)}`);
  const current = now.status === 200 ? now.data.object.sha : null;
  if (current !== lease) return fail(`${name} changed on GitHub since the last Reload`);
  const moved = current
    ? await gh(`/git/refs/heads/${refPath(name)}`, { method: 'PATCH', body: { sha, force: true } })
    : await gh('/git/refs', { method: 'POST', body: { ref: `refs/heads/${name}`, sha } });
  if (![200, 201].includes(moved.status)) return fail(`Could not update ${name} (${moved.status}): ${moved.data?.message || ''}`);
  log(current ? `${name}: ${current.slice(0, 8)} → ${sha.slice(0, 8)}` : `Created ${name} at ${sha.slice(0, 8)}`, 'ok');
  await removeTmp();
  return { ...outcome, where: 'remote' };
}

const apply = (run) => (run.rebuild ? rebuild(run) : build(run));

/** Create `name` at the base and merge `branches` into it; merge messages say `into` (default `name`). */
async function build({ name, into = name, base, branches, ff, deleteOnFail, log }) {
  log(`Base ${base}`);
  const baseRef = await gh(`/git/ref/heads/${refPath(base)}`);
  if (baseRef.status !== 200) throw new Error(`Could not read ${base} (${baseRef.status}): ${baseRef.data?.message || ''}`);
  const sha = baseRef.data.object.sha;
  log(`  at ${sha.slice(0, 8)}`, 'muted');
  log(ff ? 'Merge mode: --ff (fast-forward when possible)' : 'Merge mode: --no-ff (always a merge commit)', 'muted');

  const created = await gh('/git/refs', { method: 'POST', body: { ref: `refs/heads/${name}`, sha } });
  if (created.status !== 201) throw new Error(`Could not create ${name} (${created.status}): ${created.data?.message || ''}`);
  log(`Created ${name}`, 'ok');

  // the commits merged (a branch already contained is left out: GitHub doesn't say)
  const built = { base: sha, heads: {} };
  let merged = 0;
  let fastForwarded = 0;
  let upToDate = 0;
  for (const [i, head] of branches.entries()) {
    const ffSha = ff ? await fastForward(name, head, log) : null;
    if (ffSha) {
      built.heads[head] = ffSha;
      merged++;
      fastForwarded++;
      continue;
    }
    const res = await gh('/merges', {
      method: 'POST',
      body: { base: name, head, commit_message: `Merge branch '${head}' into ${into}` },
    });
    if (res.status === 201) {
      const headSha = res.data.parents?.[1]?.sha;
      if (headSha) built.heads[head] = headSha;
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
  return { ok: true, result: `${merged} merged${ffNote}${upToDate ? `, ${upToDate} up to date` : ''}`, pushed: false, where: 'remote', built };
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
