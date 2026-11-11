// god's eye: see types.ts. What another program needs: the snapshot shape, the eye, its view.
// This is the computer's entry (files, node:crypto, the black box: node.ts); the phone's is core.ts.
export * from './types.js';
export { cleanCard, cleanAction, type EyeView, type EyeBranchView, type EyeCard } from './eye.js';
export { NodeGodsEye as GodsEye, type NodeEyeOptions as EyeOptions, fileNotes, nodeKeys, nodeKey } from './node.js';
export { memoryNotes, type EyeNotes, type EyeKey, type EyeKeys } from './platform.js';
