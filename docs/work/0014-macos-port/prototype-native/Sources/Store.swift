// The prototype's whole state and every action. Nothing here starts a process, opens a
// socket, touches the Keychain, registers a login item or writes a file: every
// "gateway call" changes in-memory data and appends a log line.

import AppKit
import SwiftUI

// MARK: - Alerts (shown as native NSAlerts by AppDelegate; rendered offscreen by Render)

struct AlertButton {
    enum Kind { case safe, confirm, destructive }
    let label: String
    let kind: Kind
    var action: () -> Void = {}
}

struct AlertSpec {
    var title: String
    var message: String
    var style: NSAlert.Style = .warning
    /// The first one is the default button (Return), drawn rightmost.
    /// Confirmations put the safe button first, as the Windows app does.
    var buttons: [AlertButton]
}

// MARK: - Sheets

struct OutputSpec: Equatable {
    var title: String
    var intro: String?
    var text: String
    var footnote: String?
    var good: Bool
}

enum SheetKind: Identifiable, Equatable {
    case addAccount
    case reset(String)                    // account id
    case chatKey(String)                  // provider id
    case videoKey(String)
    case restartWait
    case route(String, enableAfter: Bool) // video model id
    case apply
    case output(OutputSpec)

    var id: String {
        switch self {
        case .addAccount: return "add"
        case .reset(let a): return "reset-\(a)"
        case .chatKey(let p): return "key-\(p)"
        case .videoKey(let p): return "vkey-\(p)"
        case .restartWait: return "restart"
        case .route(let m, let e): return "route-\(m)-\(e)"
        case .apply: return "apply"
        case .output(let o): return "out-\(o.title)"
        }
    }
}

@MainActor
func after(_ seconds: Double, _ f: @escaping @MainActor () -> Void) {
    Task { @MainActor in
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        f()
    }
}

// MARK: - Store

@MainActor
final class AppStore: ObservableObject {
    @Published var gateway: Gateway = .running
    @Published var workspace: Workspace = .chat
    @Published var section: Section = .accounts
    @Published var inFlight = 2
    @Published var loginItem = true          // fake flag only; no login item is registered
    @Published var backend = Backend(current: "6.9.2", latest: "6.10.0", released: "21 Nov 14:05", previous: nil, busy: false)
    @Published var limitsNote = "Limits updated just now. They refresh every minute."
    @Published var harnessChecked = Date()
    @Published var log: [LogLine] = []
    @Published var d = DataSet.sample()
    @Published var sheet: SheetKind?
    @Published var vStatus: String?
    @Published var notice: String?           // transient status message at the bottom of the window
    @Published var checkingModels = false

    /// Set by AppDelegate; Render leaves them empty.
    var presentAlert: (AlertSpec) -> Void = { _ in }
    var openWindow: () -> Void = {}
    var terminate: () -> Void = {}

    private var live = false
    private var startToken = 0
    private var noticeToken = 0
    private var rnd: UInt64 = 1846

    init() { seedLog() }

    var running: Bool { gateway == .running }

    // MARK: Live behaviour (off in render mode)

    func startLive() {
        live = true
        tick()
    }

    private func tick() {
        guard live else { return }
        if running { fakeRequest() }
        after(2.6) { [weak self] in self?.tick() }
    }

    private func next() -> Double {
        rnd = (rnd * 16807) % 2147483647
        return Double(rnd) / 2147483647
    }

    private func fakeRequest() {
        let lane = LANES[Int(next() * Double(LANES.count)) % LANES.count]
        let ladder = d.lanes[lane] ?? []
        let model = ladder.first { laneState($0) == .ok } ?? ladder.first ?? "none"
        let secs = String(format: "%.1f", 0.6 + next() * 9)
        let toks = Int(200 + next() * 4000)
        if next() < 0.08 { addLog("POST /v1/messages lane=\(lane) → \(model) 429 quota; trying next on the ladder", .warn); return }
        addLog("POST /v1/messages lane=\(lane) → \(model) 200 \(secs) s \(toks) tokens out")
    }

    // MARK: Log and notices

