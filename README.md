# Branch Merger

A small tool for building a staging branch from several feature branches. Select branches, press **Apply**: a new branch is cut from a base branch and every selected branch is merged into it, in the order listed.

Before you apply, a dry run checks each selected branch. It shows which ones merge cleanly, which are already contained in the base, and which conflict. For a conflict, you can open the conflicting lines (ours, base and theirs).

## Files

| File | What it is |
| --- | --- |
| `branch-merger.html` | The whole UI. Works on its own against the GitHub API, or with `main.py` against a local clone. |
| `main.py` | Local helper server (Python 3 standard library only). It serves the page and runs `git` against your clone. |

## Usage

### Local clone (recommended)

Use this mode to see and merge local branches as well as `origin`'s.

```sh
python3 main.py [--port 8765] [--repo /path/to/your/clone]
```

Then open <http://127.0.0.1:8765>, choose **Settings › Source › Local clone** and enter the clone's folder in **Repository folder** (an absolute path; `~` works, and any folder inside the clone is fine).

- The folder is saved in the browser, and you can switch to another clone at any time without restarting the server. `--repo` only pre-fills the field on first use.
- Apply merges in a temporary git worktree, so your working copy, current branch and uncommitted changes are never touched.
- If a merge conflicts, it is aborted and reported. By default the new branch is then deleted (see the **Settings** checkbox).
- The new branch stays local unless you tick **Push to origin** next to Apply. It is only pushed if every merge succeeded, and the box is unticked on every page load.
- **Reload** runs `git fetch --prune origin` first.

### Profiles

A profile saves a merge setup: the selected branches, their order and the base branch. Profiles appear as tabs in the bar at the top of the page, so you can switch between similar merges with one click.

- **Switch**: click a tab. It replaces the current selection and base. The base is skipped if that branch no longer exists.
- **Save as…**: saves the current setup under a new name. Saving under an existing name overwrites that profile.
- **Save**: updates the active profile. A dot on its tab means the selection or base has changed since it was saved.
- **Delete**: hover a tab, click **×**, then click **Delete?** within 3 seconds.
- **Delete all**: click **Delete all**, then click it again (it now reads **Delete N?**) within 3 seconds.

Profiles are kept in this browser's localStorage, together with the other settings.

### GitHub only

Open `branch-merger.html` directly in a browser (`file://`). In **Settings**, fill in the owner, the repository and a GitHub token. Merges then go through the GitHub API and only remote branches are listed.

Use a fine-grained token scoped to that one repository with **Contents: Read and write**. The token is stored in this browser's `localStorage` and is only sent to `api.github.com`. **Forget token** removes it.

## Rules and safety

- The new branch can't be a protected name: `master`, `main`, `staging`, `development`, `release/*` or `hotfix/*`. It also can't be a branch that already exists.
- The local server only listens on `127.0.0.1`. API calls must carry an `X-Branch-Merger` header and come from the server's own origin, so other pages open in your browser can't call it.
- Merges are `--no-ff` with `--no-verify`, so local git hooks don't run on the merge commits. This matches merges made through the GitHub API.
- Settings, the current selection and the history of applies are saved in the browser's `localStorage`.

## Backup and moving to another browser

`localStorage` belongs to one browser and one origin, so `file://`, `http://127.0.0.1:8765` and every other port each keep their own data. To carry it over, open **Settings > Backup**:

- **Export to clipboard** copies everything this page stores (settings, profiles, selection, history and the ahead/behind cache) as JSON. The GitHub token is left out unless **Include GitHub token** is ticked. If the browser blocks the clipboard, the JSON is shown to copy by hand.
- **Import…** opens a box to paste that JSON into. Importing replaces everything stored in this browser, then reloads the page. When the backup has no token, the token already in this browser is kept. Text that isn't a backup is rejected and nothing changes.

## Requirements

- Python 3.9+ and `git` 2.38+ (the dry run uses `git merge-tree --write-tree`).
- A modern browser.
