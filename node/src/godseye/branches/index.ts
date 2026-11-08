// The twelve branches, one file each.
import type { BranchId, BranchMaker } from '../types.js';
import { create as senses } from './senses.js';
import { create as memory } from './memory.js';
import { create as forecast } from './forecast.js';
import { create as learning } from './learning.js';
import { create as connections } from './connections.js';
import { create as planner } from './planner.js';
import { create as executor } from './executor.js';
import { create as trust } from './trust.js';
import { create as limits } from './limits.js';
import { create as models } from './models.js';
import { create as review } from './review.js';
import { create as advisor } from './advisor.js';

export const MAKERS: Record<BranchId, BranchMaker> = { senses, memory, forecast, learning, connections, planner, executor, trust, limits, models, review, advisor };
