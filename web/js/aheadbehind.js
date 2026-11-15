// Ahead/behind counts of each branch against the base, shown next to its name.
//
// Cached by "<base sha>...<head sha>": a pair of commits always compares the same, so the
// cache never goes stale. It is kept across reloads and trimmed to the newest entries.

import { el } from './dom.js';
import { ready, source } from './sources/index.js';
import { PREFIX, session, state } from './state.js';

const COMPARE_KEY = `${PREFIX}compare.v1`;
const COMPARE_LIMIT = 1000;
// a branch this many commits behind the base is shown in the warning color
const FAR_BEHIND = 50;
// requests in flight at once
const WORKERS = 6;

let compares = (() => {
  try { return JSON.parse(localStorage.getItem(COMPARE_KEY) || '{}'); } catch { return {}; }
})();

export function saveCompares() {
  const keys = Object.keys(compares);
  if (keys.length > COMPARE_LIMIT) {
    compares = Object.fromEntries(keys.slice(-COMPARE_LIMIT).map((k) => [k, compares[k]]));
  }
  try { localStorage.setItem(COMPARE_KEY, JSON.stringify(compares)); } catch { /* cache only */ }
}

const compareKey = (name) => {
  const { shas } = session;
  return shas[state.base] && shas[name] ? `${shas[state.base]}...${shas[name]}` : null;
};

/** Fill `span` with the ahead/behind of `name` against the base. */
function fill(span, name) {
  span.replaceChildren();
  span.title = '';
  const key = name === state.base ? null : compareKey(name);
  if (!key) return;
  const c = compares[key];
  if (!c) {
    span.append('…');
    return;
  }
  if (c.error) {
    span.append('?');
    span.title = `Could not compare with ${state.base}: ${c.error}`;
    return;
  }
  if (c.ahead === 0) {
    span.append(el('span', { class: 'tag' }, 'in base'));
    span.title = `Everything on this branch is already in ${state.base} (${c.behind} behind)`;
    return;
  }
  span.append(
    el('span', { class: 'ahead' }, `↑${c.ahead}`), ' ',
    el('span', { class: `behind${c.behind >= FAR_BEHIND ? ' far' : ''}` }, `↓${c.behind}`),
  );
  span.title = `${c.ahead} commit(s) not in ${state.base}, ${c.behind} commit(s) of ${state.base} missing`;
}

/** A span showing the ahead/behind of `name`, filled in when it arrives. */
export function aheadBehind(name) {
  const span = el('span', { class: 'ab', dataset: { name } });
  fill(span, name);
  return span;
}

function refresh(name) {
  for (const span of document.querySelectorAll('.ab')) {
    if (span.dataset.name === name) fill(span, name);
  }
}

let run = 0;
/** Fetch the missing ahead/behind counts of `names`, a few requests at a time. */
export async function loadAheadBehind(names) {
  const thisRun = ++run;
  const queue = names.filter((n) => n !== state.base && compareKey(n) && !compares[compareKey(n)]);
  const worker = async () => {
    while (queue.length && thisRun === run && ready()) {
      const name = queue.shift();
      const key = compareKey(name);
      if (!key || compares[key]) continue;
      const [base, head] = key.split('...');
      compares[key] = await source().compare(base, head);
      refresh(name);
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));
  saveCompares();
}