    private func seedLog() {
        let base = Date().addingTimeInterval(-6 * 60)
        let lines: [(String, LogLine.Kind)] = [
            ("Starting the gateway...", .action),
            ("CLIProxyAPI 6.9.2 started on 127.0.0.1:8419 (backend)", .plain),
            ("DSHProxy gateway listening on http://127.0.0.1:8417", .plain),
            ("Accounts: 5 (Claude ×2, ChatGPT, Gemini, Kimi paused)", .plain),
            ("Model catalog checked: 1 new model (claude-opus-5-6)", .action),
            ("POST /v1/messages lane=main → gpt-6-astra 200 4.2 s 1830 tokens out", .plain),
            ("POST /v1/messages lane=scout → claude-haiku-5-5 200 1.1 s 412 tokens out", .plain),
            ("POST /v1/messages lane=architect → gpt-6.1-terra 429 quota; trying next on the ladder", .warn),
            ("POST /v1/messages lane=architect → claude-fable-5-2 200 8.7 s 3920 tokens out", .plain),
        ]
        for (i, l) in lines.enumerated() {
            log.append(LogLine(time: Fmt.hms(base.addingTimeInterval(Double(i) * 23)), text: l.0, kind: l.1))
        }
    }

    func addLog(_ text: String, _ kind: LogLine.Kind = .plain) {
        log.append(LogLine(time: Fmt.hms(Date()), text: text, kind: kind))
        if log.count > 400 { log.removeFirst(log.count - 300) }
    }

