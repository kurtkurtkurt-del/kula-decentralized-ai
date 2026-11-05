import Storage from 'expo-sqlite/kv-store';

// The secretary's notes ("not al: …", "take a note …"): short lines kept on this phone only
// (kv 'voice.notes'), the newest KEEP.
export type Note = { at: number; text: string };
export const KEEP_NOTES = 100;
const KEY = 'voice.notes';

export function notes(): Note[] {
  try {
    const raw = Storage.getItemSync(KEY);
    const list = raw ? (JSON.parse(raw) as Note[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function addNote(text: string, at = Date.now()): Note[] {
  const next = [...notes(), { at, text }].slice(-KEEP_NOTES);
  try {
    Storage.setItemSync(KEY, JSON.stringify(next));
  } catch {}
  return next;
}

export function clearNotes() {
  try {
    Storage.removeItemSync(KEY);
  } catch {}
}

export type NotesApi = { list: () => Note[]; add: (text: string, at: number) => void; clear: () => void };
export const notesStore: NotesApi = { list: notes, add: (text, at) => void addNote(text, at), clear: clearNotes };
