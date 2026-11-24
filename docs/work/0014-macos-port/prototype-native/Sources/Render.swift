// Review render mode: draws every page, the key sheets, the alerts and the menu-bar item
// to PNG files without showing anything on screen.
//
// Why not SwiftUI ImageRenderer: on macOS it draws every AppKit-backed control (Button,
// Toggle, Picker, TextField, ProgressView, Gauge, Table and List alike) as a yellow
// placeholder; see `--render-imagerenderer`. Instead each view is put in an NSWindow that
// is never ordered front (so it never appears on screen) and drawn with
// NSView.cacheDisplay(in:to:), which needs no screen-recording permission.

import AppKit
import SwiftUI

/// Draws its controls in the active (key-window) look although it is never shown.
/// The public overrides alone do not change how controls draw, so the private AppKit
/// selectors that decide the active look are answered too. Render mode only; the app
/// itself never uses this class.
final class OffscreenWindow: NSWindow {
    override var isKeyWindow: Bool { true }
    override var isMainWindow: Bool { true }
    @objc(_hasActiveAppearance) func r_hasActiveAppearance() -> Bool { true }
    @objc(_hasActiveAppearanceIgnoringKeyFocus) func r_hasActiveAppearanceIgnoringKeyFocus() -> Bool { true }
    @objc(_hasActiveControls) func r_hasActiveControls() -> Bool { true }
    @objc(_hasKeyAppearance) func r_hasKeyAppearance() -> Bool { true }
    @objc(hasKeyAppearance) func r_hasKeyAppearance2() -> Bool { true }
}

@MainActor
enum Render {
    static var out = URL(fileURLWithPath: ".")
    static var written: [String] = []

    static let light = NSAppearance(named: .aqua)!
    static let dark = NSAppearance(named: .darkAqua)!

    static func pump(_ s: Double = 0.35) { RunLoop.current.run(until: Date().addingTimeInterval(s)) }

    static func save(_ rep: NSBitmapImageRep, _ name: String) {
        let url = out.appendingPathComponent(name + ".png")
        if let data = rep.representation(using: .png, properties: [:]) {
            try? data.write(to: url)
            written.append(url.lastPathComponent)
        }
    }

    static func snapshot(_ view: NSView, _ name: String) {
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        save(rep, name)
    }

    // MARK: Window pages

    static func window(_ name: String, size: CGSize, dark isDark: Bool = false, _ setup: (AppStore) -> Void) {
        let store = AppStore()
        setup(store)
        let win = OffscreenWindow(contentRect: NSRect(origin: .zero, size: size),
                                  styleMask: [.titled, .closable, .miniaturizable, .resizable],
                                  backing: .buffered, defer: true)
        win.appearance = isDark ? dark : light
        win.title = "DSHProxy"
        win.isReleasedWhenClosed = false
        let hv = NSHostingView(rootView: RootView(store: store))
        win.contentView = hv
        win.setFrame(NSRect(origin: .zero, size: size), display: false)   // frame = whole window incl. title bar
        pump()
        hv.layoutSubtreeIfNeeded()
        pump(0.15)
        snapshot(hv.superview ?? hv, name)
        win.contentView = nil
    }

    static func both(_ name: String, _ setup: @escaping (AppStore) -> Void) {
        window("1280-" + name, size: CGSize(width: 1280, height: 800), setup)
        window("860-" + name, size: CGSize(width: 860, height: 600), setup)
    }

    // MARK: Sheets, alerts, menu

