# kula-node installer for Windows (PowerShell 5.1 or 7).
#
#   irm https://github.com/kurtkurtkurt-del/kula-decentralized-ai/releases/latest/download/install.ps1 | iex
#
# Downloads kula-node-win-x64.exe from the GitHub release, checks it against
# the release's sha256sums.txt, puts it in %LOCALAPPDATA%\Programs\kula-node
# as kula-node.exe and adds that folder to your user PATH. No admin rights.
# Nothing is installed when the sha256 does not match.
#
# Environment (all optional):
#   KULA_NODE_VERSION      e.g. 0.1.0 (default: the latest release)
#   KULA_NODE_INSTALL_DIR  where kula-node.exe goes
#   KULA_NODE_BASE_URL     where the release files are (default: the GitHub release);
#                          plain http only for 127.0.0.1 / localhost
#   KULA_NODE_NO_PATH=1    do not touch the user PATH
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with its progress bar on 5.1

$repo = 'kurtkurtkurt-del/kula-decentralized-ai'
$version = if ($env:KULA_NODE_VERSION) { $env:KULA_NODE_VERSION.TrimStart('v') } else { 'latest' }
$dir = if ($env:KULA_NODE_INSTALL_DIR) { $env:KULA_NODE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\kula-node' }
if ($env:KULA_NODE_BASE_URL) { $base = $env:KULA_NODE_BASE_URL.TrimEnd('/') }
elseif ($version -eq 'latest') { $base = "https://github.com/$repo/releases/latest/download" }
else { $base = "https://github.com/$repo/releases/download/v$version" }
if ($base -notmatch '^https://' -and $base -notmatch '^http://(127\.0\.0\.1|localhost)([:/]|$)') {
  throw "kula-node install: refusing $base (only https, or http on this computer for tests)"
}

function Say($s) { Write-Host "kula-node install: $s" }

# Windows PowerShell 5.1 may still default to TLS 1.0; GitHub needs 1.2
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$arch = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
if ($arch -eq 'ARM64') { Say 'windows on arm: installing the x64 build, which windows 11 runs under emulation' }
elseif ($arch -ne 'AMD64') { throw "kula-node install: no kula-node build for $arch" }
$asset = 'kula-node-win-x64.exe'

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("kula-node-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Say "downloading $asset ($base)"
  $sumsFile = Join-Path $tmp 'sha256sums.txt'
  Invoke-WebRequest -UseBasicParsing -Uri "$base/sha256sums.txt" -OutFile $sumsFile
  $want = $null
  foreach ($line in Get-Content $sumsFile) {
    if ($line -match '^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$' -and $Matches[2] -eq $asset) { $want = $Matches[1].ToLower(); break }
  }
  if (-not $want) { throw "kula-node install: sha256sums.txt has no line for $asset" }
  $file = Join-Path $tmp $asset
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $file
  $got = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLower()
  if ($got -ne $want) { throw "kula-node install: sha256 mismatch for ${asset}: got $got, want $want. nothing was installed." }
  Say "sha256 ok ($got)"

  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $exe = Join-Path $dir 'kula-node.exe'
  Move-Item -Force -Path $file -Destination $exe
  # downloaded with a browser it would carry the internet zone mark; this way it does not, but be sure
  Unblock-File -Path $exe -ErrorAction SilentlyContinue
  Say "installed $exe"
  & $exe --version
  if ($LASTEXITCODE -ne 0) { throw 'kula-node install: the installed kula-node.exe did not run' }
} finally {
  Remove-Item -Recurse -Force -Path $tmp -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$onPath = ($userPath -split ';' | Where-Object { $_.TrimEnd('\') -ieq $dir.TrimEnd('\') }).Count -gt 0
if (-not $onPath) {
  if ($env:KULA_NODE_NO_PATH -eq '1') {
    Say "$dir is not on your PATH (KULA_NODE_NO_PATH=1, left alone)"
  } else {
    $new = if ($userPath) { "$userPath;$dir" } else { $dir }
    [Environment]::SetEnvironmentVariable('Path', $new, 'User')
    $env:Path = "$env:Path;$dir"
    Say "added $dir to your user PATH; open a new terminal for it to take effect"
  }
}
Say 'next: kula-node setup   (llama.cpp, once), then: kula-node share'
Say 'the first share makes windows defender firewall ask about kula-node: allow it on private networks only (your home wi-fi), not public ones.'
