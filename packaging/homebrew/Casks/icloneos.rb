cask "icloneos" do
  version "0.0.2"
  sha256 "0c29525fb6189dbb5e6fc44e1342b38ab10fad214c533d1d5054a635c5a74588"

  url "https://github.com/devclone20/icloneos/releases/download/v#{version}/iclone-os-mac-arm64.dmg",
      verified: "github.com/devclone20/icloneos/"
  name "iclone os"
  desc "Desktop home for iNFT agents"
  homepage "https://cloneframe.io/"

  livecheck do
    url :url
    strategy :github_latest
  end

  # The app updates itself (electron-updater): brew must not also upgrade it behind the app's back.
  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :monterey

  app "iclone os.app"

  zap trash: [
    "~/Library/Application Support/iclone os",
    "~/Library/Caches/iclone-os-updater",
    "~/Library/Preferences/io.cloneframe.icloneos.plist",
    "~/Library/Saved Application State/io.cloneframe.icloneos.savedState",
  ]
end
