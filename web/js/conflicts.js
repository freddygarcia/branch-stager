// The conflict view (local clone only): the conflicting lines of one selected branch,
// read on demand, file by file, from the in-memory merge tree the dry run wrote.
// Open in editor stops the real merge on those conflicts in a folder next to the clone;
// Save fix remembers the fix there (git rerere) for every later dry run and Apply.

import { $, el } from './dom.js';
import { dry, forgetDryRun, mergedBefore } from './dryrun.js';
import { layout } from './layout.js';
import { renderSelected } from './selected.js';
import { source } from './sources/index.js';
import { save, state } from './state.js';

// the selected branch whose conflicts are shown, if any
let head = null;
// the open conflict folder of `head`: { head, path }, null when there is none
let fixing = null;
// where `head`'s conflicts are fixed, open or not: { head, path, repo } from the helper
let folders = null;
const EDITOR_NAMES = { vscode: 'VS Code', cursor: 'Cursor', custom: 'your command' };

export function showConflicts(name) {
  head = name;
  $('conflictBox').dataset.key = '';
  renderConflicts();
  // Guided: to the top of the build plan, clear of the Apply controls stuck to its bottom
  $('conflictBox').scrollIntoView({ behavior: 'smooth', block: layout() === 'guided' ? 'start' : 'nearest' });
}

export function renderConflicts() {
  const box = $('conflictBox');
  if (!head || !dry.key) { box.hidden = true; return; }
  // a new dry run is on its way: keep the last view, dimmed, until it lands
  box.style.opacity = dry.pending ? '.5' : '';
  if (dry.pending) return;
  const r = dry.results[head];
  if (r?.status !== 'conflict') { head = null; box.hidden = true; return; }

  const after = mergedBefore(state.selected.indexOf(head));
  box.hidden = false;
  // unrelated redraws must not collapse what is open
  const key = JSON.stringify([head, r.tree, after]);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  if (fixing?.head !== head) fixing = null;
  say('');
  renderResolveBar();
  refreshResolve();

  $('conflictTitle').textContent = `Conflicts: ${head}`;
  $('conflictSub').replaceChildren(
    `Dry run of merging it into ${after}: nothing is written. `,
    el('span', { class: 'legend', style: 'background:var(--ours-bg)' }), `ours (${after})`,
    el('span', { class: 'legend', style: 'background:var(--base-bg)' }), 'common ancestor',
    el('span', { class: 'legend', style: 'background:var(--theirs-bg)' }), `theirs (${head})`,
  );
  const labels = { after, head };
  $('conflictFiles').replaceChildren(...r.files.map((path, n) => {
    const notes = r.notes?.[path] || [];
    const kinds = [...new Set(notes.map((m) => m.match(/^CONFLICT \(([^)]+)\)/)?.[1]).filter(Boolean))];
    const body = el('div', {}, el('div', { class: 'muted' }, 'Loading…'));
    const details = el('details', {
      ontoggle: () => { if (details.open) loadHunks(r.tree, path, body, notes, labels); },
    },
      el('summary', {}, el('code', {}, path), ...kinds.map((k) => el('span', { class: 'tag err' }, k))),
      body);
    if (n === 0) details.open = true;
    return details;
  }));
}

const MARKERS = {
  'm-ours': ({ after }) => `<<<<<<< ours: ${after}`,
  'm-base': () => '||||||| common ancestor',
  'm-sep': () => '=======',
  'm-theirs': ({ head }) => `>>>>>>> theirs: ${head}`,
};

