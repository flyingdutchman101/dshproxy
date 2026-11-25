// The app's state and every action. Everything it does to DSHProxy goes through DSHProxyKit: the gateway
// through GatewayProcess, the status through StatusProbe and `status --json`, the control API through
// ControlClient, the CLI through CommandRunner (keys on standard input only). Behaviour and texts follow the
// Windows app (docs/work/0014-macos-port/research/app-inventory.md); the prototype's accepted differences
// (prototype-native/README.md) are kept. In render mode (`kit == nil`) nothing is started or called.

import AppKit
import DSHProxyKit
import SwiftUI

// MARK: - Alerts and sheets

struct AlertButton {
    enum Kind { case safe, confirm, destructive }
    let label: String
    let kind: Kind
}

struct AlertSpec {
    var title: String
    var message: String
    var style: NSAlert.Style = .warning
    /// The first one is the default button (Return). Confirmations put the safe button first, as the Windows
    /// app defaults to No.
    var buttons: [AlertButton]
}

struct OutputSpec: Equatable {
    var title: String
    var intro: String?
    var text: String
    var footnote: String?
    var good: Bool
}

enum SheetKind: Identifiable, Equatable {
    case addAccount
    case laneEditor([Lane])
    case reset(AccountLimits, ResetCredits)
    case chatKey(KeyProvider)
    case videoKey(VideoKeyProvider)
    case restartWait
    case route(VideoModel, enable: Bool)
    case applyChecklist(HarnessSetup)
    case applyBusy(String)
    case harnessWait
    case applyResult(SetupResult)
    case output(OutputSpec)

    var id: String {
        switch self {
        case .addAccount: return "add"
        case .laneEditor: return "lane-editor"
        case .reset(let a, _): return "reset-\(a.file)"
        case .chatKey(let p): return "key-\(p.key)"
        case .videoKey(let p): return "vkey-\(p.id)"
        case .restartWait: return "restart"
        case .route(let m, let e): return "route-\(m.id)-\(e)"
        case .applyChecklist: return "apply"
        case .applyBusy(let t): return "apply-busy-\(t)"
        case .harnessWait: return "harness-wait"
        case .applyResult(let r): return "apply-result-\(r.heading)"
        case .output(let o): return "out-\(o.title)-\(o.text.hashValue)"
        }
    }
}

/// A control call's answer, or its one-sentence error.
enum CallResult {
    case success([String: Any])
    case failure(String)
}

enum LoginStartResult {
    case success(LoginStart)
    case failure(String)
}

enum LimitsState: Equatable { case none, reading, failed(String), updated(Date) }

// MARK: - Store

@MainActor
final class AppStore: ObservableObject {
    struct Kit {
        let locations: Locations
        let runner: CommandRunner
        let gateway: GatewayProcess
    }

    static let defaultOrigin = "http://127.0.0.1:8417"

    let kit: Kit?
    /// Render mode: sample data, nothing started or called.
    var isSample: Bool { kit == nil }

    @Published var gateway: Gateway = .starting
    @Published var statusUnavailable: String?
    @Published var status: FullStatus?
    @Published var inFlight = 0
    @Published var limits: LimitsReport?
    @Published var limitsState: LimitsState = .none
    @Published var workspace: Workspace = .chat
    @Published var section: Section = .accounts
    @Published var sheet: SheetKind?
    @Published var log: [LogLine] = []
    @Published var notice: String?
    @Published var busy = 0
    @Published var now = Date()
    @Published var showHidden = false
    @Published var checkingModels = false
    @Published var updateBusy = false
    /// Ticks changed here whose answer has not come back in a status yet.
    @Published var pendingTicks: [String: Bool] = [:]
    @Published var restartCancelling = false
    /// The gateway answers but was not started by this app.
    @Published var foreign = false

