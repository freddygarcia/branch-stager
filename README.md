# Branch Merger

A small tool for building a staging branch from several feature branches. Select branches, press **Apply**: a new branch is cut from a base branch and every selected branch is merged into it, in the order listed.

Before you apply, a dry run checks each selected branch. It shows which ones merge cleanly, which are already contained in the base, and which conflict. For a conflict, you can open the conflicting lines (ours, base and theirs).

## Files

Python 3 standard library only, and plain JavaScript modules with no build step.

| Path | What it is |
| --- | --- |
| `main.py` | Starts the helper: parses the options, reads `.env`, serves on `127.0.0.1`. |
| `stager/config.py` | Constants (protected branch names, timeouts, limits) and the `.env` loader. |
| `stager/git_repo.py` | `Repo`: runs `git` against a clone; lists, resolves and checks branches. |
| `stager/merge.py` | The dry run (`git merge-tree`, in memory) and Apply (in a temporary worktree). |
| `stager/conflicts.py` | The conflict view: conflicted regions of a file from a dry-run tree. |
| `stager/jira.py` | Read-only Jira Cloud client: saved filters and JQL search. |
| `stager/server.py` | The HTTP server: request guards, the `/api/` route table, the files of `web/`. |
| `web/index.html`, `web/app.css` | The page's markup and styles. |
| `web/js/main.js` | Starts the page: Settings, Reload, and wiring every panel. |
| `web/js/sources/` | What differs between the two sources: `local.js` (the helper) and `github.js` (the GitHub API). |
| `web/js/*.js` | One module per panel: `branches`, `selected`, `dryrun`, `conflicts`, `apply`, `profiles`, `stale`, `history`, `jira`, `backup`; plus `state` (saved settings), `api` and `dom` helpers. `layout` arranges the panels for the chosen layout. |
| `tests/` | Tests for the helper: `python3 -m unittest`. |

## Usage

Start the helper and open the page it serves:

```sh
python3 main.py [--port 8765] [--repo /path/to/your/clone]
```

Then open <http://127.0.0.1:8765>. Opening `web/index.html` from disk doesn't work: the page needs the helper.

### Layouts

**Settings › Layout** picks how the page looks. Every layout has the same features; it is saved in this browser.

- **Classic**: one page, top to bottom, following the light or dark setting of your system.
- **Guided**: light, with a navy bar, and fits one window so the page doesn't scroll: each panel scrolls inside itself. The branch list and the Jira issues are two tabs of one **Pick branches** panel, next to the **Build plan**: the selection, then conflicts and the run log when there are any, with the Apply controls always at its bottom. A step bar shows where you are: pick, order and check, build. Settings and History open as drawers from the bar. In a small window the page scrolls as usual.

In Guided, Ctrl+Enter (⌘+Enter on a Mac) presses Apply, and Esc closes a drawer.

### Local clone (recommended)

Use this mode to see and merge local branches as well as `origin`'s. Choose **Settings › Source › Local clone** and enter the clone's folder in **Repository folder** (an absolute path; `~` works, and any folder inside the clone is fine).

- The folder is saved in the browser, and you can switch to another clone at any time without restarting the server. `--repo` only pre-fills the field on first use.
- Apply merges in a temporary git worktree, so your working copy, current branch and uncommitted changes are never touched.
- If a merge conflicts, it is aborted and reported, and the target branch stays exactly as it was.
- The target branch stays local unless you tick **Push to origin** next to Apply. It is only pushed if every merge succeeded, and the box is unticked on every page load.
- **Reload** runs `git fetch --prune origin` first.

### Profiles

A profile saves a merge setup: the selected branches, their order and the base branch. Profiles appear as tabs in the bar at the top of the page, so you can switch between similar merges with one click.

- **Switch**: click a tab. It replaces the current selection and base. The base is skipped if that branch no longer exists.
- **Save as…**: saves the current setup under a new name. Saving under an existing name overwrites that profile.
- **Save**: updates the active profile. A dot on its tab means the selection or base has changed since it was saved.
- **Delete**: hover a tab, click **×**, then click **Delete?** within 3 seconds.
- **Delete all**: click **Delete all**, then click it again (it now reads **Delete N?**) within 3 seconds.

Profiles are kept in this browser's localStorage, together with the other settings.

### Target branch (an environment branch)

Apply builds the **Target branch**, next to the base, for example `env/staging`. Every target is treated as an environment branch: the first Apply creates it from the base and the selected branches, and every later Apply rebuilds it in place (**Rebuild**), replacing what it had. **↻** fills in a new timestamped name (`integration/20261117-1530`, with the prefix from Settings) when you want a fresh branch instead.