async function loadHunks(tree, path, body, notes, labels) {
  if (body.dataset.loaded) return;
  body.dataset.loaded = '1';
  let res;
  try {
    res = await source().conflict(tree, path);
  } catch (e) {
    res = { status: 0, data: { error: e.message } };
  }
  const { status, data } = res;
  body.replaceChildren(...notes.map((m) => el('div', { class: 'note' }, m)));
  if (status !== 200) {
    body.append(el('div', { class: 'err' }, data?.error || `Could not read the conflict (${status})`));
    delete body.dataset.loaded; // try again on the next open
    return;
  }
  const say = (text) => body.append(el('div', { class: 'muted', style: 'margin-top:6px' }, text));
  if (data.missing) return say('Not in the merged result (deleted on one side): see the note above.');
  if (data.binary) return say('Binary file: no line view.');
  if (!data.hunks.length) return say('No conflict markers in the file: see the note above.');
  for (const hunk of data.hunks) {
    body.append(el('div', { class: 'hunk' }, el('div', { class: 'hunk-rows' },
      hunk.map(([n, kind, text]) => el('div', { class: `hl ${kind}` },
        el('span', { class: 'ln' }, String(n)),
        el('span', {}, MARKERS[kind] ? MARKERS[kind](labels) : text))))));
  }
  if (data.truncated) say('Truncated: the file has more conflicted lines than shown.');
}

// ---------------------------------------------------------------- Open in editor

function say(text, cls = 'muted') {
  const msg = $('resolveMsg');
  msg.hidden = !text;
  msg.className = cls;
  msg.textContent = text;
}

function renderResolveBar() {
  const open = Boolean(head) && fixing?.head === head;
  $('resolveBar').hidden = !open;
  $('resolvePath').textContent = open ? fixing.path : '';
  $('openConflict').textContent = open ? 'Open again' : 'Open in editor';
  resetDiscard();
}

/** Ask the helper whether `head` already has a conflict folder (from an earlier visit). */
async function refreshResolve() {
  const asked = head;
  const { status, data } = await source().resolve.status(asked);
  if (asked !== head) return;
  folders = status === 200 ? { head: asked, path: data.path, repo: data.repo } : null;
  fixing = status === 200 && data.open ? { head: asked, path: data.path } : null;
  renderResolveBar();
}

const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const sh = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : quote(s));
/**
 * A line of text for the reader, printed with echo. Not a `#` comment: an interactive
 * zsh runs `#` as a command (interactive_comments is off by default) and reads `(…)` as
 * a glob qualifier.
 */
const note = (s) => `echo ${quote(s)}`;

/**
 * The git commands that do what Open in editor does, to run in a terminal: the same
 * folder, the same merges (a branch before `head` that the dry run left out is left
 * out), git rerere on so the fix is saved when the merge is committed.
 */
function mergeCommands() {
  const { path, repo } = folders;
  const i = state.selected.indexOf(head);
  const rerere = '-c rerere.enabled=true -c rerere.autoUpdate=true';
  const lines = [
    `cd ${sh(repo)}`,
    `git worktree add --detach ${sh(path)} ${sh(state.base)}`,
    `cd ${sh(path)}`,
  ];
  for (const name of state.selected.slice(0, i)) {
    const r = dry.results[name];
    if (r?.status === 'conflict' || r?.status === 'error') {
      lines.push(note(`${name} left out: it conflicts too`));
    } else if (r?.fixed) {
      // a saved fix resolves it: rerere stages the fix, the commit finishes the merge
      lines.push(`git ${rerere} merge --no-ff --no-edit ${sh(name)} || git commit --no-edit`);
    } else {
      lines.push(`git merge --no-ff --no-edit ${sh(name)}`);
    }
  }
  lines.push(
    `git ${rerere} -c merge.conflictStyle=diff3 merge --no-ff --no-edit ${sh(head)}`,
    note('Next: fix the files, then save the fix (git rerere records it) and remove the folder:'),
    note('  git add -A && git commit --no-edit'),
    note(`  cd ${sh(repo)} && git worktree remove ${sh(path)}`),
  );
  return `${lines.join('\n')}\n`;
}

async function copyMergeCommands() {
  if (folders?.head !== head) await refreshResolve();
  if (folders?.head !== head) { say('Could not reach the helper to build the commands.', 'err'); return; }
  const open = fixing?.head === head;
  try {
    await navigator.clipboard.writeText(mergeCommands());
    say(open
      ? 'Commands copied. The folder is already open here: Discard it first, or skip to fixing the files.'
      : 'Commands copied: paste them in a terminal.', open ? 'warn' : 'ok');
  } catch {
    say('Could not copy to the clipboard.', 'err');
  }
}

/** Check the selection again: a saved fix turns the conflict into "✓ fix". */
function checkAgain() {
  forgetDryRun();
  renderSelected();
}

