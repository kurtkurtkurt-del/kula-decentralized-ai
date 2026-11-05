# kula-node homebrew formula (draft). Rendered by node/tools/release-files.mjs
# from node/package.json and the release's sha256sums.txt; the release job
# attaches the filled-in copy. For a tap: put it in Formula/kula-node.rb of
# a homebrew-kula repository, then: brew install kurtkurtkurt-del/kula/kula-node
class KulaNode < Formula
  desc "Make this computer a worker in a kula phone cluster"
  homepage "https://github.com/kurtkurtkurt-del/kula-decentralized-ai"
  version "0.1.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/kurtkurtkurt-del/kula-decentralized-ai/releases/download/v0.1.0/kula-node-mac-arm64"
      sha256 "REPLACE_WITH_SHA256_OF_kula-node-mac-arm64"
    end
    on_intel do
      url "https://github.com/kurtkurtkurt-del/kula-decentralized-ai/releases/download/v0.1.0/kula-node-mac-x64"
      sha256 "REPLACE_WITH_SHA256_OF_kula-node-mac-x64"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/kurtkurtkurt-del/kula-decentralized-ai/releases/download/v0.1.0/kula-node-linux-arm64"
      sha256 "REPLACE_WITH_SHA256_OF_kula-node-linux-arm64"
    end
    on_intel do
      url "https://github.com/kurtkurtkurt-del/kula-decentralized-ai/releases/download/v0.1.0/kula-node-linux-x64"
      sha256 "REPLACE_WITH_SHA256_OF_kula-node-linux-x64"
    end
  end

  def install
    bin.install Dir["kula-node-*"].first => "kula-node"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/kula-node --version")
  end
end
