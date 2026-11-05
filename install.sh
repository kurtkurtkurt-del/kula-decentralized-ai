#!/bin/sh
# kula-node installer for macOS and Linux: one binary into ~/.local/bin.
#
#   curl -fsSL https://raw.githubusercontent.com/kurtkurtkurt-del/kula-decentralized-ai/main/install.sh | sh
#
# What it does, and nothing else: finds the release for this os/arch, fetches
# the binary and SHA256SUMS from the GitHub release, refuses to install unless
# the hash matches, marks it executable, and tells you if ~/.local/bin is not
# on your PATH. No sudo, no system files.
#
#   KULA_VERSION=0.2.0   a specific release instead of the latest
#   KULA_BIN_DIR=/usr/local/bin   where to put it (default ~/.local/bin)
#   KULA_BASE_URL=...    where the files are (default: the GitHub release)
set -eu

REPO="kurtkurtkurt-del/kula-decentralized-ai"
BIN_DIR="${KULA_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*" >&2; }
die() { say "install: $*"; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is needed"; }
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else die "curl or wget is needed"; fi
}
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/.*= //'
  else die "sha256sum, shasum or openssl is needed"; fi
}

os=$(uname -s); arch=$(uname -m)
case "$os" in
  Darwin) os=mac ;;
  Linux) os=linux ;;
  *) die "no build for $os; see docs/NODE.md for running from source" ;;
esac
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) die "no build for $arch" ;;
esac
target="$os-$arch"

version="${KULA_VERSION:-}"
if [ -z "$version" ]; then
  tmpj=$(mktemp); trap 'rm -f "$tmpj"' EXIT
  fetch "https://api.github.com/repos/$REPO/releases/latest" "$tmpj" || die "could not ask GitHub for the latest release; set KULA_VERSION"
  version=$(sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' "$tmpj" | head -n1)
  [ -n "$version" ] || die "no release found; set KULA_VERSION"
fi
base="${KULA_BASE_URL:-https://github.com/$REPO/releases/download/v$version}"
name="kula-node-$version-$target"

tmp=$(mktemp -d); trap 'rm -rf "$tmp" "${tmpj:-}"' EXIT
say "kula-node $version for $target"
say "  from $base"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die "no SHA256SUMS at $base"
fetch "$base/$name" "$tmp/$name" || die "no $name at $base"

want=$(grep " $name\$" "$tmp/SHA256SUMS" | head -n1 | cut -d' ' -f1)
[ -n "$want" ] || die "$name is not listed in SHA256SUMS; refusing to install"
got=$(sha256 "$tmp/$name")
if [ "$got" != "$want" ]; then
  die "sha256 mismatch for $name
  got  $got
  want $want
nothing was installed. the download is damaged or the release was tampered with; try again later"
fi
say "  sha256 ok"

mkdir -p "$BIN_DIR"
chmod 755 "$tmp/$name"
mv -f "$tmp/$name" "$BIN_DIR/kula-node"
say "installed $BIN_DIR/kula-node"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    say ""
    say "$BIN_DIR is not on your PATH. add this line to ~/.zshrc or ~/.bashrc, then open a new terminal:"
    say "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
say ""
say "next: kula-node        (a menu)   or   kula-node setup   (fetch llama.cpp, ~20 MB)"
