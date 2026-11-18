// Keeping the selection clean: a note under the Selected list counts the branches that
// are gone, already in the base, or whose Jira issue is flagged, each with a button that
// removes them. On a profile, Save keeps the cleaned-up selection.

import { cachedCompare, loadCompares } from './aheadbehind.js';
import { $, count, el } from './dom.js';
import { issueOf, issueProblem, loadIssues } from './jira.js';
import { setSelected } from './selected.js';
import { source } from './sources/index.js';
import { session, state } from './state.js';

/** A selected branch the last Reload didn't find. */
export const isMissing = (name) => session.branches.length > 0 && !session.branches.includes(name);

/** True when every commit of `name` is already in the base. */
export function inBase(name) {
  const { shas } = session;
  const c = shas[state.base] && shas[name] && cachedCompare(shas[state.base], shas[name]);
  return Boolean(c && !c.error && c.ahead === 0);
}

/** The "in base" tag of a selected branch, for when no dry run says so. */
export const inBaseTag = (name) => (inBase(name)
  ? el('span', { class: 'tag', title: `Everything on this branch is already in ${state.base}: nothing to merge` }, 'in base')
  : null);

function group(names, text, title) {
  if (!names.length) return null;
  return el('div', { class: 'row', title },
    el('span', { style: 'flex:1' }, text),
    el('button', {
      class: 'icon',
      disabled: session.running,
      onclick: () => setSelected(state.selected.filter((n) => !names.includes(n))),
    }, `Remove ${names.length}`),
  );
}

/** The note under the Selected list, and loading the comparisons and issues it needs. */
export function renderCleanup(redraw) {
  const box = $('cleanupNote');
  const { selected } = state;
  const { shas } = session;
  const baseSha = shas[state.base];
  if (baseSha) loadCompares(selected.filter((n) => shas[n]).map((n) => [baseSha, shas[n]]), redraw);
  loadIssues(selected, redraw);

  const missing = selected.filter(isMissing);
  const contained = selected.filter((n) => !isMissing(n) && inBase(n));
  const flagged = selected.filter((n) => issueProblem(issueOf(n)));
  const groups = [
    group(missing, `${count(missing.length, 'branch is', 'branches are')} gone`,
      `${source().missingText}:\n${missing.join('\n')}`),
    group(contained, `${count(contained.length, 'branch is', 'branches are')} already in ${state.base}`,
      `Nothing left to merge:\n${contained.join('\n')}`),
    group(flagged, `${count(flagged.length, 'branch has', 'branches have')} an issue ${state.jiraExpect ? 'not in an expected status' : 'that is done'}`,
      flagged.map((n) => `${n}: ${issueProblem(issueOf(n))}`).join('\n')),
  ].filter(Boolean);
  box.hidden = !groups.length;
  box.replaceChildren(...groups);
}
