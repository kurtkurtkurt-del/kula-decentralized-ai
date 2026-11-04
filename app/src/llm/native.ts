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
export type WorkerStatus = { state: 'stopped' | 'starting' | 'running' | 'error'; error: string | null; peer: string | null; heldMb: number; ramMb: number; bandwidth: number; throttled: boolean; connects: number; rejects: number; id: string; batteryUnrestricted: boolean };
export type PeerArg = { host: string; port: number; secret: string; weight: number };
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
  probePeer(host: string, port: number, secret: string, channel: 'rpc' | 'api'): Promise<string | null>;
  apiTunnel(host: string, port: number, secret: string): Promise<number>;
  closeTunnels(): Promise<void>;
  discover(on: boolean): Promise<void>;
  startWorker(port: number, secret: string, name: string): Promise<void>;
  stopWorker(): Promise<void>;
  workerStatus(): Promise<WorkerStatus>;
  gateLedger(limit: number): Promise<string[]>;
  keepScreenOn(on: boolean): Promise<void>;
  requestBatteryUnrestricted(): Promise<boolean>;
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
