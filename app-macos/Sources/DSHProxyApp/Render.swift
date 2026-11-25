// Developer-only review render (`--render <dir>`): draws pages and a few sheets to PNGs with SAMPLE DATA
// (a purple banner says so on every window), then exits. It starts no gateway, runs no command, opens no
// socket and shows nothing on screen: the store has no Kit, and every view is drawn in a window that is never
// ordered front (NSView.cacheDisplay; SwiftUI ImageRenderer cannot draw AppKit controls, see the prototype).
// The sample JSON goes through the same Kit mapping as real answers.

import AppKit
import DSHProxyKit
import SwiftUI

/// Draws controls in the active look although it is never shown (render mode only).
final class OffscreenWindow: NSWindow {
    override var isKeyWindow: Bool { true }
    override var isMainWindow: Bool { true }
    @objc(_hasActiveAppearance) func r_hasActiveAppearance() -> Bool { true }
    @objc(_hasActiveAppearanceIgnoringKeyFocus) func r_hasActiveAppearanceIgnoringKeyFocus() -> Bool { true }
    @objc(_hasActiveControls) func r_hasActiveControls() -> Bool { true }
    @objc(_hasKeyAppearance) func r_hasKeyAppearance() -> Bool { true }
}

@MainActor
enum Render {
    static var out = URL(fileURLWithPath: ".")
    static var written = 0

    static func pump(_ s: Double = 0.35) { RunLoop.current.run(until: Date().addingTimeInterval(s)) }

    static func snapshot(_ view: NSView, _ name: String) {
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        if let data = rep.representation(using: .png, properties: [:]) {
            try? data.write(to: out.appendingPathComponent(name + ".png"))
            written += 1
        }
    }

    static func sampleStore() -> AppStore {
        let store = AppStore(kit: nil)
        store.status = FullStatus.parse(sampleStatus)
        store.limits = LimitsReport.parse((try? JSONSerialization.jsonObject(with: Data(sampleLimits.utf8))) as? [String: Any] ?? [:])
        store.limitsState = .updated(Date())
        store.gateway = .running
        store.inFlight = 2
        if case .success(let models) = VideoSettings.parse(sampleVideo) { store.videoModels = models }
        store.videoStatus = ("Sample video settings: nothing was read.", .muted)
        if case .success(let keys) = VideoKeys.parse(sampleKeys) { store.videoKeys = keys }
        store.videoKeysStatus = ("Sample keys: nothing was read.", .muted)
        let krea = KreaStatus(signedIn: true, until: Date().addingTimeInterval(89 * 86400))
        store.krea = krea
        store.kreaState = Krea.describe(krea)
        store.kreaTone = .ok
        store.kreaReadAt = Date()
        store.harnessSetup = HarnessSetup.parse(sampleBundle)
        store.harnessReadAt = Date()
        for line in ["Starting the gateway...", "DSHProxy gateway listening on http://127.0.0.1:8417 (sample)", "Checked for new models."] { store.addLog(line, .action) }
        return store
    }

