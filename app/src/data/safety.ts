import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import Constants from 'expo-constants';
import Storage from 'expo-sqlite/kv-store';
import { supabase } from '@/lib/supabase';
import { must } from '@/lib/offline';
import { SITE } from '@/data/projects';

// 14_safety.sql: what the stores require — the terms, reports, client errors — and an
// account deletion that takes the Apple link with it.

// Raise this when the terms change: everyone is asked again.
export const TERMS_VERSION = 1;
export const TERMS_URL = `${SITE}agb/`;
export const PRIVACY_URL = `${SITE}datenschutz/`;
export const UPDATE_URL = `${SITE}phone/`;

export async function minAppVersion(): Promise<string | null> {
  const { data, error } = await supabase.rpc('min_app_version');
  return error || typeof data !== 'string' ? null : data;
}
export function versionBelow(a: string, b: string): boolean {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

// A guest who met an existing email is sent to sign in; nothing is merged here (a guest
// keeps nothing worth carrying: the passport is measured again, keeps are a swipe away).
export function rememberGuest(_uid: string) {}
export async function mergeGuest(_uid: string): Promise<number> {
  return 0;
}

// Remembered per account on the phone, so an offline start does not ask again.
const accepted = (uid: string) => `terms.${uid}`;
export function termsKnown(uid: string): boolean {
  try {
    return Number(Storage.getItemSync(accepted(uid)) ?? 0) >= TERMS_VERSION;
  } catch {
    return false;
  }
}
export async function termsAccepted(uid: string): Promise<boolean | null> {
  if (termsKnown(uid)) return true;
  const { data, error } = await supabase.rpc('terms_status');
  if (error) return null;
  const row = ((data ?? []) as { version: number | null }[])[0];
  const ok = !!row && (row.version ?? 0) >= TERMS_VERSION;
  if (ok) Storage.setItemSync(accepted(uid), String(row.version));
  return ok;
}
export async function acceptTerms(uid: string) {
  await must(supabase.rpc('accept_terms', { p_version: TERMS_VERSION }));
  Storage.setItemSync(accepted(uid), String(TERMS_VERSION));
}

// A closed account is told so, with the reason. null: could not tell.
export async function accountStatus(): Promise<{ banned: boolean; reason: string | null } | null> {
  const { data, error } = await supabase.rpc('account_status');
  if (error) return null;
  const row = ((data ?? []) as { banned: boolean; reason: string | null }[])[0];
  return row ? { banned: row.banned, reason: row.reason } : null;
}

const CONFIRM_URL = `${SITE}login/`;
export async function changeEmail(email: string) {
  const { error } = await supabase.auth.updateUser({ email: email.trim() }, { emailRedirectTo: CONFIRM_URL });
  if (error) throw error;
}
export async function changePassword(password: string) {
  if (password.length < 8) throw new Error('at least 8 characters');
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}

// Which numbered SQL files never reached the live database (00_migrations.sql stamps them).
export async function missingSql(): Promise<string[] | null> {
  const { EXPECTED_SQL } = await import('@/data/expectedSql');
  const { data, error } = await supabase.rpc('migrations_applied');
  if (error) return null;
  const have = new Set(((data ?? []) as { name: string }[]).map((r) => r.name));
  return EXPECTED_SQL.filter((n) => !have.has(n));
}

// ------------------------------------------------------------------ reports
export type ReportKind = 'profile' | 'dm' | 'coop' | 'call';
export async function report(kind: ReportKind, target: string, reason: string | null) {
  await must(supabase.rpc('report', { p_kind: kind, p_target: target, p_reason: reason }));
}
export type OpenReport = { kind: ReportKind; target: string; snapshot: string | null; reports: number; reasons: string[]; first_at: string };
export async function staffReports(): Promise<OpenReport[]> {
  return ((await must(supabase.rpc('staff_reports'))) ?? []) as OpenReport[];
}
export async function settleReport(kind: ReportKind, target: string, remove: boolean) {
  await must(supabase.rpc('staff_report_settle', { p_kind: kind, p_target: target, p_remove: remove }));
}

// ------------------------------------------------------------------ client errors
let sent = 0;
export function logError(e: unknown, where: string | null, fatal = false) {
  if (sent >= 20) return;
  sent += 1;
  const err = e instanceof Error ? e : new Error(String(e));
  supabase
    .rpc('log_error', { p_message: err.message, p_stack: err.stack ?? null, p_where: where, p_platform: Platform.OS, p_version: Constants.expoConfig?.version ?? null, p_fatal: fatal })
    .then(() => {}, () => {});
}
let installed = false;
export function catchErrors() {
  if (installed) return;
  installed = true;
  const g = globalThis as unknown as { ErrorUtils?: { getGlobalHandler: () => (e: unknown, fatal?: boolean) => void; setGlobalHandler: (fn: (e: unknown, fatal?: boolean) => void) => void } };
  const eu = g.ErrorUtils;
  if (!eu) return;
  const next = eu.getGlobalHandler();
  eu.setGlobalHandler((e, fatal) => {
    logError(e, 'global', !!fatal);
    next(e, fatal);
  });
}
export type ClientError = { id: number; message: string; stack: string | null; where_: string | null; platform: string | null; version: string | null; fatal: boolean; at: string; who: string | null };
export async function adminErrors(): Promise<ClientError[]> {
  return ((await must(supabase.rpc('admin_errors', { p_limit: 200 }))) ?? []) as ClientError[];
}
export async function clearErrors() {
  await must(supabase.rpc('admin_errors_clear'));
}

// ------------------------------------------------------------------ feedback
export async function sendFeedback(subject: string, body: string, contact: string | null) {
  await must(supabase.rpc('feedback_send', { p_subject: subject, p_body: body, p_contact: contact }));
}

// ------------------------------------------------------------------ deleting the account
async function revokeApple(): Promise<boolean> {
  try {
    const credential = await AppleAuthentication.signInAsync({ requestedScopes: [] });
    if (credential.authorizationCode) {
      const { error } = await supabase.functions.invoke('apple-revoke', { body: { code: credential.authorizationCode } });
      if (error) logError(error, 'apple-revoke');
    }
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_REQUEST_CANCELED') return false;
    logError(e, 'apple-revoke');
    return true;
  }
}
// true: deleted · false: cancelled at Apple's sheet
export async function deleteEverything(): Promise<boolean> {
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) throw new Error('sign in first');
  const apple = Platform.OS === 'ios' && (user.identities ?? []).some((i) => i.provider === 'apple');
  if (apple && !(await revokeApple())) return false;
  await must(supabase.rpc('delete_account'));
  return true;
}

// ------------------------------------------------------------- account security
export async function resendConfirmation(email: string) {
  const { error } = await supabase.auth.resend({ type: 'signup', email: email.trim(), options: { emailRedirectTo: CONFIRM_URL } });
  if (error) throw error;
}
export async function hasPassword(): Promise<boolean> {
  const { data } = await supabase.auth.getUser();
  return (data.user?.identities ?? []).some((i) => i.provider === 'email');
}
export async function reauth(password: string) {
  const { data } = await supabase.auth.getUser();
  const email = data.user?.email;
  if (!email) throw new Error('sign in first');
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error('wrong password');
}
