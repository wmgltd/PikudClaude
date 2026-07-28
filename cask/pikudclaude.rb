cask "pikudclaude" do
  version "0.3.2"
  sha256 "2ac6110c84807ff8a5ed12d1652d998a91a50fdee461ac5830c806e5d8d45f92"

  url "https://github.com/wmgltd/PikudClaude/releases/download/v#{version}/PikudClaude-#{version}-arm64.dmg",
      verified: "github.com/wmgltd/PikudClaude/"
  name "PikudClaude"
  desc "Multi-session terminal hub for Claude Code with Hebrew/RTL support"
  homepage "https://pikud.io/"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :monterey
  depends_on arch: :arm64
  depends_on formula: "tmux"

  app "PikudClaude.app"

  zap trash: [
    "~/Library/Application Support/pikudclaude",
    "~/Library/Caches/com.kobi.pikudclaude",
    "~/Library/Caches/com.kobi.pikudclaude.ShipIt",
    "~/Library/Logs/pikudclaude",
    "~/Library/Preferences/com.kobi.pikudclaude.plist",
    "~/Library/Saved Application State/com.kobi.pikudclaude.savedState",
  ]
end