    static func window(_ name: String, size: CGSize, _ setup: (AppStore) -> Void) {
        let store = sampleStore()
        setup(store)
        let win = OffscreenWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: true)
        win.appearance = NSAppearance(named: .aqua)
        win.title = "DSHProxy"
        win.isReleasedWhenClosed = false
        let hv = NSHostingView(rootView: RootView(store: store))
        win.contentView = hv
        win.setFrame(NSRect(origin: .zero, size: size), display: false)
        pump()
        hv.layoutSubtreeIfNeeded()
        pump(0.15)
        snapshot(hv.superview ?? hv, name)
        win.contentView = nil
    }

    static func panel<V: View>(_ name: String, _ view: V) {
        let win = OffscreenWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 400), styleMask: [.borderless], backing: .buffered, defer: true)
        win.appearance = NSAppearance(named: .aqua)
        win.isReleasedWhenClosed = false
        let hv = NSHostingView(rootView: view.background(Color(nsColor: .windowBackgroundColor)))
        win.contentView = hv
        pump(0.1)
        win.setContentSize(hv.fittingSize)
        pump()
        hv.layoutSubtreeIfNeeded()
        pump(0.1)
        snapshot(hv, name)
        win.contentView = nil
    }

    static func run(outDir: String) -> Int32 {
        out = URL(fileURLWithPath: outDir)
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        NSApplication.shared.setActivationPolicy(.prohibited)   // no Dock icon, no menu-bar item, no window on screen
        let slugs: [Section: String] = [.accounts: "accounts", .apiKeys: "keys", .lanes: "lanes", .models: "models", .harness: "harness", .log: "log"]
        for section in Section.allCases {
            for ws in Workspace.allCases where !(section == .log && ws == .video) {
                let name = section == .log ? "log" : "\(ws.rawValue)-\(slugs[section]!)"
                window("1280-" + name, size: CGSize(width: 1280, height: 800)) { $0.workspace = ws; $0.section = section }
                window("860-" + name, size: CGSize(width: 860, height: 600)) { $0.workspace = ws; $0.section = section }
            }
        }
        window("860-stopped", size: CGSize(width: 860, height: 600)) { $0.gateway = .stopped }
        window("860-starting", size: CGSize(width: 860, height: 600)) { $0.gateway = .starting }
        let store = sampleStore()
        panel("sheet-add-account", AddAccountSheet(store: store))
        if let lanes = store.status?.lanes { panel("sheet-lane-editor", LaneEditorSheet(store: store, lanes: lanes)) }
        panel("sheet-apply-checklist", ApplyChecklistSheet(store: store, setup: store.harnessSetup!))
        if let a = store.limits?.accounts.first(where: { $0.resetsAvailable > 0 }) {
            panel("sheet-reset", ResetSheet(store: store, account: a, credits: ResetCredits.parse(["available": 2, "credits": [["id": "cr1", "title": "Weekly limit reset", "description": "Sample credit", "expiresAt": "2026-12-31T12:00:00Z"]]])))
        }
        if let p = store.status?.keyProviders.first(where: { $0.regions.count > 1 }) { panel("sheet-key", KeySheet(store: store, target: .chat(p))) }
        panel("sheet-apply-result", ApplyResultSheet(store: store, result: store.harnessSetup!.summary(applied: "desktop: updated (dshproxy 12)\nRestart DeepSeek Harness to load the new routes.", outcome: .failed, install: HarnessInstall(ok: false, message: "Sample failure.", log: ""), folder: "/sample/integrations/dsh-video")))
        print("render: wrote \(written) PNGs to \(out.path)")
        return 0
    }

    // MARK: Sample data (made up; shaped like the CLI's and the gateway's JSON)

    static let sampleStatus = """
    {"running":true,"origin":"http://127.0.0.1:8417","inFlight":2,"backend":{"name":"CLIProxyAPI","version":"6.9.2"},
     "backendLock":{"version":"6.9.2","previous":null},"update":{"available":true,"current":"6.9.2","latest":"6.10.0","publishedAt":"2026-11-21T13:05:00Z","error":null},
     "discovery":{"fetchedAt":"2026-11-24T00:10:00Z","catalogError":null},
     "modelList":[{"id":"claude-opus-5-6","name":"Claude Opus 5.6","account":"claude","contextWindow":1000000,"maxTokens":128000,"efforts":["low","medium","high"],"isNew":true,"offered":true,"reason":"new"},
      {"id":"claude-sonnet-5-5","name":"Claude Sonnet 5.5","account":"claude","contextWindow":1000000,"maxTokens":64000,"efforts":["low","high"],"isNew":false,"offered":true,"reason":"known"},
      {"id":"gpt-6-astra","name":"GPT-6 Astra","account":"codex","contextWindow":400000,"maxTokens":128000,"efforts":["low","medium","high","xhigh"],"isNew":false,"offered":true,"reason":"known"},
      {"id":"gpt-6-luna","name":"GPT-6 Luna","account":"codex","contextWindow":272000,"maxTokens":64000,"efforts":[],"isNew":false,"offered":false,"reason":"switched off"},
      {"id":"gemini-4-carbon-high","name":"Gemini 4 Carbon","account":"antigravity","contextWindow":2000000,"maxTokens":65000,"efforts":["high"],"isNew":false,"offered":true,"reason":"known"}],
     "suggestions":[{"from":"claude-opus-5-5","to":"claude-opus-5-6","lanes":["main","architect"]}],
     "home":"/Users/sample/.dshproxy","accounts":[{},{},{}],"loginProviders":[{"key":"claude","label":"Claude"},{"key":"codex","label":"ChatGPT (Codex)"},{"key":"antigravity","label":"Gemini (Antigravity)"},{"key":"kimi","label":"Kimi"}],
     "providers":[{"key":"deepseek","label":"DeepSeek","regions":[{"key":"international","label":"Default"}]},{"key":"moonshot","label":"Kimi API (Moonshot)","regions":[{"key":"international","label":"International"},{"key":"china","label":"China"}]},{"key":"zai","label":"GLM (Z.ai)","regions":[{"key":"international","label":"International"},{"key":"china","label":"China"}]},{"key":"openrouter","label":"OpenRouter","regions":[{"key":"global","label":"Default"}]}],
     "apiKeys":{"readable":[{"provider":"deepseek","region":"international"},{"provider":"zai","region":"china"}],"unreadable":["openrouter"]},
     "lanes":[{"name":"main","ladder":[{"model":"gpt-6-astra","available":true,"coolingUntil":null},{"model":"claude-opus-5-5","available":true,"coolingUntil":"2099-01-01T00:00:00Z"},{"model":"gemini-4-carbon-high","available":true,"coolingUntil":null},{"model":"deepseek/deepseek-v4-pro","available":true,"coolingUntil":null}]},
              {"name":"scout","ladder":[{"model":"claude-haiku-5-5","available":true,"coolingUntil":null},{"model":"qwen/qwen3.8-flash","available":false,"coolingUntil":null}]}],
     "routing":{"active":{"name":"balanced","label":"Balanced"},"presets":[{"name":"performance","label":"Max performance","summary":"The strongest model each lane can reach."},{"name":"balanced","label":"Balanced","summary":"Strong models first with cheaper ones as failover. The working default."},{"name":"cheap","label":"Cheap production","summary":"Subscription quota first."}]},
     "models":["lane-main","lane-scout","gpt-6-astra"],
     "deepseekHarness":{"profiles":[{"profile":"desktop","routes":[{"key":"dshproxy","baseURL":"http://127.0.0.1:8417/v1","models":12}],"current":true,"error":null},{"profile":"work","routes":[{"key":"dshproxy","baseURL":"http://127.0.0.1:9999/v1","models":3}],"current":false,"error":null}]}}
    """

    static let sampleLimits = """
    {"fetchedAt":"2026-11-24T00:00:00Z","accounts":[
     {"file":"a.json","provider":"claude","label":"Claude","account":"a@example.com","plan":"max_20x","disabled":false,"windows":[{"title":"5-hour","leftPercent":64,"resetsAt":"2099-01-01T02:00:00Z","reported":true},{"title":"Weekly","leftPercent":27,"resetsAt":null,"reported":true}],"resets":null,"supported":true,"error":null,"primary":true,"siblings":2},
     {"file":"b.json","provider":"claude","label":"Claude","account":"b@example.com","plan":"pro","disabled":true,"windows":[],"resets":null,"supported":true,"error":null,"primary":false,"siblings":2},
     {"file":"c.json","provider":"codex","label":"ChatGPT","account":"c@example.com","plan":"pro","disabled":false,"windows":[{"title":"5-hour","leftPercent":null,"reported":false},{"title":"Weekly","leftPercent":8,"resetsAt":"2099-01-01T00:00:00Z","reported":true}],"resets":{"available":2},"supported":true,"error":null,"primary":false,"siblings":1},
     {"file":"d.json","provider":"kimi","label":"Kimi","account":"d@example.com","plan":"kimi_code","disabled":false,"windows":[],"resets":null,"supported":false,"error":null,"primary":false,"siblings":1}]}
    """

    static let sampleVideo = #"{"models":[{"model":"wan-3.0","enabled":true,"route":"krea","routes":["videorouter","kovapi","krea"]},{"model":"minimax-h3","enabled":true,"route":null,"routes":["kovapi","callirra","krea"]},{"model":"seedance-2.0","enabled":false,"route":null,"routes":["videorouter","kovapi","krea"]}]}"#

    static let sampleKeys = #"{"providers":[{"provider":"videorouter","label":"VideoRouter","variable":"VIDEOROUTER_API_KEY","routes":["videorouter"],"saved":true,"readable":true,"inEnvironment":false},{"provider":"kovapi","label":"KovAPI","variable":"KOVAPI_API_KEY","routes":["kovapi"],"saved":true,"readable":false,"inEnvironment":true},{"provider":"callirra","label":"Callirra","variable":"CALLIRRA_API_KEY","routes":["callirra"],"saved":false,"readable":false,"inEnvironment":false}]}"#

    static let sampleBundle = #"{"harness":"found","harnessRunning":false,"profile":"desktop","profileExists":true,"bundle":"not-installed","folder":"/sample/integrations/dsh-video","linkedTo":null,"version":null,"canInstall":true,"canInstallAfterQuit":false,"reason":""}"#
}

