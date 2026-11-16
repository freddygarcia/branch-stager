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
  deleteOnFail: true,
  history: [],
  // saved merges, switched between with Load: [{ name, base, branches, at }]
  profiles: [],
  activeProfile: '',
  jiraUrl: '',
  jiraEmail: '',
  jiraToken: '',
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

/** Branches shown with a checkbox: origin/x is hidden when a local x exists. */
export const listed = () => session.branches.filter((n) => !session.meta[n]?.shadowed);

// Branches that must never be the new branch: the helper's pattern (from /api/info).
// Until it is known every name counts as protected, so nothing unsafe can be applied.
let protectedPattern = null;
export const setProtected = (pattern) => { protectedPattern = new RegExp(pattern); };
export const isProtected = (name) => !protectedPattern || protectedPattern.test(name);
