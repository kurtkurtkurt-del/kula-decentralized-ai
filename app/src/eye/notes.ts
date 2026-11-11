import Storage from 'expo-sqlite/kv-store';
import type { EyeNotes } from '@godseye/core';

// The branches' notes on the phone (11.11.2026): one kv-store entry per branch, eye.notes.<id>,
// the json the branch saved, written whole. The computer keeps the same json as files
// (node/src/godseye/node.ts); the branches never know which. Nothing here leaves the phone.
export const NOTES_PREFIX = 'eye.notes.';

export const kvNotes: EyeNotes = {
  read: (id) => {
    try {
      return Storage.getItemSync(NOTES_PREFIX + id);
    } catch {
      return null;
    }
  },
  // a write that fails throws: the eye logs it and the branch carries on with what it has
  write: (id, text) => Storage.setItemSync(NOTES_PREFIX + id, text),
  remove: (id) => {
    try {
      if (Storage.getItemSync(NOTES_PREFIX + id) === null) return 0;
      Storage.removeItemSync(NOTES_PREFIX + id);
      return 1;
    } catch {
      return 0;
    }
  },
};
