// Keeps this computer from sleeping while it lends itself to other devices ("share this
// computer"): a sleeping worker drops out of a split in the middle of an answer. The screen
// may still turn off. A small child process does it on each system and ends by itself when
// kula-node does (it watches this pid), so a crash never leaves the computer awake for good.
//   macOS    caffeinate -i -w <pid>
//   Linux    systemd-inhibit --what=sleep:idle … sh -c 'while kill -0 <pid>; do sleep 30; done'
//   Windows  powershell: SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) while <pid> lives
import { spawn, type ChildProcess } from 'node:child_process';

export interface KeepAwake { stop(): void; how: string | null }

export function awakeCommand(platform: string = process.platform, pid: number = process.pid): { cmd: string; args: string[] } | null {
  if (platform === 'darwin') return { cmd: 'caffeinate', args: ['-i', '-w', String(pid)] };
  if (platform === 'linux') return { cmd: 'systemd-inhibit', args: ['--what=sleep:idle', '--who=kula', '--why=sharing this computer', '--mode=block', 'sh', '-c', `while kill -0 ${pid} 2>/dev/null; do sleep 30; done`] };
  if (platform === 'win32') {
    const ps = [
      "$t = Add-Type -PassThru -Name P -Namespace KulaAwake -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'",
      `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { [void]$t::SetThreadExecutionState([uint32]2147483649); Start-Sleep -Seconds 30 }`,
    ].join('; ');
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', ps] };
  }
  return null;
}

export function keepAwake(log: (s: string) => void = () => {}, start: typeof spawn = spawn): KeepAwake {
  const c = awakeCommand();
  if (!c) return { stop() {}, how: null };
  let child: ChildProcess | null = null;
  try {
    child = start(c.cmd, c.args, { stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => { log(`keep awake: ${c.cmd} did not start (${e.message}); this computer may sleep while it shares`); child = null; });
    child.on('exit', () => { child = null; });
  } catch (e) {
    log(`keep awake: ${(e as Error).message}`);
    child = null;
  }
  return { how: c.cmd, stop() { child?.kill(); child = null; } };
}
