// What the page remembers (`state`, saved in localStorage) and what it knows this
// session (`session`, from the last Reload).

// Every localStorage key of this page starts with PREFIX: a backup takes them all.
export const PREFIX = 'branchMerger.';
export const KEY = `${PREFIX}v1`;
const DEFAULTS = {
  owner: 'OneDataSource',
  repo: 'oneVIEW-Admin',
  token: '',
  prefix: 'integration/',
  source: 'local',
  localPath: '',
  base: 'master',
  selected: [],
  hideArchived: true,
  hideRemote: true, // origin/* branches of a local clone (kept as base options)
  deleteOnFail: true, // sent to the helper; a rebuild never leaves a half-built branch anyway
  target: '', // the branch Apply builds when no profile is active (a profile keeps its own)
  mergeFf: false, // Settings > Build > Merge strategy: fast-forward instead of --no-ff
  history: [],
  historyOpen: true,
  // saved merges, switched between with Load: [{ name, base, branches, at, target }].
  // `target`: the profile's environment branch, rebuilt in place by Apply ('' = none)
  // `built`: its last successful Apply, { at, name, base, baseSha, heads: { branch: sha } }
  profiles: [],
  activeProfile: '',
  jiraUrl: '',
  jiraEmail: '',
  jiraToken: '',
  layout: 'classic', // Settings > Layout: classic or guided (layout.js)
  pickTab: 'branches', // Guided: the picker tab shown, 'branches' or 'jira'
  jql: '',
  jiraFilter: '',
  jiraOpen: true,
};
export const HISTORY_LIMIT = 30;
export const ARCHIVED = /^(origin\/)?archived\//;

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export const state = load();

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Could not save to localStorage', e);
  }
}

export const session = {
  branches: [], // every branch name from the last reload (base options, existence checks)
  shas: {}, // branch name -> tip sha
  meta: {}, // branch name -> what the source told about it (local clone: kind, remote, shadowed)
  running: false, // an Apply is in progress
};

/** Replace the known branches with `found`: { name: { sha, ...meta } }. */
export function setBranches(found) {
  session.branches = Object.keys(found).sort((a, b) => a.localeCompare(b));
  session.shas = Object.fromEntries(Object.entries(found).map(([n, b]) => [n, b.sha]));
  session.meta = found;
}

export const clearBranches = () => setBranches({});

/** An origin/* branch of a local clone (no local branch of that name). */
export const isRemote = (name) => session.meta[name]?.kind === 'remote';

/** Branches shown with a checkbox: origin/x is hidden when a local x exists. */
export const listed = () => session.branches.filter((n) => !session.meta[n]?.shadowed);

// Branches that must never be the new branch: the helper's pattern (from /api/info).
// Until it is known every name counts as protected, so nothing unsafe can be applied.
let protectedPattern = null;
export const setProtected = (pattern) => { protectedPattern = new RegExp(pattern); };
export const isProtected = (name) => !protectedPattern || protectedPattern.test(name);
