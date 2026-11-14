# The Windows desktop app's smoke test on a GitHub Windows runner (.github/workflows/desktop-windows.yml),
# T2 of the orkestra plan of 13.11.2026 (windows-app), the twin of linux-smoke.sh:
#   1 static: the two names, sha256sums, the release list (cpu, cuda 12.4 and cudart, each with a sha256)
#   2 the installer as shipped (/S, per user): one kula.exe, its files, the uninstall key, the Start-menu link
#   3 first launch (setup downloads llama.cpp), the chat page checks, the Chromium sandbox on
#   4 llama.cpp: the picked zip, sha256, --version, the rpc server on 127.0.0.1, the firewall note, and
#     --version in a clean servercore container (the runner's Visual Studio hides a missing VC runtime)
#   4b a model: the running app loads Qwen3 0.6B Q8_0 through its own page api and answers one question;
#      every listener of kula and llama.cpp is on 127.0.0.1, llama-server has no console window
#   5 quit with the model loaded (CloseMainWindow, the user's way): nothing left, the port free; a second
#     launch on the same home; then a hard kill, measured only
#   5b nvidia: `kula-node setup` (the runner's node) in a home of its own with a fake nvidia-smi.exe (the
#      real detection, not KULA_NVIDIA=1): the cuda zip and its cudart picked and sha-checked, the runtime
#      beside llama-server, `setup --check` repairs an old layout, ggml-cuda.dll finds everything it
#      imports but the driver's nvcuda.dll. The gpu itself is not used.
#   5c a home whose path has a space, an o-umlaut and a c-cedilla (Windows user folders often look so)
#   7 the uninstaller: the exe, the key and the link go; the default home was never made
# Every wait and every program has its own timeout, cut to its step's budget: one hang never eats the job.
# Native output never passes through PowerShell into a file a program reads: curl.exe -o, bodies from files.
# usage: windows-smoke.ps1 <dir with kula-windows-x64.exe and sha256sums-windows.txt>
# prints CHECK <name> PASS|FAIL <detail> and FACT ...; exits 1 when any CHECK failed; files go to $env:SMOKE_OUT
param([Parameter(Mandatory = $true)][string]$Dir)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# the model of step 4b, as node/src/ui/catalog.ts has it (UI_CATALOG's first entry); the app fetches
# it itself from huggingface and checks the sha256
$ModelId = 'qwen3-0.6b-q8'
$ModelFile = 'Qwen3-0.6B-Q8_0.gguf'
$ModelSize = [int64]639446688
$ModelSha = '9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031'

$Repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$rp = Resolve-Path -LiteralPath $Dir -ErrorAction SilentlyContinue
if ($rp) { $Dir = $rp.Path }
$Temp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$OutDir = if ($env:SMOKE_OUT) { $env:SMOKE_OUT } else { Join-Path $Temp 'smoke' }
$null = New-Item -ItemType Directory -Force -Path $OutDir
$KHome = Join-Path $Temp 'h'                     # KULA_NODE_HOME (node/src/paths.ts)
$NvHome = Join-Path $Temp 'h-nvidia'
$DefaultHome = Join-Path $env:USERPROFILE '.kula-node'
$RelJson = Join-Path $OutDir 'rel.json'           # KULA_RELEASE_JSON (node/src/llama.ts fetchRelease), absolute
$Port = 50590                                     # the app's default (desktop/src/main.js)
$Tag = [regex]::Match((Get-Content -Raw -LiteralPath (Join-Path $Repo 'node\src\llama.ts')), "export const TAG = '(b[0-9]+)'").Groups[1].Value
$TagNum = $Tag.TrimStart('b')
$Version = (Get-Content -Raw -LiteralPath (Join-Path $Repo 'desktop\package.json') | ConvertFrom-Json).version
$NodeExe = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
$Exe = Join-Path $Dir 'kula-windows-x64.exe'
$Names = @('kula', 'llama-server', 'ggml-rpc-server', 'rpc-server')
$LoadBody = '{"model":"' + $ModelId + '","mode":"here","peers":[],"ctx":4096}'
$ChatBody = '{"messages":[{"role":"user","content":"What is the capital of France? Answer in one short sentence."}],"maxTokens":512,"temperature":0}'

# shared state of the steps (a hashtable, so every scope changes the same one)
$S = @{ Fails = 0; Done = $false; Deadline = (Get-Date).AddHours(2); App = $null; Url = $null; Inst = $null; KulaExe = $null; KN = $null; LS = $null; RPC = $null }

