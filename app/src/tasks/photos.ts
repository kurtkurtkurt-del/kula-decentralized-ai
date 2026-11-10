import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Directory, File, Paths } from 'expo-file-system';

// A project's photos (SDK 57): taken with the camera or picked from the library
// (expo-image-picker), made small (1280 px on the long side, JPEG at 0.7, with
// expo-image-manipulator) and copied into the app's own document folder under
// tasks/<id>/, where the system does not clear them. They stay on the phone. The model
// photos are read by a vision model before a run (tasks/seen.ts, 10.11.2026). The chat's
// photos (10.11.2026) are made small the same way and kept in the cache folder chat/: the
// chat itself is not kept, so neither are they for long.

const LONG_SIDE = 1280;
export const MAX_PHOTOS = 6;
const dirOf = (taskId: string) => new Directory(Paths.document, 'tasks', taskId);

export type PickFrom = 'camera' | 'library';

export type Picked = { uri: string; width: number; height: number };
/** Asks for the permission, opens the camera or the library; the picked images (temporary uris). */
export async function pickPhotos(from: PickFrom, room: number): Promise<Picked[]> {
  if (room <= 0) return [];
  const perm = from === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error('denied');
  const r = from === 'camera'
    ? await ImagePicker.launchCameraAsync({ mediaTypes: 'images', quality: 0.8 })
    : await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images', quality: 0.8, allowsMultipleSelection: room > 1, selectionLimit: room });
  if (r.canceled) return [];
  return r.assets.slice(0, room).map((a) => ({ uri: a.uri, width: a.width, height: a.height }));
}

/** A small JPEG copy of the image in the project's folder; its file uri. */
export const keepPhoto = (taskId: string, p: Picked) => keepImage(dirOf(taskId), p);
/** A small JPEG copy of a chat photo, in the cache folder chat/; its file uri. */
export const keepChatPhoto = (p: Picked) => keepImage(new Directory(Paths.cache, 'chat'), p);

async function keepImage(dir: Directory, { uri, width, height }: Picked): Promise<string> {
  dir.create({ intermediates: true, idempotent: true });
  const ctx = ImageManipulator.manipulate(uri);
  if (width >= height) ctx.resize({ width: Math.min(LONG_SIDE, width || LONG_SIDE), height: null });
  else ctx.resize({ width: null, height: Math.min(LONG_SIDE, height || LONG_SIDE) });
  const img = await ctx.renderAsync();
  const saved = await img.saveAsync({ format: SaveFormat.JPEG, compress: 0.7 });
  const src = new File(saved.uri);
  const dest = new File(dir, `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.jpg`);
  src.copySync(dest);
  try {
    src.delete();
  } catch {}
  return dest.uri;
}

export function forgetPhoto(uri: string) {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {}
}
export function forgetPhotos(taskId: string) {
  try {
    const d = dirOf(taskId);
    if (d.exists) d.delete();
  } catch {}
}
