// Every module that registers outbox jobs (lib/offline.ts outbox()), loaded once at
// start so waiting jobs can go out before the screen that made them is opened again.
import '@/data/contribution';
import '@/data/calls';
import '@/data/dms';
import '@/data/friends';
import '@/data/passport';
import '@/data/settings';
