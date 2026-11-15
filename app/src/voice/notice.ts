import type { Key } from '@/i18n/dict';
import type { Banner } from '@/voice/useTalk';

// The talk screen's notices (pure): what stands between the user and talking, or a secretary's
// tool, as an i18n key, and its one or two ways out. The screen (app/talk.tsx) runs them.
export type NoticeGo = 'allowMic' | 'openSettings' | 'online' | 'download' | 'retry' | 'openAccess' | 'settings';

/** What stands between the user and talking (or a secretary's tool), with its one or two ways out. */
export function noticeOf(kind: Banner): { text: Key; actions: { label: Key; go: NoticeGo }[] } {
  switch (kind) {
    case 'permission':
      return { text: 'voice.banner.permission', actions: [{ label: 'voice.banner.allow', go: 'allowMic' }] };
    case 'blocked':
      return { text: 'voice.banner.blocked', actions: [{ label: 'voice.banner.openSettings', go: 'openSettings' }] };
    case 'unavailable':
      return { text: 'voice.banner.unavailable', actions: [{ label: 'voice.banner.retry', go: 'retry' }] };
    case 'noOnDevice':
      return { text: 'voice.banner.noOnDevice', actions: [{ label: 'voice.banner.useOnline', go: 'online' }] };
    case 'noModel':
      return { text: 'voice.banner.noModel', actions: [{ label: 'voice.banner.download', go: 'download' }, { label: 'voice.banner.useOnline', go: 'online' }] };
    case 'downloading':
      return { text: 'voice.banner.downloading', actions: [{ label: 'voice.banner.retry', go: 'retry' }] };
    case 'downloadFailed':
      return { text: 'voice.banner.downloadFailed', actions: [{ label: 'voice.banner.retry', go: 'retry' }, { label: 'voice.banner.useOnline', go: 'online' }] };
    case 'notificationAccess':
      return { text: 'voice.banner.notificationAccess', actions: [{ label: 'voice.banner.openAccess', go: 'openAccess' }, { label: 'voice.settings', go: 'settings' }] };
    case 'calendarPermission':
      return { text: 'voice.banner.calendarPermission', actions: [{ label: 'voice.banner.openSettings', go: 'openSettings' }] };
  }
}
