// The review branch of god's eye: see ../types.ts for what a branch may and may not do. Dark until
// view() says built: true.
import { dark, type Branch, type BranchCtx } from '../types.js';

export function create(_ctx: BranchCtx): Branch {
  return {
    id: 'review',
    observe() {},
    view: () => dark(),
  };
}