    static func panel<V: View>(_ name: String, dark isDark: Bool = false, _ view: V) {
        let win = OffscreenWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 400), styleMask: [.borderless], backing: .buffered, defer: true)
        win.appearance = isDark ? dark : light
        win.isReleasedWhenClosed = false
        let hv = NSHostingView(rootView: view.background(Color(nsColor: .windowBackgroundColor)))
        win.contentView = hv
        pump(0.1)
        let size = hv.fittingSize
        win.setContentSize(size)
        pump()
        hv.layoutSubtreeIfNeeded()
        pump(0.1)
        snapshot(hv, name)
        win.contentView = nil
    }

    static func alert(_ name: String, _ spec: AlertSpec?) {
        guard let spec else { print("no alert for \(name)"); return }
        let a = makeAlert(spec)
        a.icon = appIcon(128)
        a.window.appearance = light
        a.layout()
        if let v = a.window.contentView?.superview ?? a.window.contentView { snapshot(v, name) }
    }

    // MARK: Run

    static func run(outDir: String) -> Int32 {
        out = URL(fileURLWithPath: outDir)
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)      // no Dock icon, no menu-bar item, no window on screen

        // Pages of both workspaces
        for s in Section.allCases where s != .log {
            both("chat-\(slug(s))") { $0.go(.chat, s) }
            both("video-\(slug(s))") { $0.go(.video, s) }
        }
        both("log") { $0.go(.chat, .log) }

        // States
        both("state-stopped") { $0.gateway = .stopped }
        both("state-starting") { $0.gateway = .starting }
        both("state-notanswering") { $0.gateway = .notAnswering }
        both("state-notanswering-apikeys") { $0.gateway = .notAnswering; $0.go(.chat, .apiKeys) }
        both("empty-chat-accounts") { $0.d = .empty() }
        both("empty-chat-models") { $0.d = .empty(); $0.go(.chat, .models) }
        both("empty-video-lanes") { $0.d = .empty(); $0.go(.video, .lanes) }
        both("update-busy") { $0.backend.busy = true }
        both("update-rollback") { $0.backend = Backend(current: "6.10.0", latest: nil, released: "", previous: "6.9.2", busy: false) }
        both("video-accounts-signing") { $0.go(.video, .accounts); $0.d.krea = .signing }
        both("chat-lanes-custom") { s in s.go(.chat, .lanes); s.d.preset = "custom"; s.d.accounts.removeAll { $0.provider == "kimi" } }
        both("chat-accounts-notice") { $0.say("Paused Claude (b@example.com).") }
        window("1280-dark-chat-accounts", size: CGSize(width: 1280, height: 800), dark: true) { _ in }
        window("1280-dark-chat-lanes", size: CGSize(width: 1280, height: 800), dark: true) { $0.go(.chat, .lanes) }
        window("1280-dark-chat-models", size: CGSize(width: 1280, height: 800), dark: true) { $0.go(.chat, .models) }
        window("1280-dark-state-stopped", size: CGSize(width: 1280, height: 800), dark: true) { $0.gateway = .stopped }

        // Sheets (their size does not depend on the window)
        let s = AppStore()
        let codex = s.d.accounts.first { $0.provider == "codex" }!
        panel("sheet-add-1-choose", AddAccountSheet(store: s, step: .choose))
        panel("sheet-add-2-asking", AddAccountSheet(store: s, step: .asking("claude")))
        panel("sheet-add-3-browser-opened", AddAccountSheet(store: s, step: .waiting("claude")))
        panel("sheet-add-3-device-code", AddAccountSheet(store: s, step: .waiting("kimi")))
        panel("sheet-add-4-success", AddAccountSheet(store: s, step: .success("claude", "f@example.com")))
        panel("sheet-add-4-failure", AddAccountSheet(store: s, step: .failure("codex")))
        panel("sheet-reset-empty", ResetSheet(store: s, account: codex))
        panel("sheet-reset-typed-lowercase", ResetSheet(store: s, account: codex, typed: "reset"))
        panel("sheet-reset-typed-RESET", ResetSheet(store: s, account: codex, typed: " RESET "))
        panel("sheet-apikey-zai", KeySheet(store: s, target: .chat("zai"), value: "sk-synthetic-not-a-key"))
        panel("sheet-apikey-deepseek-empty", KeySheet(store: s, target: .chat("deepseek")))
        panel("sheet-videokey-error", KeySheet(store: s, target: .video("kovapi"), value: "two words", error: AppStore.videoKeyError("two words")))
        panel("sheet-restart-wait", RestartWaitSheet(store: s, left: 2, live: false))
        panel("sheet-route-unset", RouteSheet(store: s, model: s.d.vmodels[1], enableAfter: true))
        panel("sheet-route-set", RouteSheet(store: s, model: s.d.vmodels[0], enableAfter: false))
        panel("sheet-apply-checklist", ApplySheet(store: s, phase: .checklist))
        panel("sheet-apply-busy", ApplySheet(store: s, phase: .busy))
        panel("sheet-apply-result", ApplySheet(store: AppStore(), phase: .result(AppStore().applyNow())))
        panel("sheet-preview", OutputSheet(store: s, spec: s.previewSpec()))
        panel("sheet-verify", OutputSheet(store: s, spec: s.verifySpec()))
        panel("sheet-add-1-choose-dark", dark: true, AddAccountSheet(store: s, step: .choose))
        panel("sheet-reset-typed-RESET-dark", dark: true, ResetSheet(store: s, account: codex, typed: "RESET"))

        // Alerts (native NSAlert, laid out but never shown)
        alert("alert-signout", s.signOutAlert(s.d.accounts[1]))
        alert("alert-stop-inflight", s.stopAlert())
        alert("alert-quit-inflight", s.quitAlert())
        alert("alert-preset", s.presetAlert("cheap"))
        alert("alert-use-newer-model", s.suggestionAlert())
        alert("alert-edit-lanes", s.editLanesAlert())
        alert("alert-remove-key", s.removeKeyAlert("deepseek"))
        alert("alert-restart-question", s.restartAlert("Saved the DeepSeek key."))
        alert("alert-update", s.updateAlert())
        alert("alert-remove-harness", s.removeHarnessAlert())
        alert("alert-krea-signout", s.kreaSignOutAlert())
        alert("alert-remove-videokey", s.removeVideoKeyAlert("videorouter"))
        alert("alert-add-account-stopped", s.needRunningAlert("Add account", "Start the gateway first. Sign-in runs through it."))
        let rb = AppStore(); rb.backend = Backend(current: "6.10.0", latest: nil, released: "", previous: "6.9.2", busy: false)
        alert("alert-rollback", rb.rollbackAlert())
        let na = AppStore(); na.gateway = .notAnswering
        alert("alert-stop-notanswering", na.stopAlert())

        // Menu-bar item
        panel("menubar-icons", MenuIconsSheet())
        for g in [Gateway.running, .stopped] {
            let m = AppStore(); m.gateway = g
            panel("menubar-menu-\(g.rawValue)", MenuDrawing(store: m))
        }

        print("Wrote \(written.count) PNGs to \(out.path):")
        for w in written { print("  " + w) }
        return 0
    }

    static func slug(_ s: Section) -> String {
        switch s {
        case .accounts: return "accounts"
        case .apiKeys: return "apikeys"
        case .lanes: return "lanes"
        case .models: return "models"
        case .harness: return "harness"
        case .log: return "log"
        }
    }

    static func appIcon(_ px: CGFloat) -> NSImage? {
        let r = ImageRenderer(content: AppIconArt())
        r.scale = px / 1024
        return r.nsImage
    }

    /// Writes the PNGs of an .iconset (build.sh turns it into AppIcon.icns with iconutil).
    static func writeIconset(_ dir: String) -> Int32 {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let url = URL(fileURLWithPath: dir)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        for base in [16, 32, 128, 256, 512] {
            for scale in [1, 2] {
                let px = CGFloat(base * scale)
                let r = ImageRenderer(content: AppIconArt())
                r.scale = px / 1024
                guard let cg = r.cgImage else { return 1 }
                let rep = NSBitmapImageRep(cgImage: cg)
                let name = "icon_\(base)x\(base)\(scale == 2 ? "@2x" : "").png"
                try? rep.representation(using: .png, properties: [:])?.write(to: url.appendingPathComponent(name))
            }
        }
        return 0
    }

    /// Evidence for the README: what ImageRenderer makes of the Accounts page.
    static func imageRendererDemo(outDir: String) -> Int32 {
        out = URL(fileURLWithPath: outDir)
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        NSApplication.shared.setActivationPolicy(.prohibited)
        let store = AppStore()
        let r = ImageRenderer(content: RootView(store: store).frame(width: 1280, height: 772).environment(\.colorScheme, .light))
        r.scale = 1
        if let img = r.nsImage, let t = img.tiffRepresentation, let rep = NSBitmapImageRep(data: t) {
            save(rep, "imagerenderer-chat-accounts")
            print("Wrote \(out.appendingPathComponent("imagerenderer-chat-accounts.png").path)")
            return 0
        }
        print("ImageRenderer returned no image")
        return 1
    }
}