- With a profile active, the target is saved into that profile as you type; the tab shows it (`QA → env/qa`). With no profile active, the page remembers the last one. A new profile takes the target shown when it is saved.
- When the target already exists the hint under it turns orange: Apply replaces that branch.
- The merges run on a detached temporary worktree. The target only moves once every merge succeeded, so a conflict leaves it exactly as it was.
- The last commit of a rebuild is an empty one that describes it: the base and every branch, with the commit each was at, as git trailers (`Branch-Merger-Base`, `Branch-Merger-Branch`, `Branch-Merger-Profile`). Anyone can see what an environment has with `git log -1 origin/env/staging`, or list its branches with `git log -1 --format='%(trailers:key=Branch-Merger-Branch,valueonly)' origin/env/staging`.
- With **Push to origin**, the push uses `--force-with-lease` against the `origin` tip seen at the last Reload. If someone pushed to it since, nothing is overwritten: the push fails and says so. Reload, then rebuild again to replace it.
- It can't be a protected name (so `env/staging`, not `staging`), the base, or one of the selected branches. In the local clone it can't be checked out in any folder while it is rebuilt.
- On GitHub, the rebuild happens on a temporary `<name>-rebuild-<time>` branch, which is deleted afterwards. The environment branch is only moved if it is still at the tip seen at the last Reload.

### What changed since the last build

Every successful Apply records, on the active profile, the exact commits it merged (base and branches). After each Reload the page compares them with the branches' current tips:

- In the Selected list, a branch gets **+4** (4 new commits since the build), **rewritten** (its history was force-pushed) or **not built** (added since). A local branch that is behind its `origin` copy gets **↓3 origin**: a rebuild merges the local copy, so pull it first.
- A note under the list sums it up, including a base branch that moved and branches removed from the selection, or says nothing changed.
- Each profile tab shows **↻N** when N things changed since that profile's last build (compared with its saved setup), so you can see which environments need a rebuild without opening them.

### Jira panel

The **Jira** panel under Settings lists Jira issues from a JQL query or from one of your saved filters (starred ★ ones first, then the ones you own). Each issue shows the branches whose name contains its key, as a whole token (`ODS-38` doesn't match `ODS-382`). Click that button to add those branches to the selection, or **Select all matching branches** to add the branches of every issue listed. **⌕** filters the branch list by the issue key.

To set it up, open **Settings › Jira** and fill in your Jira Cloud site (for example `https://your-site.atlassian.net`), your email and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens). They are saved in this browser's `localStorage`, like the GitHub token. **Forget Jira token** removes the token.

Jira doesn't accept calls from a browser page, so the page sends these settings to `main.py` with each Jira request and the helper calls Jira. The helper only reads from Jira: it lists filters and runs searches.

If you'd rather keep the token out of the browser, leave all three fields empty and give the helper the values instead. Either copy `.env.example` to `.env` next to `main.py` and fill it in (`.env` is git-ignored), or export them in your shell:

```sh
export JIRA_URL=https://your-site.atlassian.net
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=...
python3 main.py --repo /path/to/your/clone
```

### GitHub only

Choose **Settings › Source › GitHub** and fill in the owner, the repository and a GitHub token. Merges then go through the GitHub API and only remote branches are listed.

Use a fine-grained token scoped to that one repository with **Contents: Read and write**. The token is stored in this browser's `localStorage` and is only sent to `api.github.com`. **Forget token** removes it.

## Rules and safety

- The target branch can't be a protected name: `master`, `main`, `staging`, `development`, `release/*` or `hotfix/*`, nor the base or a selected branch.
- The local server only listens on `127.0.0.1`. API calls must carry an `X-Branch-Merger` header and come from the server's own origin, so other pages open in your browser can't call it.
- Merges are `--no-ff` by default: every merged branch gets a merge commit. Choose **Settings › Build › Merge strategy › Fast-forward** to fast-forward instead whenever a branch is ahead of the target (the others still get a merge commit). The choice is saved with the other settings.
- Merges run with `--no-verify`, so local git hooks don't run on the merge commits. This matches merges made through the GitHub API.
- Settings, the current selection and the history of applies are saved in the browser's `localStorage`.

## Backup and moving to another browser

`localStorage` belongs to one browser and one origin, so `http://127.0.0.1:8765` and every other port each keep their own data. (Data saved while the page was still opened from disk, `file://`, stays there: open that older `branch-merger.html` once and export it.) To carry it over, open **Settings › Backup**, at the bottom of Settings:

- **Export to clipboard** copies everything this page stores (settings, the Jira site, email, JQL and filter, profiles, selection, history and the ahead/behind cache) as JSON. Tokens and secrets (the GitHub token and the Jira API token) are left out unless **Include tokens and secrets** is ticked. If the browser blocks the clipboard, the JSON is shown to copy by hand.
- **Import…** opens a box to paste that JSON into. Importing replaces everything stored in this browser, then reloads the page. When the backup has no tokens, the GitHub token already in this browser is kept, and so is the Jira API token if the backup names the same Jira site and email. Otherwise fill in the Jira token again in **Settings › Jira**. Text that isn't a backup is rejected and nothing changes.

## Requirements

- Python 3.9+ and `git` 2.38+ (the dry run uses `git merge-tree --write-tree`).
- A modern browser.

## Tests

```sh
python3 -m unittest
```

They cover the helper (git operations against a throwaway repository, the conflict view, the server's guards and routes). The page has no automated tests: try it on a spare port (see `CLAUDE.md`).
