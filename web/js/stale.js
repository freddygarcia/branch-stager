// Stale features: what has moved since a profile was last built.
//
// A successful Apply records on the active profile the commits it merged (`built`). A
// branch whose tip has moved since is stale: the build doesn't have its newest commits.
// The Selected list tags each one, a note under it sums up, and every profile tab counts
// its stale branches, so you can see which environments need a rebuild.
//
// A local branch that is behind its origin copy is flagged too: a rebuild merges the local
// copy, so it would not pick up what was pushed until that copy is updated.

import { cachedCompare, loadCompares } from './aheadbehind.js';
import { $, ago, count, el } from './dom.js';
import { session, save, state } from './state.js';

/** Record a successful Apply on the active profile. `built`: { base, heads } from the source. */
export function recordBuild(run, built) {
  const p = state.profiles.find((x) => x.name === state.activeProfile);
  if (!p) return;
  // a branch the source didn't report (GitHub: already contained) counts at its last known tip
  const heads = Object.fromEntries(run.branches
    .map((n) => [n, built?.heads?.[n] || session.shas[n]])
    .filter(([, sha]) => sha));
  p.built = {
    at: Date.now(),
    name: run.name,
    base: run.base,
    baseSha: built?.base || session.shas[run.base] || null,
    heads,
  };
  save();
}

/**
 * What changed since profile `p` was last built, for the branches `names` on `base`:
 * { built, moved: [{ name, from, to }], added, removed, behind: [{ name, n }],
 *   base: { name, from, to } | { name, was } | null }.
 * null when it was never built, or the branches aren't loaded yet.
 */
export function changesSince(p, names = p.branches, base = p.base) {
  const b = p?.built;
  if (!b || !session.branches.length) return null;
  const now = session.shas;
  const moved = names
    .filter((n) => b.heads[n] && now[n] && now[n] !== b.heads[n])
    .map((n) => ({ name: n, from: b.heads[n], to: now[n] }));
  let baseChange = null;
  if (base !== b.base) baseChange = { name: base, was: b.base };
  else if (b.baseSha && now[base] && now[base] !== b.baseSha) baseChange = { name: base, from: b.baseSha, to: now[base] };
  return {
    built: b,
    moved,
    added: names.filter((n) => !b.heads[n]),
    removed: Object.keys(b.heads).filter((n) => !names.includes(n)),
    behind: names
      .filter((n) => session.meta[n]?.remote?.behind > 0)
      .map((n) => ({ name: n, n: session.meta[n].remote.behind })),
    base: baseChange,
  };
}

/** The pairs of commits to compare for `changes`: to count the new commits. */
const pairs = (c) => [...c.moved, ...(c.base?.from ? [c.base] : [])].map((m) => [m.from, m.to]);

/** "+4" / "rewritten" / "changed": how `to` compares with `from`, as far as known. */
function howMoved({ from, to }) {
  const c = cachedCompare(from, to);
  if (!c || c.error) return { short: 'changed', long: 'a new tip' };
  if (c.behind) return { short: 'rewritten', long: `rewritten (${count(c.behind, 'commit', 'commits')} of the build are gone)` };
  return { short: `+${c.ahead}`, long: count(c.ahead, 'new commit', 'new commits') };
}

const builtAs = (b) => `${ago(b.at)}, as ${b.name}`;

/** Lines describing `changes`, one per change. */
function describe(c) {
  return [
    c.base?.was ? `base is ${c.base.name}, was ${c.base.was}` : null,
    c.base?.from ? `${c.base.name} (base): ${howMoved(c.base).long}` : null,
    ...c.moved.map((m) => `${m.name}: ${howMoved(m).long}`),
    ...c.added.map((n) => `${n}: not in the build`),
    ...c.removed.map((n) => `${n}: in the build, no longer selected`),
    ...c.behind.map((x) => `${x.name}: origin has ${count(x.n, 'commit', 'commits')} your local copy doesn't (pull it first)`),
  ].filter(Boolean);
}

/** How many things a rebuild of profile `p` would pick up; 0 when none or not known. */
function staleCount(c) {
  if (!c) return 0;
  const names = new Set([...c.moved.map((m) => m.name), ...c.added, ...c.removed, ...c.behind.map((x) => x.name)]);
  return names.size + (c.base ? 1 : 0);
}

/** The tab badge of profile `p`: how many of its saved branches moved since its last build. */
export function staleBadge(p) {
  const c = changesSince(p);
  const n = staleCount(c);
  if (!n) return null;
  return el('span', {
    class: 'pstale',
    title: `Changed since the last build (${builtAs(c.built)}):\n${describe(c).join('\n')}`,
  }, `↻${n}`);
}

/** The tag of a selected branch: new commits since the active profile's last build. */
export function staleTag(name) {
  const p = state.profiles.find((x) => x.name === state.activeProfile);
  const c = p && changesSince(p, state.selected, state.base);
  if (!c) return null;
  const m = c.moved.find((x) => x.name === name);
  if (m) {
    const how = howMoved(m);
    return el('span', { class: 'tag warn', title: `${how.long} since the last build of ${p.name} (${builtAs(c.built)})` }, how.short);
  }
  const behind = c.behind.find((x) => x.name === name);
  if (behind) {
    return el('span', { class: 'tag warn', title: `origin/${name} has ${count(behind.n, 'commit', 'commits')} this local branch doesn't: a rebuild would leave them out. Pull it first.` }, `↓${behind.n} origin`);
  }
  if (c.added.includes(name)) {
    return el('span', { class: 'tag', title: `Not in the last build of ${p.name} (${builtAs(c.built)})` }, 'not built');
  }
  return null;
}

/** The note under the Selected list, and loading the commit counts it needs. */
export function renderStale(redraw) {
  const box = $('staleNote');
  const p = state.profiles.find((x) => x.name === state.activeProfile);
  const c = p && changesSince(p, state.selected, state.base);
  box.hidden = !c;
  if (!c) return;
  // counts for the active profile's selection, and for every tab's badge
  const all = [c, ...state.profiles.map((x) => changesSince(x)).filter(Boolean)];
  loadCompares(all.flatMap(pairs), redraw);

  const lines = describe(c);
  box.className = lines.length ? 'warn' : 'ok';
  if (!lines.length) {
    box.replaceChildren(`✓ Nothing changed since the last build of ${p.name} (${builtAs(c.built)}).`);
    return;
  }
  const verb = p.target === c.built.name ? `Rebuild ${p.target}` : 'Apply';
  box.replaceChildren(
    el('div', {}, `Changed since the last build of ${p.name} (${builtAs(c.built)}):`),
    el('ul', {}, lines.map((l) => el('li', {}, l))),
    el('div', {}, `${verb} to bring it up to date.`),
  );
}
