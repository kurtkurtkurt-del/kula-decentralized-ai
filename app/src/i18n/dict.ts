import { common } from './parts/common';
import { home } from './parts/home';
import { tabs } from './parts/tabs';
import { pages } from './parts/pages';
import { staff } from './parts/staff';
import { tips } from './parts/tips';
import { coops } from './parts/coops';
import { server } from './parts/server';
import { models } from './parts/models';
import { audit } from './parts/audit';
import { ux } from './parts/ux';
import { brain } from './parts/brain';
import { bench } from './parts/bench';
import { voice } from './parts/voice';
import { tasks } from './parts/tasks';
import { modelsui } from './parts/modelsui';
import { social } from './parts/social';
import { passportui } from './parts/passportui';
import { power } from './parts/power';

// Every string in one table. When a key appears in two parts the later wins,
// so each part uses its own prefix (home.* · brain.* · project.* …).
export const dict = { ...common, ...home, ...tabs, ...pages, ...staff, ...tips, ...coops, ...server, ...models, ...audit, ...ux, ...brain, ...bench, ...voice, ...tasks, ...modelsui, ...social, ...passportui, ...power } as const;

export type Key = keyof typeof dict;
type Roots<K> = K extends `${infer Base}.other` ? Base : never;
export type CountKey = Roots<Key>;