# release-json: the three windows names, each with a github digest or a .sha256 sidecar
$ReleaseCheckJs = @'
const fs = require('fs');
let x = null;
try { x = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch (e) { console.log('FAIL not json: ' + e.message); process.exit(0); }
const a = Array.isArray(x && x.assets) ? x.assets : [];
const why = [], got = [];
for (const n of process.argv.slice(3)) {
  const r = a.find((y) => y && y.name === n);
  if (!r) { why.push(n + ' missing'); continue; }
  const dig = /^sha256:[0-9a-f]{64}$/i.test(r.digest || '');
  const side = a.some((y) => y && y.name === n + '.sha256');
  if (!dig && !side) why.push(n + ' has no digest and no sidecar');
  else got.push(n + ' (' + (dig ? 'digest' : 'sidecar') + ', ' + r.size + ' bytes)');
}
console.log((why.length ? 'FAIL ' : 'PASS ') + a.length + ' assets; ' + (why.length ? why.join('; ') : got.join('; ')));
'@

# the fake nvidia-smi.exe: llama.ts hasNvidia runs `nvidia-smi -L` and wants exit 0
$FakeNvidiaCs = @'
class FakeNvidiaSmi {
  static int Main(string[] a) {
    System.Console.WriteLine("GPU 0: NVIDIA Fake GPU for the kula smoke test (UUID: GPU-00000000-0000-0000-0000-000000000000)");
    return 0;
  }
}
'@

# ---------- output ----------
function Say([string]$line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }
function OneLine([string]$txt) { if ($null -eq $txt) { return '' }; ($txt -replace '\s+', ' ').Trim() }
function Pass([string]$n, [string]$d) { Say "CHECK $n PASS $(OneLine $d)" }
function Fail([string]$n, [string]$d) { $S.Fails = $S.Fails + 1; Say "CHECK $n FAIL $(OneLine $d)" }
function Fact([string]$d) { Say "FACT $(OneLine $d)" }
function Verdict([string]$n, $ok, [string]$d) { if ($ok) { Pass $n $d } else { Fail $n $d } }
function Tail([string]$txt, [int]$n = 3) { OneLine ((@($txt -split "\r?\n" | Where-Object { $_.Trim() }) | Select-Object -Last $n) -join ' ') }
function Head200([string]$txt) { $o = OneLine $txt; if ($o.Length -gt 200) { $o.Substring(0, 200) } else { $o } }
function Match-Line([string]$txt, [string]$needle) { @($txt -split "\r?\n" | Where-Object { $_.Contains($needle) }) | Select-Object -First 1 }
function Hex-Code($c) { if ($null -eq $c) { 'none' } else { '{0} (0x{1:X8})' -f $c, ([int64]$c -band [int64]4294967295) } }

# seconds left for a wait: never more than the step's budget allows
function Cap([int]$sec) {
  $left = [int][Math]::Floor(($S.Deadline - (Get-Date)).TotalSeconds)
  [Math]::Max(1, [Math]::Min($sec, $left))
}

# ---------- files and programs ----------
# reads a file another process may still be writing (the app's logs); '' when there is none
function Read-Text([string]$f) {
  if (-not $f -or -not (Test-Path -LiteralPath $f)) { return '' }
  try {
    $fs = [IO.File]::Open($f, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try { $rd = [IO.StreamReader]::new($fs); return $rd.ReadToEnd() } finally { $fs.Dispose() }
  } catch { return '' }
}
function Read-Json([string]$f) {
  $txt = Read-Text $f
  if (-not $txt.Trim()) { return $null }
  try { return ($txt | ConvertFrom-Json) } catch { return $null }
}
# a saved SSE answer (lines "data: {json}"): every event that parsed, and the last data: line parsed
# ({unparsed} when it is cut off, null when there is none)
function Read-Sse([string]$f) {
  $evs = [System.Collections.ArrayList]::new()
  $last = $null
  foreach ($l in ((Read-Text $f) -split "\r?\n")) {
    if (-not $l.StartsWith('data:')) { continue }
    $last = $l.Substring(5).Trim()
    try { [void]$evs.Add(($last | ConvertFrom-Json)) } catch {}
  }
  $e = $null
  if ($null -ne $last) {
    try { $e = $last | ConvertFrom-Json } catch { $e = [pscustomobject]@{ unparsed = (Head200 $last) } }
  }
  [pscustomobject]@{ Evs = $evs.ToArray(); E = $e }
}
function Write-Body([string]$f, [string]$txt) { [IO.File]::WriteAllText($f, $txt, [Text.UTF8Encoding]::new($false)) }
function Write-Listing([string]$dirp, [string]$f) {
  $rows = @(Get-ChildItem -LiteralPath $dirp -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
      $sz = if ($_.PSIsContainer) { '<dir>' } else { "$($_.Length)" }
      '{0,12} {1}' -f $sz, $_.FullName.Substring($dirp.Length).TrimStart('\')
    })
  try { [IO.File]::WriteAllLines($f, [string[]]$rows) } catch {}
}
function Find-Under([string]$dirp, [string[]]$files) {
  if (-not $dirp -or -not (Test-Path -LiteralPath $dirp)) { return $null }
  foreach ($n in $files) {
    $hit = Get-ChildItem -LiteralPath $dirp -Recurse -File -Filter $n -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  $null
}

# Windows command-line quoting of one argument (the CRT rules)
function Quote-Arg([string]$a) {
  if ($a -ne '' -and $a -notmatch '[\s"]') { return $a }
  $sb = [System.Text.StringBuilder]::new()
  [void]$sb.Append('"')
  $bs = 0
  foreach ($ch in $a.ToCharArray()) {
    if ($ch -eq '\') { $bs++; continue }
    if ($ch -eq '"') { [void]$sb.Append('\' * ($bs * 2 + 1)); [void]$sb.Append('"'); $bs = 0; continue }
    if ($bs -gt 0) { [void]$sb.Append('\' * $bs); $bs = 0 }
    [void]$sb.Append($ch)
  }
  [void]$sb.Append('\' * ($bs * 2))
  [void]$sb.Append('"')
  $sb.ToString()
}

# starts a program in the background, stdout and stderr to two files; envs: NAME = value (null removes)
function Start-Bg([string]$file, [string[]]$argv, [string]$so, [string]$se, [hashtable]$envs, [string]$cwd) {
  $saved = @{}
  if ($envs) { foreach ($k in @($envs.Keys)) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $envs[$k]) } }
  try {
    $sp = @{ FilePath = $file; PassThru = $true; NoNewWindow = $true; RedirectStandardOutput = $so; RedirectStandardError = $se; ErrorAction = 'Stop' }
    if ($argv -and $argv.Count -gt 0) { $sp.ArgumentList = (@($argv | ForEach-Object { Quote-Arg $_ }) -join ' ') }
    if ($cwd) { $sp.WorkingDirectory = $cwd }
    $proc = Start-Process @sp
    if ($proc) { $null = $proc.Handle }        # keeps ExitCode readable after the exit
    return $proc
  } catch {
    Fact "could not start $($file): $($_.Exception.Message)"
    return $null
  } finally {
    foreach ($k in @($saved.Keys)) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
  }
}
function Kill-Tree($proc) {
  if (-not $proc) { return }
  try { $proc.Kill($true) } catch {}
  try { $null = $proc.WaitForExit(5000) } catch {}
}
# runs a program to its end within sec (cut to the step's budget); logs $OutDir\<name>.log and .err.log
function Run-Native([string]$file, [string[]]$argv, [string]$name, [int]$sec, [hashtable]$envs = $null, [string]$cwd = '') {
  $so = Join-Path $OutDir "$name.log"
  $se = Join-Path $OutDir "$name.err.log"
  $proc = Start-Bg $file $argv $so $se $envs $cwd
  if (-not $proc) { return [pscustomobject]@{ Code = $null; TimedOut = $false; Text = "could not start $file" } }
  $lim = Cap $sec
  $ended = $proc.WaitForExit($lim * 1000)
  $code = $null
  if ($ended) { $code = $proc.ExitCode } else { Kill-Tree $proc }
  [pscustomobject]@{ Code = $code; TimedOut = (-not $ended); Text = ((Read-Text $so) + "`n" + (Read-Text $se)) }
}
function Wait-For([int]$sec, [scriptblock]$cond) {
  $t0 = Get-Date
  $lim = Cap $sec
  while ($true) {
    if (& $cond) { return $true }
    if (((Get-Date) - $t0).TotalSeconds -ge $lim) { return $false }
    Start-Sleep -Seconds 1
  }
}

# ---------- network and processes ----------
function Http-Get([string]$url, [string]$file, [int]$sec = 10) {
  if (-not $file) { $file = 'NUL' }
  $code = & curl.exe -s --max-time (Cap $sec) -o $file -w '%{http_code}' $url 2>$null
  if ($null -eq $code) { return '000' }
  "$code".Trim()
}
# a POST whose body is a file, the answer (SSE) to a file; Origin as the page's own (server.ts sameOrigin)
function Http-Post([string]$url, [string]$body, [string]$file, [int]$sec, [string]$origin) {
  $ce = Join-Path $OutDir 'model-curl.log'
  $code = & curl.exe -sS -N --max-time (Cap $sec) -o $file -w '%{http_code}' -H 'content-type: application/json' -H "Origin: $origin" --data-binary "@$body" $url 2>> $ce
  $rc = $LASTEXITCODE
  [pscustomobject]@{ Code = "$code".Trim(); Rc = $rc }
}
function Listen-Addrs([int]$lport) {
  @(Get-NetTCPConnection -State Listen -LocalPort $lport -ErrorAction SilentlyContinue | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" } | Sort-Object -Unique)
}
function Listeners([int[]]$pids) {
  if (-not $pids -or $pids.Count -eq 0) { return @() }
  @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $pids -contains [int]$_.OwningProcess })
}
function Pids-Of([string[]]$procNames) { @(Get-Process -Name $procNames -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id }) }
function Proc-List { @(Get-Process -Name $Names -ErrorAction SilentlyContinue | ForEach-Object { "$($_.ProcessName)/$($_.Id)" }) }
function Proc-Name($id) { $pp = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($pp) { "$($pp.ProcessName)/$id" } else { "pid $id" } }
function Cmdline($id) { $w = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue; if ($w) { "$($w.CommandLine)" } else { '' } }
function Kula-Procs { @(Get-CimInstance Win32_Process -Filter "Name='kula.exe'" -ErrorAction SilentlyContinue) }
function Ps-Dump([string]$f) {
  $rows = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(kula|llama|ggml|rpc-server|Uninstall kula)' } | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name) $($_.CommandLine)" })
  try { [IO.File]::WriteAllLines($f, [string[]]$rows) } catch {}
}
# cleanup only after a verdict: whatever kula or llama.cpp left running
function Stop-All {
  $any = @(Get-Process -Name $Names -ErrorAction SilentlyContinue)
  if ($any.Count -gt 0) { $any | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
}
function Uninst-Keys {
  @(Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
      ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue } |
      Where-Object { "$($_.DisplayName)" -like 'kula*' })
}
function Kula-Links {
  $dirp = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  $sh = $null
  try { $sh = New-Object -ComObject WScript.Shell } catch {}
  @(Get-ChildItem -LiteralPath $dirp -Recurse -File -Filter 'kula*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
      $tg = ''
      if ($sh) { try { $tg = $sh.CreateShortcut($_.FullName).TargetPath } catch {} }
      [pscustomobject]@{ Path = $_.FullName; Target = $tg }
    })
}
function Find-Dumpbin {
  $vsw = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path -LiteralPath $vsw)) { return $null }
  $hits = @(& $vsw -latest -products '*' -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\dumpbin.exe' 2>$null)
  if ($hits.Count -gt 0) { return "$($hits[0])" }
  $null
}
# the dll names a program or library imports (dumpbin /dependents, delay-loaded ones too)
function Dll-Deps([string]$file, [string]$name) {
  $r = Run-Native $S.Dumpbin @('/nologo', '/dependents', $file) $name 60
  @([regex]::Matches($r.Text, '(?im)^\s+([A-Za-z0-9_.\-]+\.dll)\s*$') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
}

# ---------- the app ----------
function Start-App([string]$label) {
  $S.AppOut = Join-Path $OutDir "$label.log"
  $S.AppErr = Join-Path $OutDir "$label.err.log"
  $S.AppAt = Get-Date
  $S.App = Start-Bg $S.KulaExe @() $S.AppOut $S.AppErr @{ KULA_NODE_HOME = $KHome; KULA_RELEASE_JSON = $RelJson; KULA_NVIDIA = '0'; KULA_SNAP = (Join-Path $OutDir "$label.png") } $S.Inst
  if ($S.App) { Fact "$label launched: pid $($S.App.Id)" }
}
function App-Log { (Read-Text $S.AppOut) + "`n" + (Read-Text $S.AppErr) }
# the page's address from <home>\ui-prefix, when the page answers there (for an app whose log stays empty)
function Prefix-Url {
  $px = (Read-Text (Join-Path $KHome 'ui-prefix')).Trim()
  if ($px -notmatch '^[0-9a-f]{24}$') { return $null }
  $u = "http://127.0.0.1:$Port/$px/"
  if ((Http-Get "$($u)health" $null 5) -eq '200') { return $u }
  $null
}
# waits for the line main.js prints when it opens the page; stops at once on a failed setup or start,
# or when the app is gone; with an empty log after 30 s the address comes from ui-prefix
function Wait-Open([int]$sec) {
  $t0 = Get-Date
  $lim = Cap $sec
  while ($true) {
    $lg = App-Log
    $m = [regex]::Match($lg, "kula: opening (http://127\.0\.0\.1:$Port/[0-9a-f]{24}/)")
    if ($m.Success) { return [pscustomobject]@{ Url = $m.Groups[1].Value; How = 'log'; Why = '' } }
    $bad = [regex]::Match($lg, 'kula: setup exited [1-9][0-9]*|kula: start failed[^\r\n]*')
    if ($bad.Success) { return [pscustomobject]@{ Url = $null; How = ''; Why = $bad.Value } }
    if (-not $S.App -or $S.App.HasExited) {
      $xc = if ($S.App) { Hex-Code $S.App.ExitCode } else { 'none' }
      return [pscustomobject]@{ Url = $null; How = ''; Why = "the app is gone (exit $xc)" }
    }
    if (-not $lg.Trim() -and ((Get-Date) - $S.AppAt).TotalSeconds -ge 30) {
      $u = Prefix-Url
      if ($u) { return [pscustomobject]@{ Url = $u; How = 'ui-prefix'; Why = 'the app log is empty' } }
    }
    if (((Get-Date) - $t0).TotalSeconds -ge $lim) { return [pscustomobject]@{ Url = $null; How = ''; Why = "no 'kula: opening http://127.0.0.1:$Port/<24 hex>/' in $lim s" } }
    Start-Sleep -Seconds 1
  }
}

# the chat page checks of step 3, as on Linux
function Page-Checks([string]$t) {
  $url = $S.Url
  $hf = Join-Path $OutDir "$t-health.txt"
  $code = Http-Get "$($url)health" $hf 10
  $body = (Read-Text $hf).Trim()
  Verdict "$t-health" ($code -eq '200' -and $body -ceq '{"kula":"ui"}') "code $code body $body"
  $pf = Join-Path $OutDir "$t-index.html"
  $code = Http-Get $url $pf 10
  $n = [regex]::Matches((Read-Text $pf), [regex]::Escape('<script type="module" src="app.js">')).Count
  Verdict "$t-page" ($code -eq '200' -and $n -ge 1) "code $code, app.js script tag $($n)x"
  $code = Http-Get "http://127.0.0.1:$Port/" $null 10
  Verdict "$t-root-404" ($code -eq '404') "code $code"
  $lis = (Listen-Addrs $Port) -join ' '
  $lisTxt = if ($lis) { $lis } else { 'nothing' }
  Verdict "$t-listen-loopback" ($lis -eq "127.0.0.1:$Port") "listening on: $lisTxt"
  $cl = [regex]::Match((App-Log), '[^\r\n]*could not load[^\r\n]*')
  $clTxt = if ($cl.Success) { $cl.Value } else { "no 'could not load' in the log" }
  Verdict "$t-no-load-error" (-not $cl.Success) $clTxt
  # main.js prints this right after the window's loadURL resolved
  $ok = Wait-For 30 { (App-Log).Contains('kula: page loaded') }
  Verdict "$t-page-loaded" $ok "'kula: page loaded' in the log: $ok"
  # KULA_SNAP: main.js tries up to 6 times (4 s after the load, then 2 s apart, 5 s each at most)
  $png = Join-Path $OutDir "$t.png"
  $null = Wait-For 60 { (Test-Path -LiteralPath $png) -and ((Get-Item -LiteralPath $png).Length -gt 10240) }
  $size = if (Test-Path -LiteralPath $png) { (Get-Item -LiteralPath $png).Length } else { -1 }
  $snaps = (@([regex]::Matches((App-Log), 'kula: snap[^\r\n]*') | ForEach-Object { $_.Value }) -join ' ')
  $sizeTxt = if ($size -ge 0) { "$size bytes" } else { 'missing' }
  Verdict "$t-png" ($size -gt 10240) "$t.png $sizeTxt; log: $snaps"
  Ps-Dump (Join-Path $OutDir "$t-ps.txt")
  $kp = Kula-Procs
  $rend = @($kp | Where-Object { "$($_.CommandLine)" -match '--type=renderer' }).Count
  $nos = @($kp | Where-Object { "$($_.CommandLine)" -match '--no-sandbox' }).Count
  Verdict "$t-sandbox-on" ($rend -ge 1 -and $nos -eq 0) "$($kp.Count) kula processes, $rend renderer, $nos with --no-sandbox"
}

# ---------- step 1: static ----------
function Step-Static {
  $want = 'kula-windows-x64.exe sha256sums-windows.txt'
  $got = (@(Get-ChildItem -LiteralPath $Dir -ErrorAction SilentlyContinue | ForEach-Object { $_.Name } | Sort-Object) -join ' ')
  Verdict 'names' ($got -ceq $want) "got: $got; want: $want"

  $lines = @((Read-Text (Join-Path $Dir 'sha256sums-windows.txt')) -split "\r?\n" | Where-Object { $_.Trim() })
  $good = @(); $bad = @()
  foreach ($l in $lines) {
    $m = [regex]::Match($l, '^([0-9a-fA-F]{64}) [ *](.+)$')
    if (-not $m.Success) { $bad += "unreadable line: $l"; continue }
    $fn = $m.Groups[2].Value.Trim()
    $fp = Join-Path $Dir $fn
    if (-not (Test-Path -LiteralPath $fp)) { $bad += "$fn missing"; continue }
    $hsh = (Get-FileHash -LiteralPath $fp -Algorithm SHA256).Hash.ToLower()
    if ($hsh -eq $m.Groups[1].Value.ToLower()) { $good += "$($fn): OK" } else { $bad += "$($fn): got $hsh" }
  }
  if ($lines.Count -eq 0) { $bad += 'no lines in sha256sums-windows.txt' }
  Verdict 'sha256sums' ($bad.Count -eq 0) ((@($good) + @($bad)) -join ', ')

  $ex = Get-Item -LiteralPath $Exe -ErrorAction SilentlyContinue
  $exTxt = if ($ex) { "$($ex.Length) bytes" } else { 'missing' }
  Fact "installer kula-windows-x64.exe: $exTxt"
  $sig = Get-AuthenticodeSignature -LiteralPath $Exe -ErrorAction SilentlyContinue
  Fact "authenticode: $($sig.Status) $($sig.StatusMessage)"
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
  Fact "windows: $($os.Caption) $($os.Version), build $([Environment]::OSVersion.Version.Build), $([Environment]::ProcessorCount) cores, $([int]($os.TotalVisibleMemorySize / 1024)) MB memory"
  Fact "session id $((Get-Process -Id $PID).SessionId), user interactive $([Environment]::UserInteractive), pwsh $($PSVersionTable.PSVersion), node $NodeExe"
  foreach ($l in @(& where.exe tar 2>&1 | ForEach-Object { "$_" })) { Fact "where tar: $l" }
  $dk = Get-Command docker -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($dk) {
    $S.Docker = $dk.Source
    $r = Run-Native $S.Docker @('version', '--format', '{{.Server.Os}} {{.Server.Version}}') 'docker-version' 30
    Fact "docker: $($S.Docker), exit $($r.Code), server $(OneLine $r.Text)"
  } else { Fact 'docker: not on PATH' }
  foreach ($fp in @(Get-NetFirewallProfile -ErrorAction SilentlyContinue)) {
    Fact "firewall profile $($fp.Name): enabled $($fp.Enabled), inbound $($fp.DefaultInboundAction), outbound $($fp.DefaultOutboundAction)"
  }
  Fact "network categories: $(@(Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { "$($_.InterfaceAlias)=$($_.NetworkCategory)" }) -join ', ')"
  $S.Dumpbin = Find-Dumpbin
  Fact "dumpbin: $(if ($S.Dumpbin) { $S.Dumpbin } else { 'not found (vswhere)' })"

  # the release list for llama.ts, fetched with the workflow's token (the app's own call is unauthenticated)
  $hdr = @('-H', 'Accept: application/vnd.github+json', '-H', 'User-Agent: kula-smoke')
  if ($env:GH_TOKEN) { $hdr += @('-H', "Authorization: Bearer $($env:GH_TOKEN)") }
  $relErr = Join-Path $OutDir 'rel-err.txt'
  & curl.exe -sS -L --max-time (Cap 60) -o $RelJson @hdr "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$Tag" 2> $relErr
  $crc = $LASTEXITCODE
  $js = Join-Path $OutDir 'release-check.js'
  [IO.File]::WriteAllText($js, $ReleaseCheckJs)
  $want3 = @("llama-$Tag-bin-win-cpu-x64.zip", "llama-$Tag-bin-win-cuda-12.4-x64.zip", 'cudart-llama-bin-win-cuda-12.4-x64.zip')
  $v = ''
  if ($NodeExe) { $v = OneLine ((@(& $NodeExe $js $RelJson @want3 2>&1 | ForEach-Object { "$_" })) -join ' ') } else { $v = 'FAIL no node on PATH' }
  if ($v.StartsWith('PASS ')) { Pass 'release-json' "$Tag $($v.Substring(5))" }
  else { Fail 'release-json' "curl exit $crc; $v; $(OneLine (Read-Text $relErr))" }

  # the clean-windows image for step 4 comes down in the background, 10 minutes at most
  $b = [Environment]::OSVersion.Version.Build
  $S.Img = if ($b -eq 20348) { 'mcr.microsoft.com/windows/servercore:ltsc2022' } elseif ($b -ge 26100) { 'mcr.microsoft.com/windows/servercore:ltsc2025' } else { $null }
  if ($S.Docker -and $S.Img) {
    $r = Run-Native $S.Docker @('image', 'inspect', '--format', '{{.Id}}', $S.Img) 'docker-inspect' 30
    if ($r.Code -eq 0) { $S.PullDone = $true; Fact "docker image $($S.Img): already on the runner" }
    else {
      $S.PullAt = Get-Date
      $S.Pull = Start-Bg $S.Docker @('pull', $S.Img) (Join-Path $OutDir 'docker-pull.log') (Join-Path $OutDir 'docker-pull.err.log') $null ''
      Fact "docker pull $($S.Img): started in the background"
    }
  }
}

# ---------- step 2: the installer ----------
function Step-Install {
  $S.HomeBefore = Test-Path -LiteralPath $DefaultHome
  Fact "default home $DefaultHome before the install: $(if ($S.HomeBefore) { 'present' } else { 'absent' })"
  $r = Run-Native $Exe @('/S') 'win-install' 300
  $progs = Join-Path $env:LOCALAPPDATA 'Programs'
  $found = @(Get-ChildItem -LiteralPath $progs -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'kula.exe' } | Where-Object { Test-Path -LiteralPath $_ })
  if ($found.Count -eq 1) { $S.KulaExe = $found[0]; $S.Inst = Split-Path -Parent $found[0]; $S.KN = Join-Path $S.Inst 'resources\kula-node' }
  Fact "install folder: $(if ($found.Count) { $found -join ', ' } else { 'none' })"
  $keys = @(Uninst-Keys)
  $key = $keys | Where-Object { "$($_.DisplayVersion)" -eq $Version } | Select-Object -First 1
  $keyTxt = (@($keys | ForEach-Object { "$($_.DisplayName)/$($_.DisplayVersion)" }) -join ', ')
  $why = @()
  if ($r.Code -ne 0) { $why += "exit $(Hex-Code $r.Code)$(if ($r.TimedOut) { ' (timed out)' })" }
  if ($found.Count -ne 1) { $why += "$($found.Count) kula.exe under $progs" }
  if (-not $key) { $why += "no HKCU uninstall key for kula $Version (keys: $keyTxt)" }
  if ($why.Count) { Fail 'win-install' ($why -join '; ') }
  else { Pass 'win-install' "/S exit 0, $($S.KulaExe), uninstall key '$($key.DisplayName)' $($key.DisplayVersion)" }
  if ($key) { Fact "uninstall key $($key.PSChildName): UninstallString $($key.UninstallString), InstallLocation $($key.InstallLocation)" }

  if ($S.Inst) {
    $need = @('resources\kula-node\dist\bin\kula-node.js', 'resources\kula-node\node_modules\ws', 'resources\kula-node\node_modules\bonjour-service',
      'resources\kula-node\node_modules\qrcode-terminal', 'resources\kula-node\src\ui\static\index.html', 'Uninstall kula.exe',
      'resources\kula-node\vcrt\msvcp140.dll', 'resources\kula-node\vcrt\vcruntime140.dll', 'resources\kula-node\vcrt\vcruntime140_1.dll')
    $miss = @($need | Where-Object { -not (Test-Path -LiteralPath (Join-Path $S.Inst $_)) })
    $missTxt = if ($miss.Count) { "missing: $($miss -join ', ')" } else { "all $($need.Count) there: $($need -join ', ')" }
    Verdict 'win-files' ($miss.Count -eq 0) $missTxt
    $lnks = @(Kula-Links)
    $hit = @($lnks | Where-Object { $_.Target -ieq $S.KulaExe })
    $lnkTxt = if ($lnks.Count) { (@($lnks | ForEach-Object { "$($_.Path) -> $($_.Target)" }) -join '; ') } else { 'none' }
    Verdict 'win-shortcut' ($hit.Count -ge 1) "Start-menu links: $lnkTxt"
  } else {
    Fail 'win-files' 'no install folder'
    Fail 'win-shortcut' 'no install folder'
  }
  $desk = @((Join-Path $env:USERPROFILE 'Desktop\kula.lnk'), (Join-Path $env:PUBLIC 'Desktop\kula.lnk')) | Where-Object { Test-Path -LiteralPath $_ }
  Fact "desktop link: $(if ($desk) { $desk -join ', ' } else { 'none' })"

  # does /S start the app? It would hold the single-instance lock (main.js) and our launch would exit
  Start-Sleep -Seconds 5
  $kp = @(Get-Process -Name kula -ErrorAction SilentlyContinue)
  if ($kp.Count -gt 0) {
    $S.InstallerStarted = $true
    Fact "the installer started the app ($($kp.Count) kula processes): stopped, and the home it made removed"
    Stop-All
    if (-not $S.HomeBefore -and (Test-Path -LiteralPath $DefaultHome)) { Remove-Item -LiteralPath $DefaultHome -Recurse -Force -ErrorAction SilentlyContinue }
  } else { Fact 'the installer did not start the app' }
}

# ---------- step 3: first launch ----------
function Step-Launch {
  if (-not $S.KulaExe) { Fail 'win-stdout' 'not installed'; Fail 'win-opening' 'not installed'; return }
  $null = New-Item -ItemType Directory -Force -Path $KHome
  Start-App 'win'
  $want = "kula: starting, kula-node at $($S.KN)"
  $null = Wait-For 30 { ((App-Log).IndexOf($want, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or (-not $S.App) -or $S.App.HasExited }
  $lg = App-Log
  if ($lg.IndexOf($want, [StringComparison]::OrdinalIgnoreCase) -ge 0) { Pass 'win-stdout' $want }
  elseif (-not $lg.Trim()) { Fail 'win-stdout' 'the app log (stdout and stderr) is empty after 30 s: the address comes from ui-prefix' }
  else { Fail 'win-stdout' "no '$want' in 30 s; last: $(Tail $lg 5)" }

  $o = Wait-Open 300
  if ($o.Url -and $o.How -eq 'log') { Pass 'win-opening' $o.Url }
  elseif ($o.Url) { Fail 'win-opening' "no opening line ($($o.Why)); the page answers at $($o.Url) (from ui-prefix)" }
  else { Fail 'win-opening' "$($o.Why); last: $(Tail (App-Log) 5)" }
  $S.Url = $o.Url
  if ($S.App -and -not $S.App.HasExited) { Fact "main pid $($S.App.Id): $(Cmdline $S.App.Id)" }
  if ($S.Url) { Page-Checks 'win' }
}

# ---------- step 4: llama.cpp ----------
function Step-Llama {
  $lg = App-Log
  $asset = "llama-$Tag-bin-win-cpu-x64.zip"
  $setupTxt = (@([regex]::Matches($lg, '(?m)^setup: [^\r\n]*(llama-|for win)[^\r\n]*') | Select-Object -First 3 | ForEach-Object { $_.Value }) -join ' ')
  if ($lg.Contains($asset)) { Pass 'llama-asset' $asset } else { Fail 'llama-asset' "no $asset in the log; $setupTxt" }
  Verdict 'llama-sha256' ($lg.Contains('sha256 ok')) "'sha256 ok' in the log: $($lg.Contains('sha256 ok'))"
  $se = [regex]::Match($lg, 'kula: setup exited [^\r\n]*')
  Verdict 'llama-setup-exit' ($lg -match 'kula: setup exited 0\b') $(if ($se.Success) { $se.Value } else { "no 'kula: setup exited' line" })

  $lbin = Join-Path $KHome "llama-$Tag\bin"
  $S.LS = Find-Under $lbin @('llama-server.exe')
  $S.RPC = Find-Under $lbin @('ggml-rpc-server.exe', 'rpc-server.exe', 'llama-rpc-server.exe')
  Write-Listing $lbin (Join-Path $OutDir 'llama-bin-listing.txt')
  Fact "llama programs: $(if ($S.LS) { $S.LS } else { 'no llama-server.exe' }), $(if ($S.RPC) { $S.RPC } else { 'no rpc server' })"
  if ($S.LS) {
    $r = Run-Native $S.LS @('--version') 'llama-version' 30
    $line = Match-Line $r.Text $TagNum
    $lineTxt = if ($line) { $line } else { Tail $r.Text 3 }
    Verdict 'llama-version' ($r.Code -eq 0 -and $line) "exit $(Hex-Code $r.Code): $lineTxt"
  } else { Fail 'llama-version' "llama-server.exe not found under $lbin" }

  if ($S.RPC) {
    $rport = 50052
    $rerr = Join-Path $OutDir 'rpc-server.err.log'
    $proc = Start-Bg $S.RPC @('-H', '127.0.0.1', '-p', "$rport", '-c') (Join-Path $OutDir 'rpc-server.log') $rerr $null ''
    $null = Wait-For 15 { @(Listen-Addrs $rport).Count -gt 0 }
    $lis = (Listen-Addrs $rport) -join ' '
    $lisTxt = if ($lis) { $lis } else { 'nothing' }
    Verdict 'rpc-loopback' ($lis -eq "127.0.0.1:$rport") "$(Split-Path -Leaf $S.RPC) listening on: $lisTxt; $(Tail (Read-Text $rerr) 2)"
    Kill-Tree $proc
  } else { Fail 'rpc-loopback' "no rpc server under $lbin" }

  $fw = @($lg -split "\r?\n" | Where-Object { $_ -match 'firewall' })
  Fact "firewall note: $($fw.Count) lines in the app log"
  $fwTxt = if ($fw.Count) { $fw[0] } else { "no line with 'firewall' in the app log" }
  Verdict 'firewall-note' ($fw.Count -ge 1) $fwTxt

  Clean-Windows
}

# llama-server --version in a clean servercore of the runner's own build (no Visual Studio, no VC runtime
# unless the zip brings it); no docker or no image in 10 minutes: a FACT, not a FAIL
function Clean-Windows {
  if (-not $S.LS) { Fail 'llama-clean-windows' 'no llama-server.exe'; return }
  if (-not $S.Docker -or -not $S.Img) {
    Fact "llama-clean-windows: not run (docker $(if ($S.Docker) { 'here' } else { 'missing' }), image for build $([Environment]::OSVersion.Version.Build): $(if ($S.Img) { $S.Img } else { 'none' }))"
    return
  }
  if ($S.Pull -and -not $S.PullDone) {
    $left = 600 - [int]((Get-Date) - $S.PullAt).TotalSeconds
    $ended = $S.Pull.HasExited
    if (-not $ended -and $left -gt 0) { $ended = $S.Pull.WaitForExit((Cap $left) * 1000) }
    if (-not $ended) { Kill-Tree $S.Pull; Fact "llama-clean-windows: not run (docker pull $($S.Img) not done in 10 minutes)"; return }
    if ($S.Pull.ExitCode -ne 0) { Fact "llama-clean-windows: not run (docker pull exit $($S.Pull.ExitCode): $(Tail (Read-Text (Join-Path $OutDir 'docker-pull.err.log')) 2))"; return }
    $S.PullDone = $true
    Fact "docker pull $($S.Img): $([int]((Get-Date) - $S.PullAt).TotalSeconds) s"
  }
  $bd = Split-Path -Parent $S.LS
  $r = Run-Native $S.Docker @('run', '--rm', '-v', "$($bd):C:\b:ro", $S.Img, 'C:\b\llama-server.exe', '--version') 'llama-clean-windows' 300
  $line = Match-Line $r.Text $TagNum
  if ($r.Code -eq 0 -and $line) { Pass 'llama-clean-windows' "$($S.Img): exit 0, $line" }
  else {
    Fail 'llama-clean-windows' "$($S.Img): exit $(Hex-Code $r.Code)$(if ($r.TimedOut) { ' (timed out)' }); $(Tail $r.Text 3)"
    if ($S.Dumpbin) {
      $files = @($S.LS) + @(Get-ChildItem -LiteralPath $bd -File -Filter '*.dll' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
      $all = @()
      foreach ($f in $files) { $all += @(Dll-Deps $f ('dumpbin-' + [IO.Path]::GetFileNameWithoutExtension($f))) }
      $notHere = @($all | Sort-Object -Unique | Where-Object { -not (Test-Path -LiteralPath (Join-Path $bd $_)) })
      Fact "llama-clean-windows: what llama-server.exe and its dlls import from outside the folder: $($notHere -join ' ')"
    } else { Fact 'llama-clean-windows: no dumpbin for the import names' }
  }
}

# ---------- step 4b: a model, here (the app still running) ----------
function Step-Model {
  if (-not $S.Url -or -not $S.LS) { Fail 'model-load' "app not up (page $($S.Url), llama-server $($S.LS))"; return }
  $api = "$($S.Url)api"
  $origin = "http://127.0.0.1:$Port"
  Fact "model: $ModelId ($ModelFile, $ModelSize bytes) at $api, Origin $origin, home $KHome"

  # model-known: kula's catalog has it, llama.cpp is here, nothing loaded, the row has the size
  $sbf = Join-Path $OutDir 'model-status-before.txt'
  $mlf = Join-Path $OutDir 'model-models.txt'
  $c1 = Http-Get "$api/status" $sbf 10
  $c2 = Http-Get "$api/models" $mlf 10
  $st = Read-Json $sbf
  $rows = @()
  try { $rows = @((Read-Text $mlf) | ConvertFrom-Json) } catch {}
  $row = $rows | Where-Object { $_.id -eq $ModelId } | Select-Object -First 1
  $why = @()
  if (-not ((Read-Text (Join-Path $Repo 'node\src\ui\catalog.ts')).Contains($ModelSha))) { $why += "sha $ModelSha not in node/src/ui/catalog.ts" }
  if ($null -eq $st) { $why += 'status is not json' }
  else {
    if (-not ($st.llama -is [bool] -and $st.llama)) { $why += "llama $($st.llama)" }
    if ($null -ne $st.loaded) { $why += "loaded $($st.loaded.model.id)" }
  }
  if (-not $row) { $why += "no row $ModelId in $($rows.Count) rows" }
  else {
    if ([int64]$row.size -ne $ModelSize) { $why += "size $($row.size), want $ModelSize" }
    if ($row.here -ne $false) { $why += "here $($row.here), want false" }
  }
  $had = [bool]($row -and $row.here -eq $true)
  if ($why.Count) { Fail 'model-known' "$($why -join ', ') (http $c1/$c2)" }
  else { Pass 'model-known' "llama true, loaded null, row $ModelId size $($row.size) here false (http $c1/$c2)" }

  # model-load: the page's own body (node/src/ui/static/app.js, the load button)
  $lb = Join-Path $OutDir 'model-load-body.json'
  Write-Body $lb $LoadBody
  $lf = Join-Path $OutDir 'model-load.txt'
  $t0 = Get-Date
  $hp = Http-Post "$api/load" $lb $lf 540 $origin
  $secs = [int]((Get-Date) - $t0).TotalSeconds
  $e = (Read-Sse $lf).E
  if ($e -and $e.done -eq $true) {
    $l = $e.status.loaded
    $lTxt = if ($l) { "$($l.model.name) $($l.mode), ctx $($l.ctx)" } else { 'no loaded in status' }
    Pass 'model-load' "done: $lTxt"
  }
  elseif ($e -and $e.error -is [string]) { Fail 'model-load' $e.error }
  else { Fail 'model-load' "http $($hp.Code), curl exit $($hp.Rc): $(Head200 (Read-Text $lf))" }
  if ($had) { Fact "model load: $secs s (the file was already here: load only)" }
  else { Fact "model load: $secs s ($([int]($ModelSize / 1000000)) MB download + load)" }

  # model-loaded: status says it runs here, this model, nothing loading
  $saf = Join-Path $OutDir 'model-status-after.txt'
  $null = Http-Get "$api/status" $saf 10
  $sa = Read-Json $saf
  if ($null -eq $sa) { Fail 'model-loaded' 'status is not json' }
  else {
    $l = $sa.loaded
    $lTxt = if ($l) { "$($l.mode) $($l.model.id) ctx $($l.ctx)" } else { 'null' }
    $ldg = if ($null -eq $sa.loading) { 'null' } else { $sa.loading | ConvertTo-Json -Compress -Depth 5 }
    Verdict 'model-loaded' ($l -and $l.mode -eq 'here' -and $l.model.id -eq $ModelId -and $null -eq $sa.loading) "loaded $lTxt, loading $ldg"
  }

  # model-file-sha256: the file the app fetched (the first model dir, ui/engine.ts defaultModelDirs)
  $mfile = Join-Path $KHome "models\$ModelFile"
  if (Test-Path -LiteralPath $mfile) {
    $sz = (Get-Item -LiteralPath $mfile).Length
    $sum = (Get-FileHash -LiteralPath $mfile -Algorithm SHA256).Hash.ToLower()
    Verdict 'model-file-sha256' ($sz -eq $ModelSize -and $sum -eq $ModelSha) "$mfile $sz bytes sha256 $sum"
  } else { Fail 'model-file-sha256' "no $mfile" }

  # model-llama-loopback: llama-server listens on 127.0.0.1 only (node/src/api.ts: --host 127.0.0.1)
  $lpids = Pids-Of @('llama-server')
  $tcp = @(Listeners $lpids)
  $lrows = @($tcp | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" } | Sort-Object -Unique)
  $lbad = @($tcp | Where-Object { $_.LocalAddress -ne '127.0.0.1' })
  Verdict 'model-llama-loopback' ($tcp.Count -ge 1 -and $lbad.Count -eq 0) "llama-server listening on: $(if ($lrows.Count) { $lrows -join ' ' } else { 'nothing' })"
  foreach ($lp in $lpids) { Fact "llama-server $($lp): $(Cmdline $lp)" }

  # model-answer: one question, temperature 0; thinking arrives inline as <think>...</think> (node/src/api.ts)
  $cb = Join-Path $OutDir 'model-chat-body.json'
  Write-Body $cb $ChatBody
  $cf = Join-Path $OutDir 'model-chat.txt'
  $hp = Http-Post "$api/chat" $cb $cf 180 $origin
  $sse = Read-Sse $cf
  $raw = (@($sse.Evs | Where-Object { $_.t -is [string] } | ForEach-Object { $_.t }) -join '')
  $ans = [regex]::Replace([regex]::Replace($raw, '(?s)<think>.*?</think>', ''), '(?s)<think>.*$', '').Trim()
  $think = $raw.Contains('<think>')
  $e = $sse.E
  if (-not $e) { Fail 'model-answer' "http $($hp.Code), curl exit $($hp.Rc): $(Head200 (Read-Text $cf))" }
  else {
    $why = @()
    if ($e.done -ne $true) { $why += "last event $(Head200 ($e | ConvertTo-Json -Compress -Depth 5))" }
    if ($null -ne $e.PSObject.Properties['error']) { $why += "error $($e.error)" }
    if ($e.stopped -eq $true) { $why += 'stopped' }
    if (-not ([double]$e.tokens -ge 1)) { $why += "tokens $($e.tokens)" }
    if (-not ([double]$e.tps -gt 0)) { $why += "tps $($e.tps)" }
    if (-not $ans) { $why += $(if ($think) { "only thinking ($($raw.Length) chars)" } else { 'empty answer' }) }
    $said = ($ans -replace '\s+', ' ')
    if ($said.Length -gt 120) { $said = $said.Substring(0, 120) }
    if ($why.Count) { Fail 'model-answer' "$($why -join ', ')$(if ($said) { ': ' + $said })" } else { Pass 'model-answer' $said }
  }
  $paris = if ($ans -match 'paris') { 'yes' } else { 'no' }
  $thinkTxt = if ($think) { 'yes' } else { 'no' }
  Fact "model: Qwen3 0.6B Q8_0 here, $([Environment]::ProcessorCount) cores: $($e.tokens) tokens, $($e.tps) tok/s, first token $($e.firstMs) ms, $($e.ms) ms, device $($e.device), thinking $thinkTxt, says Paris $paris"

  # win-loopback-only: every TCP listener of kula.exe, llama-server and the rpc server is on 127.0.0.1
  $pids = Pids-Of $Names
  $tcp = @(Listeners $pids)
  $rows2 = @($tcp | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) $(Proc-Name $_.OwningProcess)" } | Sort-Object -Unique)
  $bad2 = @($tcp | Where-Object { $_.LocalAddress -ne '127.0.0.1' })
  Verdict 'win-loopback-only' ($tcp.Count -ge 1 -and $bad2.Count -eq 0) "tcp listeners of $($pids.Count) kula and llama processes: $(if ($rows2.Count) { $rows2 -join ', ' } else { 'none' })"
  $udp = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $pids -contains [int]$_.OwningProcess } | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) $(Proc-Name $_.OwningProcess)" } | Sort-Object -Unique)
  Fact "udp endpoints of kula and llama: $(if ($udp.Count) { $udp -join ', ' } else { 'none' })"
  $rules = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { "$($_.Program)" -match 'kula|llama|ggml' } | ForEach-Object {
      $fr = $_ | Get-NetFirewallRule -ErrorAction SilentlyContinue
      "$($fr.DisplayName) [$($fr.Direction) $($fr.Action) $($fr.Profile) enabled $($fr.Enabled)] $($_.Program)"
    })
  Fact "firewall rules naming kula, llama or ggml: $(if ($rules.Count) { $rules -join '; ' } else { 'none' })"

  # no-console-window: llama-server (a console program started by kula-node) shows no window
  $lsp = @(Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue)
  $vis = @($lsp | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })
  $hTxt = (@($lsp | ForEach-Object { "$($_.Id)=$($_.MainWindowHandle) '$($_.MainWindowTitle)'" }) -join ', ')
  Verdict 'no-console-window' ($lsp.Count -ge 1 -and $vis.Count -eq 0) "$($lsp.Count) llama-server, MainWindowHandle $hTxt"
  $dpng = Join-Path $OutDir 'desktop.png'
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $vb = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = [System.Drawing.Bitmap]::new($vb.Width, $vb.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($vb.Left, $vb.Top, 0, 0, $bmp.Size)
    $bmp.Save($dpng, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Fact "desktop.png: $($vb.Width)x$($vb.Height), $((Get-Item -LiteralPath $dpng).Length) bytes"
  } catch { Fact "desktop.png: not taken: $($_.Exception.Message)" }
}

# ---------- step 5: quit with the model loaded, a second launch, a hard kill ----------
function Step-Quit {
  $pre = Proc-List
  Fact "before quit: $(if ($pre.Count) { $pre -join ' ' } else { 'nothing' })"
  if (-not $S.App -or $S.App.HasExited -or $pre.Count -eq 0) { Fail 'win-quit' "the app is not running (before quit: $($pre.Count) processes)" }
  else {
    $mp = $S.App.Id
    $gp = Get-Process -Id $mp -ErrorAction SilentlyContinue
    $closed = $false
    try { $closed = [bool]$gp.CloseMainWindow() } catch {}
    $how = "CloseMainWindow returned $closed"
    if (-not $closed) { $tk = (@(& taskkill.exe /PID $mp 2>&1 | ForEach-Object { "$_" }) -join ' '); $how += ", then taskkill /PID $($mp): $(OneLine $tk)" }
    Fact "quit: $how"
    $t0 = Get-Date
    $okq = $false
    $mainUp = $true; $left = @(); $lis = @()
    while (((Get-Date) - $t0).TotalSeconds -lt (Cap 15)) {
      Start-Sleep -Seconds 1
      $left = Proc-List
      $mainUp = [bool](Get-Process -Id $mp -ErrorAction SilentlyContinue)
      $lis = @(Listen-Addrs $Port)
      if (-not $mainUp -and $left.Count -eq 0 -and $lis.Count -eq 0) { $okq = $true; break }
    }
    $secs = [int]((Get-Date) - $t0).TotalSeconds
    if ($okq) { Pass 'win-quit' "pid $mp gone in $secs s, port $Port free, nothing left" }
    else {
      Ps-Dump (Join-Path $OutDir 'win-quit-ps.txt')
      $mainTxt = if ($mainUp) { 'still up' } else { 'gone' }
      $lisTxt = if ($lis.Count) { $lis -join ' ' } else { 'free' }
      $leftTxt = if ($left.Count) { $left -join ' ' } else { 'none' }
      Fail 'win-quit' "after $secs s: main pid $mp $mainTxt, port $Port $lisTxt, left: $leftTxt"
    }
  }
  Fact "ui.pid after quit: $(if (Test-Path -LiteralPath (Join-Path $KHome 'ui.pid')) { 'stayed' } else { 'removed' })"
  Stop-All

  # win-second-launch: the same home, nothing downloaded again
  if (-not $S.KulaExe) { Fail 'win-second-launch' 'not installed'; return }
  Start-App 'win2'
  $o = Wait-Open 60
  $lg = App-Log
  $chk = $lg -match 'kula: setup --check exited 0\b'
  $dl = [regex]::Matches($lg, 'downloading').Count
  $code = if ($o.Url) { Http-Get "$($o.Url)health" $null 10 } else { 'none' }
  $openTxt = if ($o.Url) { "$($o.Url) (from the $($o.How))" } else { $o.Why }
  Verdict 'win-second-launch' ($chk -and $dl -eq 0 -and $o.Url -and $o.How -eq 'log' -and $code -eq '200') "setup --check exited 0: $chk, downloading lines: $dl, opening: $openTxt, health $code"

  # hard-kill leftovers (measured only): the model loaded again, Stop-Process -Force on the main pid
  if ($o.Url -and $S.App -and -not $S.App.HasExited) {
    $lb = Join-Path $OutDir 'model-load-body.json'
    Write-Body $lb $LoadBody
    $hk = Join-Path $OutDir 'hardkill-load.txt'
    $null = Http-Post "$($o.Url)api/load" $lb $hk 300 "http://127.0.0.1:$Port"
    $e = (Read-Sse $hk).E
    $loaded = [bool]($e -and $e.done -eq $true)
    $pre = Proc-List
    Stop-Process -Id $S.App.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds (Cap 15)
    $post = Proc-List
    $lis = @(Listen-Addrs $Port)
    $postTxt = if ($post.Count) { $post -join ' ' } else { 'nothing' }
    $lisTxt = if ($lis.Count) { $lis -join ' ' } else { 'free' }
    Fact "hard-kill leftovers: model loaded again $loaded; before: $($pre -join ' '); 15 s after Stop-Process -Force on the main pid: $postTxt, port $Port $lisTxt"
  } else { Fact 'hard-kill leftovers: not measured (the second launch did not open)' }
  Stop-All
}

# ---------- step 5b: nvidia, a fake nvidia-smi.exe, a home of its own ----------
# node/src/llama.ts hasNvidia: `nvidia-smi -L` exiting 0 (KULA_NVIDIA unset); assets.ts pickAsset then takes
# llama-<tag>-bin-win-cuda-12.4-x64.zip and its cudart-llama-bin-win-cuda-12.4-x64.zip companion
function Step-Nvidia {
  $all = @('nvidia-fake', 'nvidia-pick', 'nvidia-setup', 'nvidia-layout', 'nvidia-repair', 'nvidia-imports')
  $kn = if ($S.KN) { Join-Path $S.KN 'dist\bin\kula-node.js' } else { $null }
  if (-not $kn -or -not (Test-Path -LiteralPath $kn)) { foreach ($n in $all) { Fail $n 'no installed kula-node.js' }; return }
  if (-not $NodeExe) { foreach ($n in $all) { Fail $n 'no node on PATH' }; return }
  $fake = Join-Path $Temp 'fakebin'
  $fakeExe = Join-Path $fake 'nvidia-smi.exe'
  $null = New-Item -ItemType Directory -Force -Path $fake
  $envs = @{ KULA_NODE_HOME = $NvHome; KULA_RELEASE_JSON = $RelJson; KULA_NVIDIA = $null; PATH = "$fake;$($env:PATH)" }
  $csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  $fakeOk = $false
  if (Test-Path -LiteralPath $csc) {
    $src = Join-Path $fake 'nvidia-smi.cs'
    [IO.File]::WriteAllText($src, $FakeNvidiaCs)
    $rcsc = Run-Native $csc @('/nologo', "/out:$fakeExe", $src) 'nvidia-fake-csc' 120
    $saved = $env:PATH
    $env:PATH = "$fake;$saved"
    try { $first = (Get-Command nvidia-smi.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source } finally { $env:PATH = $saved }
    $rl = Run-Native $fakeExe @('-L') 'nvidia-fake' 30
    $fakeOk = ("$first" -ieq $fakeExe) -and $rl.Code -eq 0 -and $rl.Text.Contains('GPU 0')
    Verdict 'nvidia-fake' $fakeOk "csc exit $($rcsc.Code); first nvidia-smi.exe on PATH: $first; nvidia-smi -L exit $($rl.Code): $(Tail $rl.Text 1)"
  } else { Fail 'nvidia-fake' "no $csc" }
  if (-not $fakeOk) { $envs.KULA_NVIDIA = '1'; Fact 'nvidia: detection not exercised (KULA_NVIDIA=1)' }

  $null = New-Item -ItemType Directory -Force -Path $NvHome
  $r = Run-Native $NodeExe @($kn, 'setup') 'nvidia-setup' 900 $envs $S.KN
  $tx = $r.Text
  $pm = [regex]::Match($tx, "llama-$Tag-bin-win-cuda-[0-9.]+-x64\.zip")
  $pr = [regex]::Match($tx, 'cudart-llama-bin-win-cuda-[0-9.]+-x64\.zip')
  $pmTxt = if ($pm.Success) { $pm.Value } else { 'not named' }
  $prTxt = if ($pr.Success) { $pr.Value } else { 'not named' }
  Verdict 'nvidia-pick' ($pm.Success -and $pr.Success) "build $pmTxt, runtime $prTxt"
  $nok = [regex]::Matches($tx, 'sha256 ok').Count
  $ready = [regex]::Match($tx, '(?m)^ready: [^\r\n]*')
  $readyTxt = if ($ready.Success) { $ready.Value } else { 'no ready: line' }
  Verdict 'nvidia-setup' ($r.Code -eq 0 -and $nok -ge 2 -and $ready.Success) "exit $(Hex-Code $r.Code)$(if ($r.TimedOut) { ' (timed out)' }), sha256 ok x$nok, $readyTxt; last: $(Tail $tx 2)"
  $tot = [regex]::Match($tx, 'will download [0-9]+ files?, [^\r\n]*')
  Fact "nvidia first start downloads: $(if ($tot.Success) { $tot.Value } else { 'no will-download line' })"

  $nvbin = Join-Path $NvHome "llama-$Tag\bin"
  Write-Listing $nvbin (Join-Path $OutDir 'nvidia-bin-listing.txt')
  $top = @(Get-ChildItem -LiteralPath $nvbin -ErrorAction SilentlyContinue | ForEach-Object { if ($_.PSIsContainer) { "$($_.Name)\" } else { $_.Name } })
  Fact "nvidia bin after setup ($($top.Count) entries): $($top -join ' ')"
  $nls = Find-Under $nvbin @('llama-server.exe')
  if (-not $nls) { foreach ($n in @('nvidia-layout', 'nvidia-repair', 'nvidia-imports')) { Fail $n "no llama-server.exe under $nvbin" }; return }
  $nbd = Split-Path -Parent $nls
  Fact "nvidia llama-server.exe at $($nls.Substring($nvbin.Length).TrimStart('\'))"

  # nvidia-layout: after the first setup the runtime is beside llama-server, no cudart-* folder left
  $pats = @('cudart64_*.dll', 'cublas64_*.dll', 'cublasLt64_*.dll')
  $where = @(foreach ($pt in $pats) { Get-ChildItem -LiteralPath $nvbin -Recurse -File -Filter $pt -ErrorAction SilentlyContinue | ForEach-Object {
        $rel = $_.FullName.Substring($nvbin.Length).TrimStart('\')
        if ($_.DirectoryName -ieq $nbd) { "$rel (beside it)" } else { "$rel (elsewhere)" } } })
  $miss = @($pats | Where-Object { -not (Get-ChildItem -LiteralPath $nbd -File -Filter $_ -ErrorAction SilentlyContinue | Select-Object -First 1) })
  $leftd = @(Get-ChildItem -LiteralPath $nvbin -Directory -Filter 'cudart-*' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  $missTxt = if ($miss.Count) { $miss -join ' ' } else { 'none' }
  $leftTxt = if ($leftd.Count) { $leftd -join ' ' } else { 'none' }
  $whereTxt = if ($where.Count) { $where -join ', ' } else { 'no cudart64/cublas64/cublasLt64 at all' }
  Verdict 'nvidia-layout' ($miss.Count -eq 0 -and $leftd.Count -eq 0) "not beside llama-server.exe: $missTxt; cudart-* folders under bin: $leftTxt; found: $whereTxt"

  # nvidia-repair: a home whose runtime sits in a folder of its own (the first debs' layout) is fixed by
  # the `setup --check` the app runs on every start, without downloading again
  $old = Join-Path $nvbin "cudart-llama-$Tag-old"
  $null = New-Item -ItemType Directory -Force -Path $old
  $moved = 0
  foreach ($pt in $pats) {
    foreach ($f in @(Get-ChildItem -LiteralPath $nbd -File -Filter $pt -ErrorAction SilentlyContinue)) {
      try { Move-Item -LiteralPath $f.FullName -Destination $old -ErrorAction Stop; $moved++ } catch {}
    }
  }
  if ($moved -eq 0) { Fail 'nvidia-repair' 'no cuda runtime beside llama-server.exe to move back' }
  else {
    $rr = Run-Native $NodeExe @($kn, 'setup', '--check') 'nvidia-repair' 300 $envs $S.KN
    $rmiss = @($pats | Where-Object { -not (Get-ChildItem -LiteralPath $nbd -File -Filter $_ -ErrorAction SilentlyContinue | Select-Object -First 1) })
    $rline = [regex]::Match($rr.Text, '[^\r\n]*files moved beside llama-server[^\r\n]*')
    $ndl = [regex]::Matches($rr.Text, 'downloading').Count
    $rlTxt = if ($rline.Success) { $rline.Value.Trim() } else { 'no files-moved line' }
    $rmTxt = if ($rmiss.Count) { $rmiss -join ' ' } else { 'none' }
    Verdict 'nvidia-repair' ($rr.Code -eq 0 -and $rline.Success -and $rmiss.Count -eq 0 -and $ndl -eq 0) "$moved files moved back into cudart-llama-$Tag-old\; setup --check: exit $(Hex-Code $rr.Code), $rlTxt, not beside: $rmTxt, downloading lines: $ndl; last: $(Tail $rr.Text 2)"
  }

  # nvidia-imports: every dll ggml-cuda.dll imports that is not in System32 is beside it, but the driver's
  $gc = Find-Under $nvbin @('ggml-cuda.dll')
  if (-not $gc) { Fail 'nvidia-imports' "no ggml-cuda.dll under $nvbin" }
  elseif (-not $S.Dumpbin) { Fail 'nvidia-imports' 'no dumpbin.exe (vswhere found none)' }
  else {
    $deps = @(Dll-Deps $gc 'dumpbin-ggml-cuda')
    $gdir = Split-Path -Parent $gc
    $beside = @(); $sys = @(); $drv = @(); $gone = @()
    foreach ($d in $deps) {
      if ($d -ieq 'nvcuda.dll') { $drv += $d }
      elseif (Test-Path -LiteralPath (Join-Path $gdir $d)) { $beside += $d }
      elseif ($d -match '^(api|ext)-ms-' -or (Test-Path -LiteralPath (Join-Path $env:SystemRoot "System32\$d"))) { $sys += $d }
      else { $gone += $d }
    }
    $goneTxt = if ($gone.Count) { $gone -join ' ' } else { 'none' }
    Verdict 'nvidia-imports' ($deps.Count -ge 1 -and $gone.Count -eq 0) "ggml-cuda.dll imports $($deps.Count): beside it: $($beside -join ' '); System32: $($sys -join ' '); the driver's: $($drv -join ' '); missing: $goneTxt"
  }
  $rv = Run-Native $nls @('--version') 'nvidia-version' 60
  $vl = Match-Line $rv.Text $TagNum
  Fact "nvidia llama-server.exe --version: exit $(Hex-Code $rv.Code), $(if ($vl) { $vl } else { Tail $rv.Text 2 })"
}

# ---------- step 5c: a home with a space, an o-umlaut and a c-cedilla in its path ----------
function Step-OddPath {
  $odd = Join-Path $Temp ('odd h' + [char]0x00F6 + 'me ' + [char]0x00E7 + 'ay')
  Fact 'odd home: a space, an o-umlaut and a c-cedilla in its name, under the runner temp'
  $kn = if ($S.KN) { Join-Path $S.KN 'dist\bin\kula-node.js' } else { $null }
  if (-not $kn -or -not (Test-Path -LiteralPath $kn) -or -not $NodeExe) { Fail 'odd-path-setup' 'no installed kula-node.js or no node'; Fail 'odd-path-model' 'no setup'; return }
  $null = New-Item -ItemType Directory -Force -Path $odd
  $r = Run-Native $NodeExe @($kn, 'setup') 'odd-path-setup' 300 @{ KULA_NODE_HOME = $odd; KULA_RELEASE_JSON = $RelJson; KULA_NVIDIA = '0' } $S.KN
  Verdict 'odd-path-setup' ($r.Code -eq 0) "cpu setup exit $(Hex-Code $r.Code)$(if ($r.TimedOut) { ' (timed out)' }); $(Tail $r.Text 2)"

  $ols = Find-Under (Join-Path $odd "llama-$Tag\bin") @('llama-server.exe')
  $src = Join-Path $KHome "models\$ModelFile"
  if (-not $ols) { Fail 'odd-path-model' 'no llama-server.exe in the odd home'; return }
  if (-not (Test-Path -LiteralPath $src)) { Fail 'odd-path-model' "no $src (step 4b)"; return }
  $md = Join-Path $odd 'models'
  $null = New-Item -ItemType Directory -Force -Path $md
  $link = Join-Path $md $ModelFile
  try { $null = New-Item -ItemType HardLink -Path $link -Target $src -ErrorAction Stop }
  catch { Fail 'odd-path-model' "hard link: $($_.Exception.Message)"; return }
  $op = 50591
  $oerr = Join-Path $OutDir 'odd-path-llama.err.log'
  $proc = Start-Bg $ols @('--host', '127.0.0.1', '--port', "$op", '-m', $link, '-c', '2048', '--no-webui') (Join-Path $OutDir 'odd-path-llama.log') $oerr $null ''
  $t0 = Get-Date
  $code = '000'
  while (((Get-Date) - $t0).TotalSeconds -lt (Cap 180)) {
    $code = Http-Get "http://127.0.0.1:$op/health" $null 5
    if ($code -eq '200') { break }
    if (-not $proc -or $proc.HasExited) { break }
    Start-Sleep -Seconds 1
  }
  $secs = [int]((Get-Date) - $t0).TotalSeconds
  $st = if (-not $proc) { 'not started' } elseif ($proc.HasExited) { "exited $(Hex-Code $proc.ExitCode)" } else { 'running' }
  Verdict 'odd-path-model' ($code -eq '200') "/health $code after $secs s, llama-server $st; $(Tail (Read-Text $oerr) 2)"
  Kill-Tree $proc
}

# ---------- step 7: the uninstaller ----------
function Step-Uninstall {
  Stop-All
  if (-not $S.Inst) { Fail 'win-uninstall' 'not installed' }
  else {
    # it copies itself away and runs again, so the result is polled, not waited for
    $r = Run-Native (Join-Path $S.Inst 'Uninstall kula.exe') @('/S') 'win-uninstall' 60
    $null = Wait-For 60 { -not (Test-Path -LiteralPath $S.KulaExe) -and @(Uninst-Keys).Count -eq 0 -and @(Kula-Links).Count -eq 0 }
    $exeLeft = Test-Path -LiteralPath $S.KulaExe
    $keyLeft = @(Uninst-Keys).Count
    $lnkLeft = @(Kula-Links).Count
    $exeTxt = if ($exeLeft) { 'still there' } else { 'gone' }
    Verdict 'win-uninstall' (-not $exeLeft -and $keyLeft -eq 0 -and $lnkLeft -eq 0) "uninstaller exit $(Hex-Code $r.Code); kula.exe $exeTxt, uninstall keys $keyLeft, Start-menu links $lnkLeft"
    $instTxt = if (Test-Path -LiteralPath $S.Inst) { 'still there: ' + ((@(Get-ChildItem -LiteralPath $S.Inst -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) | Select-Object -First 10) -join ' ') } else { 'gone' }
    Fact "install folder after the uninstall: $instTxt"
  }
  $now = Test-Path -LiteralPath $DefaultHome
  $homeTxt = "before the install: $(if ($S.HomeBefore) { 'present' } else { 'absent' }), now: $(if ($now) { 'present' } else { 'absent' })"
  if ($S.InstallerStarted) { $homeTxt += ' (the app the installer started was stopped and its home removed)' }
  Verdict 'home-untouched' (-not $S.HomeBefore -and -not $now) "$($DefaultHome): $homeTxt"
  Fact "%APPDATA%\kula after the uninstall: $(if (Test-Path -LiteralPath (Join-Path $env:APPDATA 'kula')) { 'stays' } else { 'gone' })"
}

# one step: its budget caps every wait inside it; an exception is a FAIL of its own, then the next step
function Invoke-Step([string]$id, [string]$name, [int]$budget, [scriptblock]$body) {
  $S.Deadline = (Get-Date).AddSeconds($budget)
  $t0 = Get-Date
  Say "== step $id $name (at most $budget s)"
  try { $null = & $body }
  catch { Fail "step-$id" "threw: $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))" }
  $took = [int]((Get-Date) - $t0).TotalSeconds
  if ($took -ge $budget) { Fact "step $id took $took s: it ran into its budget of $budget s, its last waits were cut short" }
  else { Fact "step $id took $took s" }
}

Say "== kula windows smoke: version $Version, llama.cpp $Tag, files in $Dir, out $OutDir"
$rc = 1
try {
  Invoke-Step '1' 'static' 180 { Step-Static }
  Invoke-Step '2' 'install' 360 { Step-Install }
  Invoke-Step '3' 'first launch' 420 { Step-Launch }
  Invoke-Step '4' 'llama.cpp' 480 { Step-Llama }
  Invoke-Step '4b' 'model' 720 { Step-Model }
  Invoke-Step '5' 'quit' 420 { Step-Quit }
  Stop-All
  Invoke-Step '5b' 'nvidia' 1080 { Step-Nvidia }
  Stop-All
  Invoke-Step '5c' 'odd path' 360 { Step-OddPath }
  Stop-All
  Invoke-Step '7' 'uninstall' 180 { Step-Uninstall }
  $S.Done = $true
} catch {
  Fact "stopped: $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))"
} finally {
  Stop-All
  if ($S.Done) {
    Say "== $($S.Fails) failed check(s)"
    Say 'CHECK script-finished PASS'
    $rc = if ($S.Fails -gt 0) { 1 } else { 0 }
  } else {
    Say "CHECK script-finished FAIL stopped early ($($S.Fails) failed check(s) before)"
    $rc = 1
  }
  try { [IO.File]::WriteAllText((Join-Path $OutDir 'smoke-exit.txt'), "$rc") } catch {}
}
exit $rc
