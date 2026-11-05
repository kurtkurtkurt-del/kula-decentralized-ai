#!/bin/sh
# llama.cpp b11157 for iOS: Metal on, RPC on, static, as one xcframework the KulaLlama pod
# links (ios/llama/kula_llama_cpp.xcframework). The same pinned tree as Android
# (tools/llama-src.mjs fetches and patches it); the same flags as upstream's
# build-xcframework.sh for ios-device / ios-sim, without mtmd, tests, tools and server.
#
#   sh tools/ios-llama.sh            build device + simulator (arm64 each), ~10 min the first time
#   KULA_IOS_SIM=0 sh tools/ios-llama.sh   device only (EAS / archive builds)
#   KULA_IOS_FORCE=1 sh tools/ios-llama.sh rebuild even when the stamp matches
#
# Needs a Mac with Xcode (xcrun, xcodebuild, libtool) and cmake >= 3.22 (brew install cmake).
# Run from the module root; CocoaPods runs it from there as prepare_command.
set -eu

cd "$(dirname "$0")/.."
MODULE="$(pwd)"
SRC="$MODULE/android/src/main/cpp/llama.cpp"
OUT="$MODULE/ios/llama"
XC="$OUT/kula_llama_cpp.xcframework"
MIN_IOS="${KULA_IOS_MIN:-16.4}"
SIM="${KULA_IOS_SIM:-1}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "kula-llama ios: not a Mac; skipping the llama.cpp build (the pod will not link until it runs on a Mac)" >&2
  exit 0
fi

NODE="${NODE_BINARY:-node}"
for c in /usr/local/bin/node /opt/homebrew/bin/node; do
  if ! command -v "$NODE" >/dev/null 2>&1 && [ -x "$c" ]; then NODE="$c"; fi
done
"$NODE" tools/llama-src.mjs
TAG="$(cat "$SRC/.kula-tag")"
STAMP="$OUT/.kula-tag"
WANT="$TAG ios$MIN_IOS sim$SIM metal rpc v1"

if [ "${KULA_IOS_FORCE:-0}" != "1" ] && [ -d "$XC" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$WANT" ]; then
  echo "kula-llama ios: $XC already built for $WANT"
  exit 0
fi

command -v cmake >/dev/null 2>&1 || { echo "kula-llama ios: cmake not found (brew install cmake)" >&2; exit 1; }

COMMON="-DBUILD_SHARED_LIBS=OFF \
  -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
  -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_METAL_USE_BF16=ON \
  -DGGML_BLAS=OFF -DGGML_ACCELERATE=ON \
  -DGGML_RPC=ON -DGGML_RPC_RDMA=OFF \
  -DLLAMA_BUILD_COMMON=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_TOOLS=OFF -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_SERVER=OFF -DLLAMA_BUILD_MTMD=OFF -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_DEPLOYMENT_TARGET=$MIN_IOS \
  -DCMAKE_SYSTEM_NAME=iOS -DGGML_METAL_TARGET_OS=ios -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_C_FLAGS=-O3 -DCMAKE_CXX_FLAGS=-O3"

# $1 = slice name, $2 = sysroot, $3 = supported platforms attribute
build_slice() {
  SLICE="$1"; SYSROOT="$2"; PLAT="$3"
  B="$OUT/build-$SLICE"
  echo "kula-llama ios: building $SLICE"
  # shellcheck disable=SC2086
  cmake -S "$SRC" -B "$B" -G Xcode $COMMON \
    -DCMAKE_OSX_SYSROOT="$SYSROOT" \
    -DCMAKE_XCODE_ATTRIBUTE_SUPPORTED_PLATFORMS="$PLAT" \
    -DCMAKE_XCODE_ATTRIBUTE_ONLY_ACTIVE_ARCH=NO
  cmake --build "$B" --config Release -j "$(sysctl -n hw.logicalcpu)" -- -quiet
  LIBS="$(find "$B" -path '*Release-*' -name 'lib*.a' | grep -E 'lib(ggml|ggml-base|ggml-cpu|ggml-metal|ggml-blas|ggml-rpc|llama)\.a$' || true)"
  [ -n "$LIBS" ] || { echo "kula-llama ios: no static libs found under $B" >&2; exit 1; }
  echo "$LIBS" | sed 's/^/  /'
  # shellcheck disable=SC2086
  xcrun libtool -static -o "$OUT/$SLICE.a" $LIBS 2>/dev/null
}

rm -rf "$XC" "$OUT/device.a" "$OUT/simulator.a"
mkdir -p "$OUT/include"
cp "$SRC/include/llama.h" "$SRC/include/llama-cpp.h" "$OUT/include/"
cp "$SRC/ggml/include/"*.h "$OUT/include/"

build_slice device iphoneos iphoneos
ARGS="-library $OUT/device.a -headers $OUT/include"
if [ "$SIM" = "1" ]; then
  build_slice simulator iphonesimulator iphonesimulator
  ARGS="$ARGS -library $OUT/simulator.a -headers $OUT/include"
fi
# shellcheck disable=SC2086
xcodebuild -create-xcframework $ARGS -output "$XC"
echo "$WANT" > "$STAMP"
echo "kula-llama ios: $XC ready ($WANT)"
