#!/bin/sh
# kula-node installer for macOS and Linux.
#
#   curl -fsSL https://github.com/kurtkurtkurt-del/kula-decentralized-ai/releases/latest/download/install.sh | sh
#
# Downloads the single kula-node binary for this machine from the GitHub
# release, checks it against the release's sha256sums.txt and puts it in
# ~/.local/bin. Nothing is installed when the sha256 does not match. No sudo.
#
# Environment (all optional):
#   KULA_NODE_VERSION   e.g. 0.1.0 (default: the latest release)
#   KULA_NODE_BIN_DIR   where the binary goes (default: ~/.local/bin)
#   KULA_NODE_BASE_URL  where the release files are (default: the GitHub release);
#                       plain http is accepted only for 127.0.0.1 / localhost
set -eu

REPO="kurtkurtkurt-del/kula-decentralized-ai"
VERSION="${KULA_NODE_VERSION:-latest}"
BIN_DIR="${KULA_NODE_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "kula-node install: $*"; }
die() { printf '%s\n' "kula-node install: $*" >&2; exit 1; }

if [ -n "${KULA_NODE_BASE_URL:-}" ]; then
  BASE="${KULA_NODE_BASE_URL%/}"
elif [ "$VERSION" = latest ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/v${VERSION#v}"
fi
case "$BASE" in
  https://*) ;;
  http://127.0.0.1:*|http://127.0.0.1/*|http://localhost:*|http://localhost/*) ;;
  *) die "refusing $BASE: only https (or http on this computer for tests)" ;;
esac

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=mac ;;
  Linux) os=linux ;;
  *) die "no kula-node binary for $os; on Windows use install.ps1" ;;
esac
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die "no kula-node binary for $arch" ;;
esac
# a shell under Rosetta says x86_64 on an Apple silicon Mac; take the native binary
if [ "$os" = mac ] && [ "$arch" = x64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
asset="kula-node-$os-$arch"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 2 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  die "needs curl or wget"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "needs sha256sum or shasum to check the download"
fi

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t kula-node)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "downloading $asset ($BASE)"
fetch "$BASE/sha256sums.txt" "$tmp/sha256sums.txt" || die "could not download sha256sums.txt from $BASE"
want=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print tolower($1); exit }' "$tmp/sha256sums.txt")
[ -n "$want" ] || die "sha256sums.txt has no line for $asset"
fetch "$BASE/$asset" "$tmp/$asset" || die "could not download $asset from $BASE"
got=$(sha256 "$tmp/$asset")
if [ "$got" != "$want" ]; then
  die "sha256 mismatch for $asset: got $got, want $want. nothing was installed."
fi
say "sha256 ok ($got)"

mkdir -p "$BIN_DIR"
chmod 755 "$tmp/$asset"
# copy next to the target, then rename: a running kula-node is never half overwritten
cp "$tmp/$asset" "$BIN_DIR/.kula-node.new"
mv -f "$BIN_DIR/.kula-node.new" "$BIN_DIR/kula-node"
say "installed $BIN_DIR/kula-node"
"$BIN_DIR/kula-node" --version || die "the installed binary did not run"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    say "$BIN_DIR is not on your PATH. add it, then open a new terminal:"
    case "${SHELL:-}" in
      */zsh) say "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc" ;;
      */fish) say "  fish_add_path $BIN_DIR" ;;
      *) say "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc" ;;
    esac
    ;;
esac
say "next: kula-node setup   (llama.cpp, once), then: kula-node share"
