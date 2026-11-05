import { common } from './parts/common';
import { home } from './parts/home';
import { tabs } from './parts/tabs';
import { pages } from './parts/pages';
import { staff } from './parts/staff';
import { tips } from './parts/tips';
import { coops } from './parts/coops';
import { server } from './parts/server';
import { models } from './parts/models';
import { bench } from './parts/bench';

// Every string in one table. When a key appears in two parts the later wins,
// so each part uses its own prefix (home.* · flow.* · project.* …).
export const dict = { ...common, ...home, ...tabs, ...pages, ...staff, ...tips, ...coops, ...server, ...models, ...bench } as const;

export type Key = keyof typeof dict;
type Roots<K> = K extends `${infer Base}.other` ? Base : never;
export type CountKey = Roots<Key>;
