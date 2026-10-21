import { supabase } from '@/lib/supabase';
import { isOnline, onBackOnline } from '@/lib/offline';
import { prefetchImages } from '@/lib/images';
import { loadProfile } from '@/data/profile';
import { friendsLive, myCards } from '@/data/contribution';
import { friendsKept, friendsList, kept } from '@/data/friends';
import { callInbox, callMine } from '@/data/calls';
import { fetchDeck } from '@/data/deck';
import { networkNodes } from '@/data/network';
import { passportsMine } from '@/data/passport';

// Warm-up: when the app starts with an account and when the connection returns, the
// pages people open most are read in the background, so their shelves are full before
// the page is opened (it then shows at once, and offline too). At most once every two minutes.
let last = 0;
async function warm() {
  if (!isOnline() || Date.now() - last < 120_000) return;
  last = Date.now();
  const [deck, cards, theirs] = await Promise.allSettled([fetchDeck(null, 40), myCards(), friendsKept(), loadProfile(), kept(), friendsList(), friendsLive(), callInbox(), callMine(), networkNodes(), passportsMine()]);
  const urls: (string | null)[] = [];
  if (deck.status === 'fulfilled') urls.push(...deck.value.slice(0, 12).map((n) => n.image_url));
  if (cards.status === 'fulfilled') urls.push(...cards.value.map((c) => c.image_url));
  if (theirs.status === 'fulfilled') void theirs;
  prefetchImages(urls);
}
let started = false;
export function startWarm() {
  if (started) return;
  started = true;
  supabase.auth.onAuthStateChange((event, session) => {
    if (session?.user && !session.user.is_anonymous && (event === 'INITIAL_SESSION' || event === 'SIGNED_IN')) setTimeout(() => warm().catch(() => {}), 1500);
  });
  onBackOnline(() => {
    last = 0;
    warm().catch(() => {});
  });
}