// MARK: - Drawings of the menu-bar item for review (the real menu is an NSMenu built from the same entries)

struct MenuIconsSheet: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Menu-bar icon by gateway state (template image, drawn 18 pt; shown here at 2×)").font(.headline)
            ForEach([false, true], id: \.self) { darkBar in
                HStack(spacing: 28) {
                    ForEach(Gateway.allCases, id: \.self) { g in
                        VStack(spacing: 6) {
                            Image(nsImage: StatusIcon.image(for: g, size: 36)).renderingMode(.template)
                                .foregroundStyle(darkBar ? Color.white : Color.black)
                            Text(g.menuText).font(.caption).foregroundStyle(darkBar ? Color.white : Color.black)
                        }
                    }
                }
                .padding(14)
                .background(darkBar ? Color(white: 0.16) : Color(white: 0.93))
            }
        }
        .padding(18)
    }
}

struct MenuDrawing: View {
    @ObservedObject var store: AppStore

    var body: some View {
        VStack(alignment: .trailing, spacing: 0) {
            HStack(spacing: 14) {
                Text("Drawing of the NSMenu for review").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Image(nsImage: StatusIcon.image(for: store.gateway, size: 18)).renderingMode(.template)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 4).fill(Color.black.opacity(0.12)))
                Text("Mon 23 Nov 23:00").font(.system(size: 13))
            }
            .padding(.horizontal, 10).frame(height: 26)
            .background(Color(white: 0.90))
            HStack(alignment: .top, spacing: 4) {
                Spacer()
                menu(menuEntries(store), width: 230)
                if case .submenu(_, let sub) = menuEntries(store).first(where: { if case .submenu = $0 { return true }; return false })! {
                    menu(sub, width: 260).padding(.top, 196).opacity(0.97)
                }
            }
            .padding(.trailing, 60)
            .padding(.top, 2)
            .padding(.bottom, 10)
        }
        .frame(width: 640)
        .background(Color(white: 0.97))
    }

    private func menu(_ entries: [MenuEntry], width: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(entries.enumerated()), id: \.offset) { _, e in row(e) }
        }
        .padding(5)
        .frame(width: width)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(white: 0.985)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.black.opacity(0.15)))
        .shadow(color: .black.opacity(0.18), radius: 8, y: 3)
    }

    @ViewBuilder private func row(_ e: MenuEntry) -> some View {
        switch e {
        case .header(let t):
            Text(t).font(.system(size: 13)).foregroundStyle(.secondary).padding(.horizontal, 22).frame(height: 22)
        case .separator:
            Divider().padding(.horizontal, 8).padding(.vertical, 4)
        case .item(let t, let enabled, let checked, let key, _):
            HStack(spacing: 0) {
                Text(checked ? "✓" : "").frame(width: 22)
                Text(t)
                Spacer()
                if !key.isEmpty { Text("⌘" + key.uppercased()).foregroundStyle(.secondary) }
            }
            .font(.system(size: 13))
            .foregroundStyle(enabled ? .primary : .tertiary)
            .padding(.trailing, 10).frame(height: 22)
        case .submenu(let t, _):
            HStack(spacing: 0) {
                Text("").frame(width: 22)
                Text(t)
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
            }
            .font(.system(size: 13)).padding(.trailing, 10).frame(height: 22)
        }
    }
}
