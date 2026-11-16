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
| `web/js/*.js` | One module per panel: `branches`, `selected`, `dryrun`, `conflicts`, `apply`, `profiles`, `history`, `jira`, `backup`; plus `state` (saved settings), `api` and `dom` helpers. |
| `tests/` | Tests for the helper: `python3 -m unittest`. |

## Usage

Start the helper and open the page it serves:

```sh
python3 main.py [--port 8765] [--repo /path/to/your/clone]
```

Then open <http://127.0.0.1:8765>. Opening `web/index.html` from disk doesn't work: the page needs the helper.

### Local clone (recommended)

Use this mode to see and merge local branches as well as `origin`'s. Choose **Settings › Source › Local clone** and enter the clone's folder in **Repository folder** (an absolute path; `~` works, and any folder inside the clone is fine).

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

- The new branch can't be a protected name: `master`, `main`, `staging`, `development`, `release/*` or `hotfix/*`. It also can't be a branch that already exists.
- The local server only listens on `127.0.0.1`. API calls must carry an `X-Branch-Merger` header and come from the server's own origin, so other pages open in your browser can't call it.
- Merges are `--no-ff` by default: every merged branch gets a merge commit. Choose **Merge strategy › Fast-forward** (under the new branch name) to fast-forward instead whenever a branch is ahead of the new branch (the others still get a merge commit). The choice goes back to `--no-ff` on every page load.
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
