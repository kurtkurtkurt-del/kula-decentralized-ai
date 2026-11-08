import { Platform } from 'react-native';
import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

// The native module (modules/kula-llama): llama.cpp on this phone and the phone cluster.
// Absent in Expo Go, on iOS and on the web; the screens then say so and show the catalog
// without download buttons. Everything here is a thin, typed wrapper; no logic.
export type NativeInfo = { available: boolean; abi: string; fastCores: number; ramFreeMb: number; modelsDir: string; freeDiskMb: number; workerId: string; wifiIp: string | null };
export type LoadResult = { loadMs: number; localLayers: number; layers: number; ctx: number; split: { buffer: string; mb: number | null }[] };
export type DoneEvent = { id: number; tokens: number; ms: number; firstMs: number; tps: number; stopped: boolean; error: string | null };
export type DownloadEvent = { id: string; got: number; total: number; state: 'running' | 'retrying' | 'checking' | 'done' | 'error' | 'cancelled'; error: string | null };
export type PeerFound = { serviceName: string; name: string; host: string | null; port: number; id: string | null; ram: number | null; bw: number | null; kind: string; v: string | null };
export type WorkerStatus = { state: 'stopped' | 'starting' | 'running' | 'error'; error: string | null; peer: string | null; heldMb: number; ramMb: number; bandwidth: number; throttled: boolean; connects: number; rejects: number; id: string; batteryUnrestricted: boolean; fp?: string | null; pin?: string | null; paired?: number; relay?: { url: string; code: string } | null; relayError?: string | null; mode?: 'auto' | 'manual' | null; why?: string | null; pairFor?: string | null };
/**
 * `{fp, pin?}` picks protocol v2 (tls, pinned certificate); null means protocol v1 with the secret.
 * An empty fp means "learn it": a peer added by a relay code alone shows its certificate on
 * the first connection and the pin proof, which covers both certificates, vouches for it.
 */
export type PeerTls = { fp: string; pin?: string | null } | null;
/** A peer far away: the relay to go through and the worker's code there. */
export type PeerRelay = { url: string; code: string } | null;
export type PeerArg = { host: string; port: number; secret: string; weight: number; fp?: string | null; pin?: string | null };
/** A wi-fi as the phone sees it without a location permission; ssid only when it could be read. */
export type HomeNet = { subnet: string; gateway: string | null; domain: string | null; ssid: string | null };
/** A computer added by scanning its chat page's QR: waiting = its one-time code is still open. */
export type HostEntry = { id: string; name: string; fp: string; paired: number | null; waiting: boolean; exp: number | null };
/** Why the auto worker runs or not (Auto.decide in Auto.kt). */
export type AutoDecision = 'start' | 'off' | 'nohome' | 'paused' | 'away' | 'unplugged';
/** "let my computers use this phone" (Keeper.kt): the switch, the home wi-fi, what is missing. */
export type AutoStatus = {
  on: boolean; onlyCharging: boolean; paused: boolean; home: HomeNet | null; now: HomeNet | null; atHome: boolean; charging: boolean;
  decision: AutoDecision; running: boolean; mode: 'auto' | 'manual' | null; why: string | null;
  batteryUnrestricted: boolean; notifications: boolean; maker: string; sdk: number; hosts: HostEntry[];
};
export type Message = { role: 'system' | 'user' | 'assistant'; content: string };

type Module = {
  abi: string;
  gatePort: number;
  info(): Promise<NativeInfo>;
  memBandwidth(threads: number): Promise<number>;
  ggufMeta(path: string): Promise<Record<string, string>>;
  sha256(path: string): Promise<string>;
  deleteFile(path: string): Promise<boolean>;
  listModels(): Promise<{ name: string; path: string; size: number; partial: boolean }[]>;
  download(id: string, url: string, name: string, sha256: string | null, size: number): Promise<void>;
  cancelDownload(id: string): Promise<void>;
  loadModel(path: string, ctx: number, threads: number, peers: PeerArg[], localWeight: number): Promise<LoadResult>;
  unload(): Promise<void>;
  isLoaded(): boolean;
  tokensUsed(): number;
  contextSize(): number;
  clearContext(): Promise<void>;
  generate(messages: Message[], maxTokens: number, temperature: number, topP: number, reset: boolean): number;
  stop(): void;
  /** null when the peer answered; otherwise the gate's reason. With `relay` the probe goes through the relay (api only), and the learned fingerprint comes back as "ok <fp>". */
  probePeer(host: string, port: number, secret: string, channel: 'rpc' | 'api', tls: PeerTls, relay?: PeerRelay): Promise<string | null>;
  apiTunnel(host: string, port: number, secret: string, tls: PeerTls, relay?: PeerRelay): Promise<number>;
  gateFingerprint(): Promise<string>;
  closeTunnels(): Promise<void>;
  discover(on: boolean): Promise<void>;
  /** `relay`: also register with that relay (wss://…) so a device far away can come in by code; implies protocol v2. */
  startWorker(port: number, secret: string, name: string, relay?: string | null): Promise<void>;
  stopWorker(): Promise<void>;
  workerStatus(): Promise<WorkerStatus>;
  gateLedger(limit: number): Promise<string[]>;
  /** beyin's ledger: the newest `limit` lines, oldest first (src/llm/audit.ts parses them). */
  auditLedger(limit: number): Promise<string[]>;
  /** Deletes the ledger and its rotated files; the worker starts a new chain. */
  clearAuditLedger(): Promise<boolean>;
  keepScreenOn(on: boolean): Promise<void>;
  /** FLAG_SECURE: the window cannot be screenshotted or recorded while a qr with a code is shown. */
  secureScreen(on: boolean): Promise<void>;
  requestBatteryUnrestricted(): Promise<boolean>;
  // "let my computers use this phone" (8.11.2026): all native, so it works with the app closed
  autoStatus(): Promise<AutoStatus>;
  /** Turning on remembers the wi-fi the phone is on as home when none is; throws 'nowifi' off wi-fi. */
  setAuto(on: boolean, onlyCharging: boolean, name: string | null): Promise<AutoStatus>;
  rememberHome(): Promise<AutoStatus>;
  /** Lifts a pause and starts the auto worker now; throws 'off' when the switch is off. */
  startAuto(): Promise<AutoStatus>;
  /** A computer's QR (k: kula-host); returns its name. Throws notHost | expired | used | nowifi. */
  addHost(qr: string): Promise<string>;
  forgetHost(fp: string): Promise<AutoStatus>;
  /** The auto worker opens no code by itself: one for a new device, for ten minutes. */
  openPairing(): Promise<void>;
  openAppSettings(): Promise<void>;
  addListener(event: 'onToken', fn: (e: { id: number; text: string }) => void): EventSubscription;
  addListener(event: 'onDone', fn: (e: DoneEvent) => void): EventSubscription;
  addListener(event: 'onDownload', fn: (e: DownloadEvent) => void): EventSubscription;
  addListener(event: 'onPeerFound', fn: (e: PeerFound) => void): EventSubscription;
  addListener(event: 'onPeerLost', fn: (e: { serviceName: string }) => void): EventSubscription;
};

export const llama: Module | null = Platform.OS === 'android' ? requireOptionalNativeModule<Module>('KulaLlama') : null;
export const hasNative = () => !!llama;
/** The module, or a thrown 'nonative' (Expo Go, iOS, web). */
export function native(): Module {
  if (!llama) throw new Error('nonative');
  return llama;
}
export const GATE_PORT = llama?.gatePort ?? 50551;
