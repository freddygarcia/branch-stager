// HTTP calls: the GitHub API, and the local helper (main.py) that serves this page.

import { state } from './state.js';

/** A GitHub REST call on the configured repository: { status, data }. */
export async function gh(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.github.com/repos/${state.owner}/${state.repo}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${state.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  if (res.status !== 204) {
    try { data = await res.json(); } catch { data = null; }
  }
  return { status: res.status, data };
}

/** A call to the helper's /api, on the repository folder in Settings: { status, data }. */
export async function helper(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'X-Branch-Merger': '1',
      // header values must be ASCII: the helper decodes it
      'X-Branch-Merger-Repo': encodeURIComponent(state.localPath),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.status === 404) {
    // The page is read from disk on every request, the helper's routes only at start:
    // an endpoint added since the helper started is missing until it is restarted.
    data = { error: 'The running helper is older than this page: stop main.py (Ctrl+C) and start it again.' };
  }
  return { status: res.status, data };
}

/** helper() for a POST whose answer must be 200: the data, else throws `what failed`. */
export async function helperPost(path, body, what) {
  const { status, data } = await helper(path, { method: 'POST', body });
  if (status !== 200) throw new Error(data?.error || `${what} (${status})`);
  return data;
}
