import { Share } from 'react-native';
import { SITE } from '@/data/projects';
import { t } from '@/i18n/core';

// The project's web page; this is the shared link (it carries a preview card).
export const projectUrl = (slug: string) => `${SITE}explore/project/index.html?slug=${encodeURIComponent(slug)}`;

// A project as a message, short enough to read at a glance in WhatsApp:
//
//   offline teacher for village schools
//   3B Q4 · 12 nights · 400 phones
//   keep it with me?
//   https://…
export function shareProject(n: { slug: string; title: string; model: string; nights_wanted: number; phones_wanted: number }) {
  const message = [n.title.toLowerCase(), `${n.model} · ${t('project.nights', { n: n.nights_wanted })} · ${t('project.phones', { n: n.phones_wanted })}`, t('share.keep'), projectUrl(n.slug)].join('\n');
  return Share.share({ message }).catch(() => {});
}
