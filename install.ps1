# kula-node installer for Windows: one .exe into %LOCALAPPDATA%\kula-node and
# that folder on your user PATH. No administrator rights needed.
#
#   irm https://raw.githubusercontent.com/kurtkurtkurt-del/kula-decentralized-ai/main/install.ps1 | iex
#
# It fetches the binary and SHA256SUMS from the GitHub release and refuses to
# install unless the hash matches.
#
#   $env:KULA_VERSION = "0.2.0"       a specific release instead of the latest
#   $env:KULA_BIN_DIR = "C:\tools"    where to put it
#   $env:KULA_BASE_URL = "..."        where the files are (default: the GitHub release)
$ErrorActionPreference = 'Stop'
$Repo = 'kurtkurtkurt-del/kula-decentralized-ai'
$BinDir = if ($env:KULA_BIN_DIR) { $env:KULA_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'kula-node' }

$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
if ($arch -ne 'x64') { throw "install: no windows build for $arch yet; see docs/NODE.md for running from source" }
$target = "win-$arch"

$version = $env:KULA_VERSION
if (-not $version) {
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'kula-node-install' }
  $version = $rel.tag_name -replace '^v', ''
}
$base = if ($env:KULA_BASE_URL) { $env:KULA_BASE_URL } else { "https://github.com/$Repo/releases/download/v$version" }
$name = "kula-node-$version-$target.exe"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("kula-node-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "kula-node $version for $target"
  Write-Host "  from $base"
  Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS') -UseBasicParsing
  Invoke-WebRequest -Uri "$base/$name" -OutFile (Join-Path $tmp $name) -UseBasicParsing

  $line = Get-Content (Join-Path $tmp 'SHA256SUMS') | Where-Object { $_ -match "^\s*([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($name))\s*$" } | Select-Object -First 1
  if (-not $line) { throw "install: $name is not listed in SHA256SUMS; refusing to install" }
  $want = ($line -split '\s+')[0].ToLower()
  $got = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $name)).Hash.ToLower()
  if ($got -ne $want) {
    throw "install: sha256 mismatch for $name`n  got  $got`n  want $want`nnothing was installed. the download is damaged or the release was tampered with; try again later"
  }
  Write-Host "  sha256 ok"

  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  Move-Item -Force (Join-Path $tmp $name) (Join-Path $BinDir 'kula-node.exe')
  Write-Host "installed $BinDir\kula-node.exe"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $BinDir) {
    [Environment]::SetEnvironmentVariable('Path', "$BinDir;$userPath", 'User')
    $env:Path = "$BinDir;$env:Path"
    Write-Host "added $BinDir to your user PATH (new terminals see it; this one does too)"
  }
  Write-Host ""
  Write-Host "windows firewall: the first 'kula-node share' opens a dialog asking whether kula-node may"
  Write-Host "accept connections. tick 'private networks' and allow, or phones cannot reach port 50551."
  Write-Host "pressed cancel? in an administrator powershell:"
  Write-Host "  New-NetFirewallRule -DisplayName kula-node -Direction Inbound -Protocol TCP -LocalPort 50551 -Profile Private -Action Allow"
  Write-Host ""
  Write-Host "next: kula-node        (a menu)   or   kula-node setup   (fetch llama.cpp, ~20 MB)"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
