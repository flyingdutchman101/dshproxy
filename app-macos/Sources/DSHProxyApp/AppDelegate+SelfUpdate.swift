import AppKit
import DSHProxyKit

// Uses the checkout CLI even when the gateway is stopped. The detached helper owns
// preflight, active-request protection, gateway state, replacement and recovery.
extension AppDelegate {
    struct UpdateReply: Decodable {
        let status: String
        let installed: String?
        let candidate: String?
        let subject: String?
        let url: String?
        let message: String?
    }

    func updateCommand(_ args: [String]) async throws -> UpdateReply {
        guard let kit = store.kit else { throw UpdateError.unavailable }
        let result = await kit.runner.run(["self-update"] + args, timeout: args.first == "install" ? 1500 : 120)
        guard let data = result.stdout.data(using: .utf8),
              let reply = try? JSONDecoder().decode(UpdateReply.self, from: data) else {
            throw UpdateError.invalid(result.timedOut ? "The update command timed out." : "The checkout CLI could not return an update response. Check that Node and the checkout are available.")
        }
        return reply
    }

    enum UpdateError: LocalizedError {
        case unavailable, invalid(String)
        var errorDescription: String? {
            switch self {
            case .unavailable: return "Updates require a supported checkout installation."
            case .invalid(let message): return message
            }
        }
    }

    func updateAlert(_ title: String, _ message: String, install: Bool = false, url: String? = nil) -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: install ? "Cancel" : "OK")
        if install { alert.addButton(withTitle: "Install and Relaunch") }
        if let url, let link = URL(string: url), link.scheme == "https", link.host == "github.com" {
            let button = NSButton(title: "View official commit", target: nil, action: nil)
            button.frame = NSRect(x: 0, y: 0, width: 220, height: 28)
            button.target = self
            button.action = #selector(openUpdateCommit(_:))
            button.toolTip = link.absoluteString
            alert.accessoryView = button
        }
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertSecondButtonReturn
    }

    @objc func openUpdateCommit(_ sender: NSButton) {
        if let text = sender.toolTip, let url = URL(string: text) { NSWorkspace.shared.open(url) }
    }

    func checkForUpdate() async {
        guard !updateBusy else { return }
        updateBusy = true
        defer { updateBusy = false }
        do {
            let reply = try await updateCommand(["check"])
            let details = "Installed: \(reply.installed.map { String($0.prefix(12)) } ?? "unknown")\nCandidate: \(reply.candidate.map { String($0.prefix(12)) } ?? "none")\n\(reply.subject ?? "")\n\n\(reply.message ?? "")"
            guard reply.status == "available", let sha = reply.candidate,
                  sha.count == 40, sha.allSatisfy({ $0.isASCII && $0.isHexDigit }) else {
                _ = updateAlert(reply.status == "current" ? "DSHProxy is up to date" : "DSHProxy update unavailable", details, url: reply.url)
                return
            }
            guard updateAlert("Install DSHProxy update?", details + "\n\nDSHProxy stays open while the update builds, then closes and relaunches. The installer preserves settings and gateway state and refuses to interrupt active requests.", install: true, url: reply.url) else { return }
            let installed = try await updateCommand(["install", "--sha", sha, store.ownAlive ? "--owns-gateway" : "--no-gateway"])
            if installed.status == "started" {
                store.readyToQuit = true // Do not stop the gateway: the detached helper owns it.
                NSApp.terminate(nil)
            } else {
                _ = updateAlert("DSHProxy update unavailable", installed.message ?? "The installer did not start.")
            }
        } catch {
            _ = updateAlert("DSHProxy update unavailable", error.localizedDescription)
        }
    }

    func showUpdateResult() async {
        do {
            let reply = try await updateCommand(["result"])
            guard ["success", "failed", "working"].contains(reply.status) else { return }
            _ = updateAlert(reply.status == "failed" ? "DSHProxy update failed" : reply.status == "working" ? "DSHProxy update in progress" : "DSHProxy updated", reply.message ?? reply.status)
        } catch {
            // Older checkout CLIs may not implement result; explicit checks report errors.
        }
    }
}
