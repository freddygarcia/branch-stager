// Where branches come from and where merges happen, picked in Settings > Source.
//
// Each source has the same shape:
//   id, settingField (the Settings input it needs), notReadyText, missingText, canPush
//   ready(), summary()
//   listBranches()          -> { name: { sha, ...meta } }
//   compare(baseSha, sha)   -> { ahead, behind } or { error }
//   apply({ name, base, branches, ff, push, deleteOnFail, rebuild, lease, log })
//                           rebuild: replace `name` (an environment branch) in place;
//                           lease: its tip at the last Reload, null if it did not exist
//                           -> { ok, result, pushed, where: 'remote' | 'local' | null,
//                                built: on success, the commits merged { base, heads: { name: sha } } }
//   dryRun(base, branches), conflict(tree, path): local clone only

import { state } from '../state.js';
import github from './github.js';
import local from './local.js';

export const source = () => (state.source === 'github' ? github : local);
export const ready = () => source().ready();