async function openInEditor() {
  const button = $('openConflict');
  const asked = head;
  button.disabled = true;
  say('Merging up to the conflicts…');
  try {
    const data = await source().resolve.open({
      base: state.base, branches: state.selected, head: asked, editor: state.editor, command: state.editorCommand,
    });
    if (asked !== head) return;
    if (!data.files.length) {
      fixing = null;
      say('No conflict left: saved fixes cover them all.', 'ok');
      checkAgain();
      return;
    }
    fixing = { head: asked, path: data.path };
    const where = `${data.file}:${data.line}`;
    const kept = data.reused ? ' Your earlier changes there are kept.' : '';
    if (data.opened) {
      say(`Opened in ${EDITOR_NAMES[state.editor]} at ${where}.${kept}`, 'ok');
    } else {
      // the editor's command line tool was not found: its URL handler opens the file
      window.location.href = data.url;
      say(`Opening ${where} in ${EDITOR_NAMES[state.editor]}.${kept} If nothing opens, open the folder below yourself.`, 'ok');
    }
  } catch (e) {
    say(e.message, 'err');
  } finally {
    button.disabled = false;
    renderResolveBar();
  }
}

async function saveFix() {
  const asked = head;
  $('saveFix').disabled = true;
  try {
    const data = await source().resolve.save(asked);
    fixing = null;
    const unsaved = data.unsaved.length
      ? ` Not remembered (deleted on one side or binary), fix these in the branch itself: ${data.unsaved.join(', ')}.`
      : '';
    say(data.committed
      ? 'The merge was committed in the editor: its fix was saved then.'
      : `Fix saved for ${data.saved.join(', ') || 'no file'}.${unsaved}`, unsaved ? 'warn' : 'ok');
    checkAgain();
  } catch (e) {
    say(e.message, 'err');
  } finally {
    $('saveFix').disabled = false;
    renderResolveBar();
  }
}

// Discard drops the user's work in that folder: it takes a second click
let discardArmed = false;
function resetDiscard() {
  discardArmed = false;
  $('discardFix').textContent = 'Discard';
}

async function discardFix() {
  if (!discardArmed) {
    discardArmed = true;
    $('discardFix').textContent = 'Discard? Click again';
    return;
  }
  try {
    await source().resolve.discard(head);
    fixing = null;
    say('Discarded.');
  } catch (e) {
    say(e.message, 'err');
  }
  renderResolveBar();
}

export function wireConflicts() {
  $('openConflict').addEventListener('click', openInEditor);
  $('copyMergeCommands').addEventListener('click', copyMergeCommands);
  $('saveFix').addEventListener('click', saveFix);
  $('discardFix').addEventListener('click', discardFix);
  $('discardFix').addEventListener('blur', resetDiscard);
  $('copyResolvePath').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(fixing?.path || '');
      say('Path copied.');
    } catch {
      say('Could not copy: select the path and copy it.', 'warn');
    }
  });
  const showCommand = () => { $('editorCommandRow').hidden = state.editor !== 'custom'; };
  $('editorPick').addEventListener('change', (e) => {
    if (e.target.name !== 'editor') return;
    state.editor = e.target.value;
    save();
    showCommand();
    if (state.editor === 'custom' && !state.editorCommand) $('editorCommand').focus();
  });
  $('editorCommand').addEventListener('input', (e) => {
    state.editorCommand = e.target.value;
    save();
  });
  if (!EDITOR_NAMES[state.editor]) state.editor = 'vscode'; // e.g. the removed "Just the folder"
  document.querySelector(`input[name="editor"][value="${state.editor}"]`).checked = true;
  $('editorCommand').value = state.editorCommand;
  showCommand();

  $('closeConflicts').addEventListener('click', () => { head = null; renderConflicts(); });
  // opening a file loads its conflicts (the toggle event), so Expand all loads them all
  const setOpen = (open) => { for (const d of $('conflictFiles').querySelectorAll('details')) d.open = open; };
  $('expandConflicts').addEventListener('click', () => setOpen(true));
  $('collapseConflicts').addEventListener('click', () => setOpen(false));
}
