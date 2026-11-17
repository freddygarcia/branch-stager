// The Selected panel: the branches to merge, in merge order (drag, or ↑/↓ on a grip).

import { renderApplyControls } from './apply.js';
import { ageTag, renderBranches } from './branches.js';
import { renderConflicts } from './conflicts.js';
import { $, el } from './dom.js';
import { dryBadge, renderDrySummary, scheduleDryRun } from './dryrun.js';
import { renderJira } from './jira.js';
import { renderProfiles } from './profiles.js';
import { source } from './sources/index.js';
import { renderStale, staleTag } from './stale.js';
import { save, session, state } from './state.js';

/** Replace the selection, save it and redraw both branch lists. */
export function setSelected(names) {
  state.selected = names;
  save();
  renderBranches();
  renderSelected();
}

/** Move the selected branch at `from` so it ends up at index `to`. */
function moveTo(from, to) {
  if (from === to || to < 0 || to >= state.selected.length) return;
  const list = [...state.selected];
  const [name] = list.splice(from, 1);
  list.splice(to, 0, name);
  state.selected = list;
  save();
  renderSelected();
}

// Drag and drop. While a row is dragged the list is not re-rendered (a dry-run result
// arriving meanwhile is shown on drop), or the drag would be lost.
let dragFrom = null;
export const dragging = () => dragFrom !== null;

function dragStart(e, i) {
  dragFrom = i;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', state.selected[i]);
  e.currentTarget.classList.add('dragging');
}

/** Drop above or below `row`, depending on which half of it the pointer is over. */
const dropAfter = (e, row) => {
  const box = row.getBoundingClientRect();
  return e.clientY > box.top + box.height / 2;
};

function dragOver(e, row) {
  if (dragFrom === null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const after = dropAfter(e, row);
  row.classList.toggle('drop-after', after);
  row.classList.toggle('drop-before', !after);
}

function drop(e, i, row) {
  if (dragFrom === null) return;
  e.preventDefault();
  const from = dragFrom;
  const target = i + (dropAfter(e, row) ? 1 : 0);
  dragFrom = null;
  // removing `from` first shifts the targets after it up by one
  moveTo(from, target > from ? target - 1 : target);
  if (from === target || from === target - 1) renderSelected();
}

function dragEnd() {
  if (dragFrom === null) return; // dropped: already re-rendered
  dragFrom = null;
  renderSelected(); // cancelled: clear the drag styles, show any dry run that arrived
}

function gripKey(e, i) {
  const delta = { ArrowUp: -1, ArrowDown: 1 }[e.key];
  if (!delta) return;
  e.preventDefault();
  moveTo(i, i + delta); // renderSelected keeps the focus on this branch's grip
}

const MAX_NAME = 48;

function row(name, i) {
  const { branches, running } = session;
  const missing = branches.length && !branches.includes(name);
  const node = el('div', {
    class: 'item',
    draggable: !running,
    title: 'Drag to change the merge order',
    ondragstart: (e) => dragStart(e, i),
    ondragover: (e) => dragOver(e, node),
    ondragleave: () => node.classList.remove('drop-before', 'drop-after'),
    ondrop: (e) => drop(e, i, node),
    ondragend: dragEnd,
  },
    el('button', {
      class: 'grip',
      dataset: { name },
      title: 'Drag to reorder, or focus and press ↑/↓',
      ariaLabel: `Move ${name} (position ${i + 1} of ${state.selected.length}) with the arrow keys`,
      disabled: running,
      onkeydown: (e) => gripKey(e, i),
    }, '⋮⋮'),
    el('span', { class: 'muted', style: 'width:20px' }, String(i + 1)),
    el('span', { style: 'flex:1;', title: name }, name.length > MAX_NAME ? `${name.slice(0, MAX_NAME)}…` : name),
    missing ? null : staleTag(name),
    missing ? null : ageTag(name),
    missing ? el('span', { class: 'tag warn', title: source().missingText }, 'missing') : dryBadge(name, i),
    el('button', { class: 'icon', title: 'Remove', onclick: () => setSelected(state.selected.filter((n) => n !== name)) }, '×'),
  );
  return node;
}

/** Redraw the selection, and everything that depends on it. */
export function renderSelected() {
  const list = $('selectedList');
  // keyboard reordering: a redraw (the move itself, or a dry run landing) keeps the focus
  // on the grip of the branch that had it
  const focused = document.activeElement?.classList.contains('grip') ? document.activeElement.dataset.name : null;
  scheduleDryRun(); // first: the badges then show "…" rather than a stale result
  list.replaceChildren(...state.selected.map(row));
  if (!state.selected.length) list.append(el('div', { class: 'empty' }, 'No branches selected.'));
  if (focused) [...list.querySelectorAll('.grip')].find((g) => g.dataset.name === focused)?.focus();

  renderDrySummary();
  renderStale(renderSelected);
  renderConflicts();
  renderApplyControls();
  renderProfiles(); // the unsaved-changes dot follows the selection and base
  renderJira(); // the issues' branch buttons follow the selection and the branch list
}

export function wireSelected() {
  $('clearSel').addEventListener('click', () => setSelected([]));
}