    // Video
    @Published var videoModels: [VideoModel]?
    @Published var videoError: String?
    @Published var videoStatus: (text: String, tone: Tone) = ("Video settings have not been read yet.", .muted)
    @Published var videoBusy = false
    @Published var videoKeys: [VideoKeyProvider]?
    @Published var videoKeysStatus: (text: String, tone: Tone)?
    @Published var krea: KreaStatus?
    @Published var kreaState = "Not read yet"
    @Published var kreaTone: Tone = .muted
    @Published var kreaReadAt: Date?
    /// Start at login (inventory 1.7, 4.3): a LaunchAgent that opens this app with --hidden.
    @Published var startAtLogin = false
    var loginItem: LoginItem? {
        guard kit != nil, let exe = Bundle.main.executableURL else { return nil }
        return LoginItem(agentsFolder: LoginItem.userAgentsFolder(), executable: exe)
    }
    func readStartAtLogin() { startAtLogin = loginItem?.isOn ?? false }
    func setStartAtLogin(_ on: Bool) {
        guard let item = loginItem else { return }
        do {
            if on { try item.turnOn() } else { try item.turnOff() }
            addLog(on ? "Start at login: on." : "Start at login: off.")
        } catch {
            addLog("\(error)", .warn)
            say("\(error)")
        }
        readStartAtLogin()
    }

    /// The Krea sign-in in progress (inventory 2.7), nil otherwise.
    @Published var kreaSignIn: StreamingCommand?
    @Published var harnessSetup: HarnessSetup?
    @Published var harnessReadAt: Date?
    @Published var applying = false

    /// Set by AppDelegate.
    var presentAlert: (AlertSpec, @escaping (Int) -> Void) -> Void = { _, done in done(-1) }
    var openWindow: () -> Void = {}
    var checkAppUpdate: () -> Void = {}
    var windowVisible = false { didSet { if windowVisible && !oldValue { refreshStatus() } } }

    // Gateway and polling state (inventory 1.11, 1.12)
    private(set) var origin = URL(string: AppStore.defaultOrigin)!
    private var originKnown = false
    private var running = false
    private var ownStartedAt: Date?
    private var ownAnswered = false
    private var fastUp = false
    private var fastMisses = 0
    private var fastPrint: String?
    private var fastRunning = false
    private var nextFast = Date.distantPast
    private var fastUntil = Date.distantPast
    private var fullRunning = false
    private var fullWanted = false
    private var fullNotBefore = Date.distantPast
    private var lastFull = Date.distantPast
    private var failedPolls = 0
    var limitsAt: Date?
    private var confirmingCut = false
    private var userStopping = false
    private var lateStopUntil: Date?
    private var idleStop: IdleStop?
    private var ticker: Task<Void, Never>?
    private var noticeToken = 0
    private var logChars = 0
    private(set) var quitting = false
    /// The first status and start are under way: the header keeps saying Starting.
    private var launching = false
    var readyToQuit = false

    init(kit: Kit?) {
        self.kit = kit
        guard let kit else { return }
        Logos.folder = kit.locations.checkout
        readStartAtLogin()
        kit.gateway.onOutput = { [weak self] line in
            Task { @MainActor in self?.addLog(line) }
        }
        kit.gateway.onExit = { [weak self] code in
            Task { @MainActor in self?.gatewayExited(code) }
        }
    }

    var isRunning: Bool { gateway == .running }
    var home: URL? { kit?.locations.home }
    var ownAlive: Bool { kit?.gateway.ownPID != nil }

    /// The menu's first line: the state, or that the status cannot be read.
    var menuStatusText: String { statusUnavailable != nil ? "DSHProxy: status unavailable" : gateway.menuText }

    // MARK: Start-up

