// Choosing a llama.cpp release archive for a machine. Pure: it only looks at
// names, so it is tested against a recorded asset list and never the network.
// `digest` is what the github api gives for each asset: "sha256:<hex>"
export interface Asset { name: string; browser_download_url: string; size?: number; digest?: string | null }

export function digestSha256(digest: string | null | undefined): string | null {
  const m = /^sha256:([0-9a-fA-F]{64})$/.exec(digest ?? '');
  return m ? m[1].toLowerCase() : null;
}

export interface Pick {
  asset: Asset;
  // the matching cuda runtime archive, when the pick needs one
  companion: Asset | null;
  // the .sha256 sidecar, when the release has one for this asset
  sidecar: Asset | null;
  why: string;
}

function suffixes(platform: string, arch: string, hasNvidia: boolean): { suffix: string; why: string }[] {
  const a = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : arch;
  const cpu = (os: string, ext: string) => ({ suffix: `bin-${os}-${a}.${ext}`, why: `cpu build for ${platform}/${a}` });
  if (platform === 'win32') {
    const list = hasNvidia
      ? [{ suffix: `bin-win-cuda-12.4-${a}.zip`, why: 'nvidia gpu found, cuda 12 build' }, { suffix: `bin-win-cuda-13.4-${a}.zip`, why: 'nvidia gpu found, cuda 13 build' }]
      : [];
    return [...list, { suffix: `bin-win-cpu-${a}.zip`, why: `cpu build for windows/${a}` }, cpu('win', 'zip')];
  }
  if (platform === 'linux') {
    const list = hasNvidia
      ? [{ suffix: `bin-ubuntu-cuda-12.8-${a}.tar.gz`, why: 'nvidia gpu found, cuda 12 build' }, { suffix: `bin-ubuntu-cuda-13.4-${a}.tar.gz`, why: 'nvidia gpu found, cuda 13 build' }]
      : [];
    return [...list, cpu('ubuntu', 'tar.gz'), cpu('linux', 'tar.gz')];
  }
  if (platform === 'darwin') return [cpu('macos', 'tar.gz')];
  return [];
}

// The first asset that fits, by preference: a cuda build when an nvidia gpu
// is present (with its cudart companion), else the plain cpu build. Snapdragon
// and other vendor builds are never picked. Null when nothing fits.
export function pickAsset(platform: string, arch: string, hasNvidia: boolean, assets: Asset[]): Pick | null {
  const plain = assets.filter((x) => /^llama-/.test(x.name) && !/snapdragon|adreno/.test(x.name));
  for (const { suffix, why } of suffixes(platform, arch, hasNvidia)) {
    const asset = plain.find((x) => x.name.endsWith(suffix));
    if (!asset) continue;
    const companion = /cuda/.test(suffix) ? assets.find((x) => x.name.startsWith('cudart-') && x.name.endsWith(suffix)) ?? null : null;
    const sidecar = assets.find((x) => x.name === `${asset.name}.sha256`) ?? null;
    return { asset, companion, sidecar, why };
  }
  return null;
}

// The commands to build the two programs when there is no archive, or the
// archive has no rpc server in it.
export function buildInstructions(tag: string, platform: string = process.platform): string {
  const clone = `git clone --depth 1 --branch ${tag} https://github.com/ggml-org/llama.cpp`;
  const configure = `cmake -B build -DGGML_RPC=ON -DLLAMA_BUILD_TOOLS=ON -DLLAMA_BUILD_SERVER=ON -DLLAMA_CURL=OFF`;
  const build = `cmake --build build --config Release --target ggml-rpc-server llama-server`;
  if (platform === 'win32') {
    return [
      `build llama.cpp ${tag} yourself. install git, cmake and visual studio 2022 build tools (desktop c++),`,
      `then in a "x64 native tools" command prompt:`,
      `  ${clone}`,
      `  cd llama.cpp`,
      `  ${configure}`,
      `  ${build}`,
      `then point kula-node at the result:`,
      `  set KULA_LLAMA_DIR=%CD%\\build\\bin\\Release`,
      `  kula-node share`,
    ].join('\n');
  }
  const deps = platform === 'darwin'
    ? 'brew install cmake ninja'
    : 'sudo apt install git cmake build-essential   (or: sudo dnf install git cmake gcc-c++)';
  return [
    `build llama.cpp ${tag} yourself (needs git, cmake and a C++ compiler: ${deps}):`,
    `  ${clone}`,
    `  cd llama.cpp`,
    `  ${configure}`,
    `  ${build} -j`,
    `then point kula-node at the result: KULA_LLAMA_DIR=$PWD/build/bin kula-node share`,
  ].join('\n');
}

// Reads a .sha256 sidecar: "<hex>  <name>" or just the hex.
export function parseSidecar(text: string): string | null {
  const m = /^\s*([0-9a-fA-F]{64})\b/.exec(text);
  return m ? m[1].toLowerCase() : null;
}
