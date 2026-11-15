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
python3 main.py --repo /path/to/your/clone [--port 8765]
```

Then open <http://127.0.0.1:8765> and choose **Settings › Source › Local clone**.

- Pass `--repo` unless `main.py` sits inside the clone. It defaults to the script's own directory.
- Apply merges in a temporary git worktree, so your working copy, current branch and uncommitted changes are never touched.
- If a merge conflicts, it is aborted and reported. By default the new branch is then deleted (see the **Settings** checkbox).
- The new branch stays local unless you tick **Push to origin** next to Apply. It is only pushed if every merge succeeded, and the box is unticked on every page load.
- **Reload** runs `git fetch --prune origin` first.

### GitHub only

Open `branch-merger.html` directly in a browser (`file://`). In **Settings**, fill in the owner, the repository and a GitHub token. Merges then go through the GitHub API and only remote branches are listed.

Use a fine-grained token scoped to that one repository with **Contents: Read and write**. The token is stored in this browser's `localStorage` and is only sent to `api.github.com`. **Forget token** removes it.

## Rules and safety

- The new branch can't be a protected name: `master`, `main`, `staging`, `development`, `release/*` or `hotfix/*`. It also can't be a branch that already exists.
- The local server only listens on `127.0.0.1`. API calls must carry an `X-Branch-Merger` header and come from the server's own origin, so other pages open in your browser can't call it.
- Merges are `--no-ff` with `--no-verify`, so local git hooks don't run on the merge commits. This matches merges made through the GitHub API.
- Settings, the current selection and the history of applies are saved in the browser's `localStorage`.

## Requirements

- Python 3.9+ and `git` 2.38+ (the dry run uses `git merge-tree --write-tree`).
- A modern browser.
