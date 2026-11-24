// Entry point.
//   (no arguments)                 menu-bar app + window (prototype, fake data)
//   --hidden                       menu-bar item only, window not opened
//   --render <outdir>              draw every page, sheet, alert and the menu offscreen to PNGs, then exit
//   --render-imagerenderer <outdir> draw one page with SwiftUI ImageRenderer, to show what it cannot draw
//   --write-iconset <dir>          write the app icon PNGs (used by build.sh)

import AppKit

@main
enum Main {
    static var delegate: AppDelegate?

    @MainActor
    static func main() {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--render"), i + 1 < args.count {
            exit(Render.run(outDir: args[i + 1]))
        }
        if let i = args.firstIndex(of: "--write-iconset"), i + 1 < args.count {
            exit(Render.writeIconset(args[i + 1]))
        }
        if let i = args.firstIndex(of: "--render-imagerenderer"), i + 1 < args.count {
            exit(Render.imageRendererDemo(outDir: args[i + 1]))
        }
        let app = NSApplication.shared
        let d = AppDelegate()
        d.startHidden = args.contains("--hidden")
        delegate = d
        app.delegate = d
        app.run()
    }
}