    func say(_ text: String) {
        notice = text
        noticeToken += 1
        let t = noticeToken
        guard live else { return }
        NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested,
                             userInfo: [.announcement: text, .priority: NSAccessibilityPriorityLevel.medium.rawValue])
        after(4) { [weak self] in if self?.noticeToken == t { self?.notice = nil } }
    }

    // MARK: Gateway

    func startGateway() {
        guard gateway == .stopped else { return }
        addLog("Starting the gateway...", .action)
        gateway = .starting
        startToken += 1
        let t = startToken
        after(1.8) { [weak self] in
            guard let self, self.startToken == t, self.gateway == .starting else { return }
            self.addLog("DSHProxy gateway listening on http://127.0.0.1:8417")
            self.gateway = .running
        }
    }

    func cutText(quit: Bool) -> String? {
        let cuts = quit ? "Quitting stops the gateway now and cuts" : "Stopping the gateway now cuts"
        let ask = quit ? "Quit anyway?" : "Stop anyway?"
        if gateway == .notAnswering {
            return "The gateway did not answer when it was last checked, so requests may be in flight. \(inFlight) model requests were in flight when it last answered. \(cuts) any that are.\n\n\(ask)"
        }
        if gateway == .running && inFlight > 0 {
            return "\(inFlight) model requests were in flight when the gateway was last checked, a few seconds ago at most. \(cuts) them.\n\n\(ask)"
        }
        return nil
    }

    func stopAlert() -> AlertSpec? {
        guard let text = cutText(quit: false) else { return nil }
        return AlertSpec(title: "Stop gateway", message: text, buttons: [
            AlertButton(label: "Cancel", kind: .safe),
            AlertButton(label: "Stop gateway", kind: .destructive) { [weak self] in self?.doStop() },
        ])
    }

    func stopGateway() {
        guard gateway != .stopped else { return }
        if let a = stopAlert() { presentAlert(a) } else { doStop() }
    }

    private func doStop() {
        startToken += 1
        addLog("Stopping the gateway...", .action)
        addLog("Gateway stopped.")
        gateway = .stopped
        sheet = nil
    }

    func quitAlert() -> AlertSpec? {
        guard let text = cutText(quit: true) else { return nil }
        return AlertSpec(title: "Quit DSHProxy", message: text, buttons: [
            AlertButton(label: "Cancel", kind: .safe),
            AlertButton(label: "Quit", kind: .destructive) { [weak self] in self?.terminate() },
        ])
    }

    func quit() {
        if let a = quitAlert() { presentAlert(a) } else { terminate() }
    }

    func needRunningAlert(_ title: String, _ text: String = "Start the gateway first.") -> AlertSpec {
        AlertSpec(title: title, message: text, style: .informational, buttons: [
            AlertButton(label: "Start gateway", kind: .confirm) { [weak self] in self?.startGateway() },
            AlertButton(label: "Cancel", kind: .safe),
        ])
    }

    func needRunning(_ title: String) -> Bool {
        if running { return true }
        presentAlert(needRunningAlert(title))
        return false
    }

    func setLoginItem(_ on: Bool) {
        guard on != loginItem else { return }
        loginItem = on
        addLog("Start at login: \(on ? "on" : "off") (prototype: only a flag; no login item was added or removed).")
    }

    // MARK: Simulation controls (Prototype submenu)

    func simulate(_ g: Gateway) {
        startToken += 1
        gateway = g
        addLog("Prototype: gateway state set to \(g.chipText).", .warn)
    }

    func loadData(empty: Bool) {
        d = empty ? DataSet.empty() : DataSet.sample()
        backend = Backend(current: "6.9.2", latest: "6.10.0", released: "21 Nov 14:05", previous: nil, busy: false)
        addLog(empty ? "Prototype: empty first-run data loaded." : "Prototype: sample data loaded.", .warn)
    }

    // MARK: Navigation

    func go(_ ws: Workspace, _ s: Section) {
        if ws != workspace { vStatus = nil; if ws == .video { d.vRead = Date() } }
        workspace = ws
        section = s
    }

    var lowestLimit: (Account, LimitWindow)? {
        guard running else { return nil }
        var low: (Account, LimitWindow)?
        for a in d.accounts where !a.disabled {
            for w in a.windows { if let l = w.left, l < (low?.1.left ?? 101) { low = (a, w) } }
        }
        return low
    }

    var detailLine: String {
        switch gateway {
        case .running:
            let n = d.accounts.count
            return "http://127.0.0.1:8417  ·  CLIProxyAPI \(backend.current)  ·  \(n) account\(n == 1 ? "" : "s")  ·  \(d.models.filter(\.offered).count) models offered"
        case .starting: return "The gateway is starting."
        case .notAnswering: return "The gateway process is running but does not answer. Stop asks before it cuts anything."
        case .stopped: return "The gateway is not running. Start it from the DSHProxy item in the menu bar."
        }
    }

    // MARK: Accounts

    func addAccount() {
        openWindow()
        guard running else {
            presentAlert(needRunningAlert("Add account", "Start the gateway first. Sign-in runs through it."))
            return
        }
        go(.chat, .accounts)
        sheet = .addAccount
    }

    /// Makes a synthetic account for a finished sign-in and returns its e-mail.
    func signedIn(_ provider: String) -> String {
        let used = Set(d.accounts.map(\.email))
        var email = "f@example.com"
        for c in "fghijklmnopqrstuvw" where !used.contains("\(c)@example.com") { email = "\(c)@example.com"; break }
        let plan = provider == "claude" ? "pro" : provider == "codex" ? "plus" : provider == "kimi" ? "kimi_code" : "google_ai_pro"
        var wins: [LimitWindow] = []
        if provider != "kimi" {
            wins.append(LimitWindow(title: provider == "antigravity" ? "Daily" : "5-hour", left: 100, minutes: 300))
            if provider != "antigravity" { wins.append(LimitWindow(title: "Weekly", left: 100, minutes: 7 * 1440)) }
        }
        d.accounts.append(Account(id: "n\(d.accounts.count + 10)", provider: provider, email: email, plan: plan, primary: false,
                                  disabled: false, supported: provider != "kimi", windows: wins, credits: []))
        addLog("Signed in: \(SERVICES[provider]!.label) (\(email))", .action)
        return email
    }

    func signOutAlert(_ a: Account) -> AlertSpec {
        AlertSpec(title: "Sign out",
                  message: "Sign out of \(a.who)?\n\nDSHProxy stops using this account and deletes its saved sign-in. Lanes move to their other models. You can sign in again at any time.",
                  buttons: [AlertButton(label: "Cancel", kind: .safe),
                            AlertButton(label: "Sign out", kind: .destructive) { [weak self] in
                                guard let self else { return }
                                self.d.accounts.removeAll { $0.id == a.id }
                                self.addLog("Signed out of \(a.who).")
                                self.say("Signed out of \(a.who).")
                            }])
    }

    func togglePause(_ a: Account) {
        guard let i = d.accounts.firstIndex(where: { $0.id == a.id }) else { return }
        d.accounts[i].disabled.toggle()
        if d.accounts[i].disabled { d.accounts[i].primary = false }
        let verb = d.accounts[i].disabled ? "Paused" : "Resumed"
        addLog("\(verb) \(a.who).")
        say("\(verb) \(a.who).")
    }

    func makePrimary(_ a: Account) {
        for i in d.accounts.indices where d.accounts[i].provider == a.provider { d.accounts[i].primary = d.accounts[i].id == a.id }
        addLog("\(a.who) is now the primary account: it is used until it runs out, then the other one takes over.")
        say("\(a.who) is now primary.")
    }

    func notPrimary(_ a: Account) {
        guard let i = d.accounts.firstIndex(where: { $0.id == a.id }) else { return }
        d.accounts[i].primary = false
        addLog("\(a.service.label) has no primary account now: its accounts take turns.")
        say("\(a.service.label) accounts now take turns.")
    }

    func siblings(_ a: Account) -> Int { d.accounts.filter { $0.provider == a.provider }.count }

    func useReset(_ accountID: String, credit: String) {
        guard let i = d.accounts.firstIndex(where: { $0.id == accountID }) else { return }
        d.accounts[i].credits.removeAll { $0.id == credit }
        for w in d.accounts[i].windows.indices where d.accounts[i].windows[w].left != nil { d.accounts[i].windows[w].left = 100 }
        addLog("Limit reset used on ChatGPT (\(d.accounts[i].email)): limits are full again.", .action)
        sheet = nil
        after(0.35) { [weak self] in
            self?.presentAlert(AlertSpec(title: "Limit reset", message: "The reset was used. ChatGPT reports your limits as full again.",
                                         style: .informational, buttons: [AlertButton(label: "OK", kind: .confirm)]))
        }
    }

    func refreshLimits() {
        limitsNote = "Reading limits..."
        after(0.7) { [weak self] in self?.limitsNote = "Limits updated just now. They refresh every minute." }
    }

    func showInFinder(_ what: String) {
        say("Would show \(what) in Finder (prototype: nothing opened).")
    }

    // MARK: Chat API keys

    func saveKey(_ id: String, region: String?) {
        d.keys[id]!.state = .saved
        if let r = region { d.keys[id]!.region = r }
        addLog("key set \(id)\(region.map { " " + $0 } ?? ""): saved (encrypted). Prototype: the key was dropped, not stored.")
        sheet = nil
        restartQuestion("Saved the \(keyProvider(id).label) key.")
    }

    func removeKeyAlert(_ id: String) -> AlertSpec {
        let p = keyProvider(id)
        return AlertSpec(title: "API key", message: "Remove the saved \(p.label) key?", buttons: [
            AlertButton(label: "Cancel", kind: .safe),
            AlertButton(label: "Remove", kind: .destructive) { [weak self] in
                guard let self else { return }
                self.d.keys[id]!.state = .none
                self.addLog("key remove \(id): removed.")
                self.restartQuestion("Removed the \(p.label) key.")
            },
        ])
    }

    func restartAlert(_ what: String) -> AlertSpec {
        let extra = inFlight > 0 ? "\n\n\(inFlight) requests are in flight: the restart waits for a moment with none, at most 5 minutes, and cuts nothing." : ""
        return AlertSpec(title: "Restart gateway?", message: "\(what)\n\nRestart the gateway now so it uses the change?\(extra)", style: .informational, buttons: [
            AlertButton(label: "Restart now", kind: .confirm) { [weak self] in self?.restartNow() },
            AlertButton(label: "Later", kind: .safe) { [weak self] in self?.addLog("The key change is used after the next restart of the gateway.") },
        ])
    }

    func restartQuestion(_ what: String) {
        guard running else { say("\(what) The gateway uses it when it starts."); return }
        // Present after the sheet or the previous alert has gone.
        after(0.35) { [weak self] in guard let self else { return }; self.presentAlert(self.restartAlert(what)) }
    }

    func restartNow() {
        if inFlight == 0 { restartCycle("Restarting the gateway for the key change."); return }
        sheet = .restartWait
    }

    func restartCycle(_ line: String) {
        sheet = nil
        addLog(line, .action)
        gateway = .stopped
        startGateway()
    }

    // MARK: Lanes

    enum LaneState { case ok, cool, bad }

    func laneState(_ m: String) -> LaneState {
        if d.cooling[m] != nil { return .cool }
        let s = serviceOf(m)
        if SERVICES[s] != nil { return d.accounts.contains { $0.provider == s && !$0.disabled } ? .ok : .bad }
        return d.keys[s]?.state == .saved ? .ok : .bad
    }

    func presetAlert(_ id: String) -> AlertSpec {
        let p = presetNamed(id)!
        return AlertSpec(title: "Routing preset",
                         message: "Use the \(p.label) routing preset?\n\nThis replaces the ladders of all lanes. You can switch back or edit them at any time.",
                         style: .informational, buttons: [
                            AlertButton(label: "Cancel", kind: .safe),
                            AlertButton(label: "Use \(p.label)", kind: .confirm) { [weak self] in
                                guard let self else { return }
                                self.d.preset = id
                                self.d.lanes = p.lanes
                                self.addLog("Routing preset: \(p.label).")
                                self.addLog("DeepSeek Harness routes updated. Restart DeepSeek Harness to see them.")
                                self.say("Routing preset: \(p.label).")
                            },
                         ])
    }

    func choosePreset(_ id: String) {
        guard id != d.preset, id != "custom" else { return }
        guard needRunning("Routing preset") else { return }
        presentAlert(presetAlert(id))
    }

    func editLanesAlert() -> AlertSpec {
        AlertSpec(title: "Lanes",
                  message: "Opens settings.json in your text editor.\n\nPrototype: no editor opens. Continue to pretend the ladders were edited (the routing then shows as Custom).",
                  style: .informational, buttons: [
                    AlertButton(label: "Cancel", kind: .safe),
                    AlertButton(label: "Pretend edited", kind: .confirm) { [weak self] in
                        guard let self else { return }
                        self.d.lanes["main"] = ["claude-opus-5-5", "gpt-6-astra", "claude-fable-5-2", "deepseek/deepseek-v4-pro"]
                        self.d.preset = "custom"
                        self.addLog("settings.json changed: routing is now Custom.")
                    },
                  ])
    }

    // MARK: Models

    func setOffered(_ id: String, _ on: Bool) {
        guard let i = d.models.firstIndex(where: { $0.id == id }), d.models[i].offered != on else { return }
        guard needRunning("Models") else { return }
        d.models[i].offered = on
        d.models[i].reason = on ? "user-on" : "user-off"
        addLog("\(on ? "Offering" : "No longer offering") \(id); DeepSeek Harness routes updated. Restart DeepSeek Harness to see it.")
        say("\(id) \(on ? "offered" : "switched off").")
    }

    func suggestionLanes() -> [String] {
        guard let s = d.suggestion else { return [] }
        return LANES.filter { (d.lanes[$0] ?? []).contains(s.from) }
    }

    func suggestionAlert() -> AlertSpec? {
        guard let s = d.suggestion else { return nil }
        let lanes = suggestionLanes()
        return AlertSpec(title: "Lanes",
                         message: "Put \(s.to) in place of \(s.from) on lane \(lanes.joined(separator: ", "))?\n\nThe rest of each ladder stays as it is. You can change it back in settings.json.",
                         style: .informational, buttons: [
                            AlertButton(label: "Cancel", kind: .safe),
                            AlertButton(label: "Use \(s.to)", kind: .confirm) { [weak self] in
                                guard let self else { return }
                                for l in lanes { self.d.lanes[l] = self.d.lanes[l]!.map { $0 == s.from ? s.to : $0 } }
                                self.d.preset = "custom"
                                self.d.suggestion = nil
                                if let i = self.d.models.firstIndex(where: { $0.id == s.to }) { self.d.models[i].reason = "auto" }
                                self.addLog("\(s.to) now replaces \(s.from) on lane \(lanes.joined(separator: ", ")).")
                                self.say("\(s.to) now replaces \(s.from).")
                            },
                         ])
    }

    func checkModels() {
        guard needRunning("Models") else { return }
        checkingModels = true
        after(0.9) { [weak self] in
            guard let self else { return }
            self.checkingModels = false
            self.d.modelsChecked = 0
            self.addLog("Checked for new models; nothing new since the last check.")
            self.say("Checked for new models: nothing new.")
        }
    }

    // MARK: DeepSeek Harness

    var offeredCount: Int { d.models.filter(\.offered).count }

    func previewSpec() -> OutputSpec {
        let text: String
        if d.profiles.isEmpty {
            text = "No DeepSeek Harness profile found. Open DeepSeek Harness once, then preview again."
        } else {
            text = d.profiles.map { p in
                p.points == "yes" ? "Profile \(p.name): up to date, nothing to change."
                    : "Profile \(p.name): would write 6 routes and \(offeredCount) models\n  + route dshproxy-main  → http://127.0.0.1:8417/v1 (model lane-main)\n  + route dshproxy-scout → http://127.0.0.1:8417/v1 (model lane-scout)\n  ~ default model: lane-main\n  (backup first; nothing else changes)"
            }.joined(separator: "\n\n")
        }
        return OutputSpec(title: "Preview", intro: "dsh apply --dry-run (synthetic output):", text: text, footnote: nil, good: true)
    }

    func verifySpec() -> OutputSpec {
        let bad = d.profiles.filter { $0.points != "yes" }
        let text = d.profiles.isEmpty ? "✗ No DeepSeek Harness profile found." : d.profiles.map { p in
            p.points == "yes" ? "✓ \(p.name): routes, models, default model and credential match."
                : p.points == "stale" ? "✗ \(p.name): 2 routes point at an older model list. Apply again."
                : "✗ \(p.name): no DSHProxy routes."
        }.joined(separator: "\n")
        let ok = bad.isEmpty && !d.profiles.isEmpty
        return OutputSpec(title: "Verify DeepSeek Harness", intro: nil, text: text,
                          footnote: ok ? nil : "Press Apply to DeepSeek Harness at the top to fix it.", good: ok)
    }

    func verify() {
        let s = verifySpec()
        addLog("dsh verify: " + (s.good ? "all profiles match" : "problems found"), s.good ? .plain : .warn)
        sheet = .output(s)
    }

    func removeHarnessAlert() -> AlertSpec {
        AlertSpec(title: "DeepSeek Harness", message: "Remove the DSHProxy routes from every DeepSeek Harness profile?", buttons: [
            AlertButton(label: "Cancel", kind: .safe),
            AlertButton(label: "Remove routes", kind: .destructive) { [weak self] in
                guard let self else { return }
                for i in self.d.profiles.indices { self.d.profiles[i].points = "none" }
                self.addLog("dsh remove: DSHProxy routes removed from every profile.")
                let text = self.d.profiles.map { "Profile \($0.name): DSHProxy routes removed (backup kept)." }.joined(separator: "\n")
                after(0.35) { [weak self] in
                    self?.sheet = .output(OutputSpec(title: "DeepSeek Harness", intro: nil, text: text,
                                                     footnote: "Restart DeepSeek Harness to see the change.", good: true))
                }
            },
        ])
    }

    struct CheckItem: Hashable { enum Mark { case ok, todo, no, note }; let mark: Mark; let text: String; let sub: String? }

    func applyChecklist() -> [CheckItem] {
        let toolsTodo = d.videoTools != .installed
        return [
            CheckItem(mark: .ok, text: "DeepSeek Harness is installed and has been opened once.", sub: nil),
            CheckItem(mark: .todo, text: "The chat routes will be written into every DeepSeek Harness profile.",
                      sub: "Each profile is backed up first. Nothing else in it is changed."),
            toolsTodo ? CheckItem(mark: .todo, text: "The video tools will be installed in DeepSeek Harness.",
                                  sub: "Only while DeepSeek Harness is closed; Apply waits for you to quit it.")
                      : CheckItem(mark: .ok, text: "The video tools are installed and switched on.", sub: nil),
            CheckItem(mark: .note, text: "Restart DeepSeek Harness afterwards. DSHProxy does not do that for you.", sub: nil),
        ]
    }

    /// Runs the fake `dsh apply`; returns the output lines it "reported".
    func applyNow() -> [String] {
        let toolsTodo = d.videoTools != .installed
        let n = offeredCount
        if d.profiles.isEmpty {
            d.profiles = [Profile(name: "desktop", routes: 6, models: n, points: "yes")]
        } else {
            for i in d.profiles.indices { d.profiles[i].points = "yes"; d.profiles[i].routes = 6; d.profiles[i].models = n }
        }
        d.videoTools = .installed
        harnessChecked = Date()
        var out = ["Profile desktop: backed up to profiles/desktop.json.bak-20261123",
                   "Profile desktop: 6 routes, \(n) models, default model main"]
        if d.profiles.count > 1 { out += ["Profile work: backed up", "Profile work: 6 routes written"] }
        out += ["Credential: points at http://127.0.0.1:8417",
                toolsTodo ? "Video tools: installed in DeepSeek Harness." : "Video tools: already installed."]
        for l in out { addLog("dsh apply: " + l) }
        return out
    }

    // MARK: Backend update

    func updateAlert() -> AlertSpec? {
        guard let v = backend.latest else { return nil }
        return AlertSpec(title: "Update CLIProxyAPI",
                         message: "Update the backend to CLIProxyAPI \(v)?\n\n1. Download it and check it against the release's published checksum.\n2. Start it on a spare port and send one short request through each signed-in account (uses a tiny bit of quota).\n3. Only if that passes: restart DSHProxy on \(v), about 5 seconds offline.\n\nIf anything fails, DSHProxy stays on the version you have.",
                         style: .informational, buttons: [
                            AlertButton(label: "Cancel", kind: .safe),
                            AlertButton(label: "Update", kind: .confirm) { [weak self] in self?.runUpdate(v) },
                         ])
    }

    private func runUpdate(_ v: String) {
        backend.busy = true
        addLog("Downloading CLIProxyAPI \(v)...", .action)
        after(2.2) { [weak self] in
            guard let self else { return }
            let checks = self.d.accounts.filter { !$0.disabled }.map { "• \($0.who): answered" }
            self.backend.busy = false
            self.backend.previous = self.backend.current
            self.backend.current = v
            self.backend.latest = nil
            self.addLog("CLIProxyAPI \(v): trial run passed; restarting.", .action)
            self.presentAlert(AlertSpec(title: "Update CLIProxyAPI",
                                        message: "CLIProxyAPI \(v) passed its trial run.\n\nTrial run:\n\(checks.isEmpty ? "• no signed-in account to try" : checks.joined(separator: "\n"))\n\nDSHProxy is restarting on the new version.",
                                        style: .informational, buttons: [AlertButton(label: "OK", kind: .confirm)]))
            self.gateway = .starting
            after(1.5) { [weak self] in if self?.gateway == .starting { self?.gateway = .running } }
        }
    }

    func rollbackAlert() -> AlertSpec? {
        guard let prev = backend.previous else { return nil }
        return AlertSpec(title: "Roll back", message: "Go back to CLIProxyAPI \(prev)?\n\nDSHProxy restarts, about 5 seconds offline.",
                         style: .informational, buttons: [
                            AlertButton(label: "Cancel", kind: .safe),
                            AlertButton(label: "Roll back", kind: .confirm) { [weak self] in
                                guard let self else { return }
                                self.addLog("Rolled back to CLIProxyAPI \(prev).")
                                self.backend.latest = self.backend.current
                                self.backend.current = prev
                                self.backend.previous = nil
                                self.gateway = .starting
                                after(1.5) { [weak self] in if self?.gateway == .starting { self?.gateway = .running } }
                            },
                         ])
    }

    // MARK: Video

    func kreaSignIn() {
        d.krea = .signing
        addLog("Krea: helper started; consent page opened in the browser (prototype: nothing opened).", .action)
    }

    func kreaCancel() {
        d.krea = .none
        addLog("Krea sign-in cancelled: the helper was stopped.")
    }

    func kreaFinish(_ ok: Bool) {
        if ok {
            d.krea = .signedIn(Date().addingTimeInterval(90 * 86400))
            addLog("Signed in to Krea.", .action)
            say("Signed in to Krea.")
        } else {
            d.krea = .none
            addLog("Krea sign-in did not complete (KREA_REFUSED): consent was refused in the browser.", .error)
            say("Krea sign-in did not complete.")
        }
        d.vRead = Date()
    }

    func kreaSignOutAlert() -> AlertSpec {
        AlertSpec(title: "Krea",
                  message: "Sign out of Krea?\n\nThe Krea sign-in stored on this computer is removed. Video on the Krea workspace route then needs a new sign-in.",
                  buttons: [AlertButton(label: "Cancel", kind: .safe),
                            AlertButton(label: "Sign out", kind: .destructive) { [weak self] in
                                self?.d.krea = .none
                                self?.addLog("Signed out of Krea.")
                            }])
    }

    /// The local check of the Windows app: at most 512 printable ASCII characters, no spaces.
    static func videoKeyError(_ v: String) -> String? {
        if v.count > 512 { return "The key is longer than 512 characters." }
        if v.unicodeScalars.contains(where: { $0.value < 0x21 || $0.value > 0x7E }) {
            return "The key may only contain printable characters without spaces."
        }
        return nil
    }

    func saveVideoKey(_ id: String) {
        d.vkeys[id]!.state = .saved
        let p = vkeyProvider(id)
        addLog("video key set \(id): saved. Prototype: the key was dropped, not stored.")
        sheet = nil
        say("Saved the \(p.label) key. It was not checked against \(p.label).")
    }

    func removeVideoKeyAlert(_ id: String) -> AlertSpec {
        let p = vkeyProvider(id)
        return AlertSpec(title: "Video API key",
                         message: "Remove the saved \(p.label) video key?\n\nDSHProxy's video command can then use \(p.label) only with a key in \(p.variable).",
                         buttons: [AlertButton(label: "Cancel", kind: .safe),
                                   AlertButton(label: "Remove", kind: .destructive) { [weak self] in
                                       self?.d.vkeys[id]!.state = .none
                                       self?.addLog("video key remove \(id): removed.")
                                   }])
    }

    func saveRoute(_ id: String, route: String, enable: Bool) {
        guard let i = d.vmodels.firstIndex(where: { $0.id == id }) else { return }
        d.vmodels[i].route = route
        if enable { d.vmodels[i].enabled = true }
        let m = d.vmodels[i]
        vStatus = "Saved: \(m.id) → \(route), \(m.enabled ? "enabled" : "disabled"). This is a setting only; nothing was checked or charged."
        addLog("video settings set \(m.id.uppercased()) \(route.uppercased()) \(m.enabled ? "enabled" : "disabled")")
        sheet = nil
    }

    func setVideoEnabled(_ id: String, _ on: Bool) {
        guard let i = d.vmodels.firstIndex(where: { $0.id == id }), d.vmodels[i].enabled != on else { return }
        let m = d.vmodels[i]
        if on && !m.validRoute { sheet = .route(id, enableAfter: true); return }
        d.vmodels[i].enabled = on
        vStatus = "Saved: \(m.id) \(on ? "enabled" : "disabled")\(m.route.map { " on " + $0 } ?? ""). This is a setting only; nothing was checked or charged."
        let route = (on || m.validRoute) ? (m.route ?? "none") : "none"
        addLog("video settings set \(m.id.uppercased()) \(route.uppercased()) \(on ? "enabled" : "disabled")")
    }

    func reloadVideo() {
        vStatus = "Reading video settings..."
        after(0.5) { [weak self] in self?.vStatus = nil; self?.d.vRead = Date() }
    }

    var videoStatusLine: String { vStatus ?? "Video settings read from DSHProxy at \(Fmt.hms(d.vRead))." }
}