    /// Reads the status (for the address), starts the gateway as the Windows app does, then keeps checking.
    func launch() {
        guard kit != nil else { return }
        launching = true
        Task {
            await fullStatus()
            // Keep ownership in this desktop so Stop/Quit work after relaunch.
            let env = ProcessInfo.processInfo.environment
            if env["DSHPROXY_UPDATE_SESSION"] == nil || env["DSHPROXY_UPDATE_RESUME"] == "1" { await startGateway() }
            launching = false
        }
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 250_000_000)
                self?.tick()
            }
        }
    }

    private func tick() {
        let current = Date()
        if current.timeIntervalSince(now) >= 15 { now = current }
        guard !quitting else { return }
        if originKnown && !fastRunning && current >= nextFast { Task { await fastCheck() } }
        if !fullRunning {
            let periodic = lastFull.addingTimeInterval(windowVisible ? 60 : 600)
            let retry = failedPolls >= 3 ? lastFull.addingTimeInterval(15) : lastFull
            if (fullWanted && current >= max(fullNotBefore, retry)) || current >= periodic { Task { await fullStatus() } }
        }
        // Limits every 60 s while Accounts is on screen.
        if windowVisible && workspace == .chat && section == .accounts && isRunning && limitsState != .reading,
           current.timeIntervalSince(limitsAt ?? .distantPast) >= 60 {
            Task { await loadLimits(force: false) }
        }
    }

    private func pace() -> TimeInterval {
        if (fastMisses > 0 && fastMisses < 3) || Date() < fastUntil { return 0.25 }
        return windowVisible ? 3 : 15
    }

    // MARK: Status

    /// A full status as soon as one may run.
    func refreshStatus() {
        guard kit != nil else { return }
        fullWanted = true
    }

    /// A full status, no sooner than 10 s after the last one.
    private func refreshStatusSoon() {
        fullWanted = true
        fullNotBefore = max(fullNotBefore, lastFull.addingTimeInterval(10))
    }

    private func fullStatus() async {
        guard let kit, !fullRunning else { return }
        fullRunning = true
        fullWanted = false
        lastFull = Date()
        let result = await kit.runner.run(["status", "--json"], timeout: 20)
        fullRunning = false
        showStatus(result)
    }

    private func showStatus(_ result: CommandResult) {
        guard result.code == 0, let parsed = FullStatus.parse(result.stdout) else {
            failedPolls += 1
            fullWanted = true
            if failedPolls >= 3 {
                let text = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                statusUnavailable = text.isEmpty ? (result.timedOut ? "The status command did not finish within 20 seconds." : "The status could not be read.") : text
            }
            return
        }
        failedPolls = 0
        statusUnavailable = nil
        let sameOrigin = parsed.origin == origin.absoluteString
        // One slow answer there does not flip the display while the fast check sees the gateway.
        if !parsed.running && fastUp && sameOrigin {
            refreshStatusSoon()
            return
        }
        let wasRunning = running
        running = parsed.running
        if !sameOrigin, let url = URL(string: parsed.origin), !parsed.origin.isEmpty {
            fastUp = false; fastMisses = 0; fastPrint = nil; inFlight = 0
            origin = url
        }
        originKnown = !parsed.origin.isEmpty
        if !fastUp && (running || !ownAlive) { inFlight = parsed.inFlight }
        pendingTicks = [:]
        status = parsed
        foreign = running && !ownAlive
        if launching && !running { return }
        showGateway(answers: running)
        if running && !wasRunning { Task { await loadLimits(force: false) } }
    }

    private func fastCheck() async {
        guard !fastRunning, originKnown else { return }
        fastRunning = true
        let asked = origin
        let answer = await StatusProbe.fetch(origin: asked, timeout: 2)
        fastRunning = false
        nextFast = Date().addingTimeInterval(pace())
        guard asked == origin, !quitting else { return }
        guard let answer else {
            if fastMisses < 3 { fastMisses += 1 }
            if fastMisses >= 3 {
                fastUp = false
                fastPrint = nil
                if !ownAlive { inFlight = 0 }
                if running || gateway == .running {
                    running = false
                    showGateway(answers: false)
                    refreshStatusSoon()
                }
            }
            if gateway == .starting { showGateway(answers: false) }
            nextFast = Date().addingTimeInterval(pace())
            return
        }
        let wasUp = fastUp
        fastUp = true
        fastMisses = 0
        if ownAlive { ownAnswered = true }
        let read = FastStatus.read(answer)
        if fastPrint == nil { fastPrint = read.print }
        else if read.print != fastPrint {
            fastPrint = read.print
            refreshStatus()
        }
        inFlight = read.inFlight
        if gateway != .running && ownAlive {
            running = true
            showGateway(answers: true)
            Task { await loadLimits(force: false) }
            refreshStatus()
        }
        if !running {
            if !wasUp { refreshStatus() } else { refreshStatusSoon() }
        }
        nextFast = Date().addingTimeInterval(pace())
    }

    /// The four states (A:2016-2074).
    private func showGateway(answers: Bool) {
        let alive = !answers && ownAlive
        let late = alive && !ownAnswered && Date().timeIntervalSince(ownStartedAt ?? .distantPast) >= 30
        let shown: Gateway = answers ? .running : !alive ? .stopped : (ownAnswered || late) ? .notAnswering : .starting
        if !answers { running = false }
        if shown != gateway { gateway = shown }
        if shown == .stopped { foreign = false }
    }

    // MARK: Start, stop, quit

    func startGateway() async {
        guard let kit, !quitting else { return }
        lateStopUntil = nil
        if ownAlive { return }
        let outcome = await kit.gateway.start(origin: origin)
        switch outcome {
        case .alreadyRunning:
            if !ownAlive { addLog("A gateway is already running on \(origin.absoluteString); showing its status.", .action) }
            refreshStatus()
        case .started:
            addLog("Starting the gateway...", .action)
            ownStartedAt = Date()
            ownAnswered = false
            fastUntil = Date().addingTimeInterval(10)
            nextFast = Date()
            originKnown = true
            showGateway(answers: false)
            refreshStatus()
        case .failed(let message):
            addLog("Could not start the gateway: \(message)", .error)
            launching = false
            showGateway(answers: running)
            await inform("Start gateway", "Could not start the gateway: \(message)", style: .critical)
        }
    }

    private func gatewayExited(_ code: Int32) {
        addLog("Gateway stopped.", .action)
        inFlight = 0
        fastUntil = Date().addingTimeInterval(10)
        nextFast = Date()
        if gateway != .running { showGateway(answers: false) }
        refreshStatus()
        // A gateway asked to stop when idle that was left running, and stopped after all: started again once.
        if let until = lateStopUntil, Date() < until, !userStopping, !quitting {
            lateStopUntil = nil
            Task {
                await startGateway()
                if ownAlive { addLog("The gateway had already begun to stop; it was started again.", .action) }
            }
        }
    }

    func stopRequested() {
        Task { await stopGateway(confirm: true) }
    }

    /// Only a gateway this app started; a foreign one is said to be so (A:1718-1743).
    func stopGateway(confirm: Bool) async {
        guard let kit else { return }
        guard ownAlive else {
            if gateway != .stopped {
                let text = "The running gateway was not started by this app. Stop it where it was started."
                addLog(text, .warn)
                await inform("Stop gateway", text)
            }
            return
        }
        if confirm, !(await confirmCut(quitting: false)) { return }
        lateStopUntil = nil
        userStopping = true
        addLog("Stopping the gateway...", .action)
        fastUntil = Date().addingTimeInterval(10)
        _ = await kit.gateway.stop()
        userStopping = false
        inFlight = 0
        showGateway(answers: false)
        refreshStatus()
    }

    /// Stop and Quit ask first when requests were in flight or the gateway did not answer (A:4241-4256).
    func confirmCut(quitting isQuitting: Bool) async -> Bool {
        guard ownAlive else { return true }
        let unanswered = gateway != .running
        if inFlight <= 0 && !unanswered { return true }
        if confirmingCut { return false }
        confirmingCut = true
        defer { confirmingCut = false }
        let answer = await ask(AlertSpec(title: isQuitting ? "Quit DSHProxy" : "Stop gateway",
                                         message: InFlight.cutQuestion(count: inFlight, unanswered: unanswered, quitting: isQuitting),
                                         buttons: [AlertButton(label: "Cancel", kind: .safe),
                                                   AlertButton(label: isQuitting ? "Quit" : "Stop gateway", kind: .destructive)]))
        return answer == 1
    }

    /// Quit: asks as Stop does, ends a waiting restart, stops this app's own gateway. True: terminate.
    func prepareQuit() async -> Bool {
        if quitting { return false }
        if !(await confirmCut(quitting: true)) { return false }
        quitting = true
        ticker?.cancel()
        idleStop?.cancel()
        lateStopUntil = nil
        // A waiting Krea sign-in is ended before quitting, so it cannot save a sign-in afterwards (A:1576-1591).
        if kreaSignIn != nil {
            kreaSignIn?.cancel()
            for _ in 0..<50 where kreaSignIn != nil { try? await Task.sleep(nanoseconds: 100_000_000) }
        }
        if let kit { _ = await kit.gateway.stop() }
        return true
    }

    // MARK: Restart for a key change (A:4043-4232)

    func offerRestartForChange(output: String, title: String) async {
        let answer = await ask(AlertSpec(title: title, message: InFlight.restartOffer(output: output, inFlight: inFlight), style: .informational,
                                         buttons: [AlertButton(label: "Restart now", kind: .confirm), AlertButton(label: "Later", kind: .safe)]))
        if answer == 0 { await restartForChange(title: title) }
        else { addLog("The key change is used after the next restart of the gateway.") }
    }

    private func restartForChange(title: String) async {
        guard let kit, ownAlive, idleStop == nil else { return }
        if inFlight <= 0 && gateway == .running {
            await stopGateway(confirm: false)
            await startGateway()
            return
        }
        let stop = IdleStop(runner: kit.runner)
        idleStop = stop
        restartCancelling = false
        sheet = .restartWait
        addLog("Restart: waiting for the requests in flight to finish, at most 5 minutes.", .action)
        let outcome = await stop.run()
        idleStop = nil
        if case .restartWait = sheet { sheet = nil }
        if quitting { return }
        if outcome == .stopped {
            // A gateway that stopped ends its own process a moment later.
            for _ in 0..<60 where ownAlive { try? await Task.sleep(nanoseconds: 250_000_000) }
        }
        let gone = !ownAlive
        switch outcome {
        case .stopped:
            if !gone { await stopGateway(confirm: false) }
            inFlight = 0
            addLog("Restart: the gateway stopped at a moment with nothing in flight. Starting it again.", .action)
            await startGateway()
        case .stillBusy(let count):
            lateStopUntil = Date().addingTimeInterval(30)
            addLog("Restart: requests were still running after 5 minutes. Nothing was restarted.", .warn)
            await inform(title, InFlight.stillBusy(count))
        case .cancelled:
            if gone {
                inFlight = 0
                addLog("Restart: the gateway had already stopped when the wait was cancelled. Starting it again.", .action)
                await startGateway()
                return
            }
            lateStopUntil = Date().addingTimeInterval(30)
            addLog("Restart cancelled: the gateway keeps running. The key change is used after the next restart.")
        case .failed(let message):
            if gone {
                inFlight = 0
                addLog("Restart: the gateway has stopped (\(message)). Starting it again.", .action)
                await startGateway()
                return
            }
            lateStopUntil = Date().addingTimeInterval(30)
            addLog("Restart: the gateway could not be asked to stop at an idle moment: \(message)", .warn)
            let unanswered = gateway != .running
            var cut = inFlight <= 0 && !unanswered
            if !cut {
                cut = await ask(AlertSpec(title: title, message: "The gateway could not be asked to wait for an idle moment:\n\(message)\n\n" + InFlight.restartQuestion(count: inFlight, unanswered: unanswered),
                                          buttons: [AlertButton(label: "Cancel", kind: .safe), AlertButton(label: "Restart anyway", kind: .destructive)])) == 1
            }
            if quitting || !ownAlive { return }
            if !cut { addLog("Restart: not restarted. The key change is used after the next restart."); return }
            await stopGateway(confirm: false)
            await startGateway()
        }
    }

    func cancelRestart() {
        restartCancelling = true
        idleStop?.cancel()
    }

    // MARK: Alerts, log, notices

    func ask(_ spec: AlertSpec) async -> Int {
        await withCheckedContinuation { continuation in
            presentAlert(spec) { continuation.resume(returning: $0) }
        }
    }

    func inform(_ title: String, _ message: String, style: NSAlert.Style = .informational) async {
        _ = await ask(AlertSpec(title: title, message: message, style: style, buttons: [AlertButton(label: "OK", kind: .confirm)]))
    }

    func confirm(_ title: String, _ message: String, yes: String, destructive: Bool = true, style: NSAlert.Style = .warning) async -> Bool {
        await ask(AlertSpec(title: title, message: message, style: style,
                            buttons: [AlertButton(label: "Cancel", kind: .safe), AlertButton(label: yes, kind: destructive ? .destructive : .confirm)])) == 1
    }

    /// "Start the gateway first." with a way to start it (prototype).
    func needRunning(_ title: String, _ text: String = "Start the gateway first.") async -> Bool {
        if isRunning { return true }
        let answer = await ask(AlertSpec(title: title, message: text, style: .informational,
                                         buttons: [AlertButton(label: "Start gateway", kind: .confirm), AlertButton(label: "Cancel", kind: .safe)]))
        if answer == 0 && gateway == .stopped { await startGateway() }
        return false
    }

    /// Appends lines; above 400,000 characters the last 200,000 are kept (A:1610).
    func addLog(_ text: String, _ kind: LogLine.Kind = .plain) {
        let time = Format.clock(Date())
        for line in text.replacingOccurrences(of: "\r", with: "").split(separator: "\n", omittingEmptySubsequences: true) {
            log.append(LogLine(time: time, text: String(line), kind: kind))
            logChars += line.count + 10
        }
        if logChars > 400_000 {
            var drop = 0, chars = logChars
            while chars > 200_000 && drop < log.count { chars -= log[drop].text.count + 10; drop += 1 }
            log.removeFirst(drop)
            logChars = chars
        }
    }

    func say(_ text: String) {
        notice = text
        noticeToken += 1
        let token = noticeToken
        guard !isSample else { return }
        NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested,
                             userInfo: [.announcement: text, .priority: NSAccessibilityPriorityLevel.medium.rawValue])
        Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if noticeToken == token { notice = nil }
        }
    }

    // MARK: Calls

    /// One control call; the error is the Kit's one sentence.
    func call(_ method: String, _ route: String, body: [String: Any]? = nil, query: [String: String] = [:], timeout: TimeInterval = 60) async -> CallResult {
        guard let kit else { return .failure("Sample data: nothing is called in render mode.") }
        busy += 1
        defer { busy -= 1 }
        do {
            return .success(try await ControlClient(origin: origin, home: kit.locations.home).call(method, route, body: body, query: query, timeout: timeout))
        } catch {
            return .failure("\(error)")
        }
    }

    /// One CLI command; nil in render mode.
    func cli(_ args: [String], script: Script = .dshproxy, input: String? = nil, timeout: TimeInterval) async -> CommandResult? {
        guard let kit else { return nil }
        busy += 1
        defer { busy -= 1 }
        return await kit.runner.run(script, args, input: input, timeout: timeout)
    }

    static func text(_ result: CommandResult) -> String {
        (result.stdout + "\n" + result.stderr).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: Navigation

    func go(_ ws: Workspace, _ s: Section) {
        let changed = ws != workspace || s != section
        workspace = ws
        section = s
        guard changed, kit != nil else { return }
        if ws == .chat && s == .accounts && isRunning { Task { await loadLimits(force: false) } }
        if ws == .chat && s == .harness && harnessSetup == nil { Task { await readHarnessSetup() } }
        if ws == .video {
            switch s {
            case .accounts: Task { await readKrea() }
            case .apiKeys: Task { await readVideoKeys() }
            case .lanes, .models: Task { await loadVideoSettings() }
            case .harness: Task { await loadVideoSettings(); await readHarnessSetup() }
            case .log: break
            }
        }
    }

    func showInFinder(_ url: URL?) {
        guard let url else { return }
        var folder = url
        var directory: ObjCBool = false
        if !FileManager.default.fileExists(atPath: folder.path, isDirectory: &directory) || !directory.boolValue { folder = kit?.locations.home ?? url }
        NSWorkspace.shared.open(folder)
    }

    // MARK: Header

    var lowestLimit: LowestLimit? { isRunning ? limits?.lowest : nil }

    var detailLine: String {
        if let statusUnavailable { return statusUnavailable }
        switch gateway {
        case .running: return status?.detailLine ?? origin.absoluteString
        case .starting: return "The gateway is starting."
        case .notAnswering: return "The gateway process is running but does not answer. Stop asks before it cuts anything."
        case .stopped: return "The gateway is not running. Start it from the DSHProxy item in the menu bar."
        }
    }

    var footer: String {
        let data = status?.home ?? kit?.locations.home.path ?? "~/.dshproxy"
        let program = kit?.locations.checkout.path ?? "(sample)"
        return "Data: \(data)    Program: \(program)    Build: \(AppStore.buildStamp)"
    }

    static var buildStamp: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        let executable = Bundle.main.executableURL.flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path)[.modificationDate] as? Date }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return version + (executable.map { " (" + formatter.string(from: $0) + ")" } ?? "")
    }

    // MARK: Backend update (A:2938-2966)

    func applyUpdate() async {
        guard let update = status?.update, update.available else { return }
        let latest = update.latest
        let yes = await confirm("Update CLIProxyAPI", "Update the backend to CLIProxyAPI \(latest)?\n\n1. Download it and check it against the release's published checksum.\n2. Start it on a spare port and send one short request through each signed-in account (uses a tiny bit of quota).\n3. Only if that passes: restart DSHProxy on \(latest), about 5 seconds offline.\n\nIf anything fails, DSHProxy stays on the version you have.",
                                yes: "Update", destructive: false, style: .informational)
        guard yes else { return }
        updateBusy = true
        let result = await call("POST", "update/apply", body: [:], timeout: 300)
        updateBusy = false
        switch result {
        case .failure(let message):
            await controlFailed(message)
        case .success(let answer):
            let message = answer["message"] as? String ?? ""
            let ok = answer["ok"] as? Bool ?? false
            let checks = (answer["checks"] as? [Any] ?? []).map { "\u{2022} " + (($0 as? String) ?? "\($0)") }
            addLog(message, ok ? .action : .warn)
            await inform("Update CLIProxyAPI", message + (checks.isEmpty ? "" : "\n\nTrial run:\n" + checks.joined(separator: "\n")) + (ok ? "\n\nDSHProxy is restarting on the new version." : ""),
                         style: ok ? .informational : .warning)
            refreshStatus()
        }
    }

    func rollback() async {
        guard let previous = status?.previousVersion else { return }
        guard await confirm("Roll back", "Go back to CLIProxyAPI \(previous)?\n\nDSHProxy restarts, about 5 seconds offline.", yes: "Roll back", destructive: false, style: .informational) else { return }
        switch await call("POST", "update/rollback", body: [:]) {
        case .failure(let message): await controlFailed(message)
        case .success(let answer): addLog(answer["message"] as? String ?? "", .action); refreshStatus()
        }
    }

    /// A failed control call from the Lanes, Models or update controls (A:2968-2993).
    func controlFailed(_ message: String) async {
        pendingTicks = [:]
        refreshStatus()
        await inform("DSHProxy", message, style: .critical)
    }
}
