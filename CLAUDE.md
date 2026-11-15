# CLAUDE.md

## Always work in a git worktree

Every change to this repository (code, docs, config) is made in a git worktree, never in the main checkout.

- Before the first edit of a task, call `EnterWorktree` with a short name for the task, e.g. `merge-profiles`. This creates `.claude/worktrees/<name>` on branch `worktree-<name>`.
- Leave the main checkout alone. Other sessions or people may have uncommitted work there.
- If the session is already in a worktree for this task, keep working there.
- To test the page from a worktree, run `python3 main.py --repo . --port <free port>`, using a port other than 8765. Each port is a separate browser origin, so the real saved state stays untouched.
