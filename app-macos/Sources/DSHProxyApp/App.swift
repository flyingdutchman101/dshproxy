// Entry point.
//   (no arguments)     menu-bar item + window; starts the gateway (as the Windows app does)
//   --hidden           menu-bar item only, window not opened
//   --render <dir>     developer review only: draws the pages with clearly marked sample data to PNGs and
//                      exits; starts no gateway, runs no command, opens no socket, shows nothing on screen

import AppKit
import DSHProxyKit

enum SingleInstance {
    static let bundleID = Bundle.main.bundleIdentifier ?? "com.dshproxy.app"
    static let showNotification = Notification.Name(bundleID + ".show")

    /// True when another DSHProxy is running: it has been asked to show its window.
    static func handOver() -> Bool {
        let me = ProcessInfo.processInfo.processIdentifier
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).filter { $0.processIdentifier != me }
        guard !others.isEmpty else { return false }
        DistributedNotificationCenter.default().postNotificationName(showNotification, object: nil, userInfo: nil, deliverImmediately: true)
        return true
    }
}

@main
enum Main {
    static var delegate: AppDelegate?

    @MainActor
    static func main() {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--render"), i + 1 < args.count {
            exit(Render.run(outDir: args[i + 1]))
        }
        if let option = args.dropFirst().first(where: { $0.hasPrefix("--") && !["--hidden", "--render"].contains($0) }) {
            FileHandle.standardError.write(Data("DSHProxy: \(option) is not available in the macOS app. Nothing was started.\n".utf8))
            exit(2)
        }
        if SingleInstance.handOver() { exit(0) }

        let app = NSApplication.shared
        let locations: Locations
        do {
            locations = try Locations.find(environment: ProcessInfo.processInfo.environment,
                                           recordedCheckout: Bundle.main.object(forInfoDictionaryKey: "DSHProxyCheckout") as? String,
                                           homeDirectory: FileManager.default.homeDirectoryForCurrentUser)
        } catch {
            app.setActivationPolicy(.accessory)
            let alert = NSAlert()
            alert.messageText = "DSHProxy"
            alert.informativeText = "\(error)"
            alert.alertStyle = .critical
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
            exit(1)
        }
        let kit = AppStore.Kit(locations: locations, runner: CommandRunner(locations: locations), gateway: GatewayProcess(locations: locations))
        let d = AppDelegate(store: AppStore(kit: kit))
        d.startHidden = args.contains("--hidden")
        delegate = d
        app.delegate = d
        app.run()
    }
}
