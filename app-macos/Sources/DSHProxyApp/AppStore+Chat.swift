// Chat actions: accounts and limits, sign-in, limit resets, API keys, lanes, models, DeepSeek Harness and
// Apply. Routes, timeouts and texts as in inventory sections 2.1-2.5 and 3.

import AppKit
import DSHProxyKit
import SwiftUI

extension AppStore {
    // MARK: Accounts and limits (2.1)

    func loadLimits(force: Bool) async {
        guard isRunning, limitsState != .reading else { return }
        limitsState = .reading
        let result = await call("GET", "limits", query: force ? ["refresh": "1"] : [:], timeout: 60)
        switch result {
        case .failure(let message): limitsState = .failed(message)
        case .success(let answer):
            limits = LimitsReport.parse(answer)
            limitsState = .updated(Date())
        }
        limitsAt = Date()
    }

    var limitsNote: String {
        switch limitsState {
        case .none: return ""
        case .reading: return "Reading limits..."
        case .failed(let message): return "Could not read limits: " + message
        case .updated(let at): return "Limits updated \(Format.ago(at, now: max(now, at))). They refresh every minute."
        }
    }

    func addAccount() {
        openWindow()
        Task {
            guard await needRunning("Add account", "Start the gateway first. Sign-in runs through it.") else { return }
            go(.chat, .accounts)
            sheet = .addAccount
        }
    }

    var loginProviders: [LoginProvider] {
        let listed = status?.loginProviders ?? []
        return listed.isEmpty ? LoginProvider.defaults : listed
    }

    func signedIn(_ who: String) {
        addLog("Signed in: " + who, .action)
        go(.chat, .accounts)
        refreshStatus()
        Task { await loadLimits(force: true) }
    }

    private func accountCall(_ route: String, _ body: [String: Any], done: String) async {
        switch await call("POST", route, body: body, timeout: 30) {
        case .failure(let message):
            await inform("Account", message, style: .critical)
        case .success:
            addLog(done)
            say(done)
            refreshStatus()
            await loadLimits(force: true)
        }
    }

    func signOut(_ account: AccountLimits) async {
        guard await confirm("Sign out", "Sign out of \(account.who)?\n\nDSHProxy stops using this account and deletes its saved sign-in. Lanes move to their other models. You can sign in again at any time.", yes: "Sign out") else { return }
        await accountCall("accounts/remove", ["file": account.file], done: "Signed out of \(account.who).")
    }

    func setPaused(_ account: AccountLimits, _ pause: Bool) async {
        await accountCall("accounts/disable", ["file": account.file, "disabled": pause], done: "\(pause ? "Paused" : "Resumed") \(account.who).")
    }

    func makePrimary(_ account: AccountLimits) async {
        await accountCall("accounts/primary", ["file": account.file], done: "\(account.who) is now the primary account: it is used until it runs out, then the other one takes over.")
    }

    func clearPrimary(_ account: AccountLimits) async {
        await accountCall("accounts/primary", ["file": account.file, "primary": false], done: "\(account.label) has no primary account now: its accounts take turns.")
    }

    /// Lists the resets ChatGPT offers, then hands over to the danger-zone sheet (A:2562-2594).
    func useReset(_ account: AccountLimits) async {
        switch await call("GET", "resets", query: ["file": account.file], timeout: 30) {
        case .failure(let message):
            await inform("Limit reset", "Could not list your resets: " + message, style: .critical)
        case .success(let answer):
            let credits = ResetCredits.parse(answer)
            if credits.available <= 0 && credits.credits.isEmpty {
                await inform("Limit reset", "No limit reset is available on this account right now.")
                return
            }
            sheet = .reset(account, credits)
        }
    }

    /// Each attempt carries its own request ID, so a retried request cannot use a second reset (A:2596-2622).
    func consumeReset(file: String, creditID: String?) async {
        sheet = nil
        var body: [String: Any] = ["file": file, "requestId": UUID().uuidString.lowercased()]
        if let creditID, !creditID.isEmpty { body["creditId"] = creditID }
        switch await call("POST", "resets/use", body: body, timeout: 60) {
        case .failure(let message):
            await inform("Limit reset", "The reset was not confirmed: \(message)\n\nRefresh the limits to see whether it was used before trying again.", style: .critical)
        case .success(let answer):
            let message = answer["message"] as? String ?? ""
            let ok = answer["code"] as? String == "reset"
            addLog(message, ok ? .action : .warn)
            await inform("Limit reset", message, style: ok ? .informational : .warning)
            await loadLimits(force: true)
        }
    }

    // MARK: Sign-in (2.1.1)

    func loginStart(_ provider: String) async -> LoginStartResult {
        switch await call("POST", "login/start", body: ["provider": provider], timeout: 30) {
        case .failure(let message): return .failure(message)
        case .success(let answer):
            guard let start = LoginStart.parse(answer) else { return .failure("The gateway did not give a sign-in link.") }
            return .success(start)
        }
    }

    /// nil when the gateway did not answer this time (the sheet asks again).
    func loginStatus(_ id: String) async -> LoginProgress? {
        if case .success(let answer) = await call("GET", "login/status", query: ["id": id], timeout: 15) { return LoginProgress.parse(answer) }
        return nil
    }

    func loginCancel(_ id: String) {
        Task { _ = await call("POST", "login/cancel", body: ["id": id], timeout: 10) }
    }

    /// Only https addresses are opened (A:726-733).
    @discardableResult
    func openSignIn(_ url: String) -> Bool {
        guard let link = Links.signInURL(url), !isSample else { return false }
        return NSWorkspace.shared.open(link)
    }

    // MARK: API keys (2.2)

    /// `key set PROVIDER REGION` with the key and a newline on standard input, 120 s (A:4265-4274).
    func saveKey(_ provider: KeyProvider, region: String?, key: String) async {
        sheet = nil
        var args = ["key", "set", provider.key]
        if let region, !region.isEmpty { args.append(region) }
        await keyCommand(args, input: key + "\n", key: key)
    }

    func removeKey(_ provider: KeyProvider) async {
        guard await confirm("API key", "Remove the saved \(provider.label) key?", yes: "Remove") else { return }
        await keyCommand(["key", "remove", provider.key], input: nil, key: "")
    }

    private func keyCommand(_ args: [String], input: String?, key: String) async {
        guard let result = await cli(args, input: input, timeout: 120) else { return }
        let text = VideoKeys.without(AppStore.text(result), key: key)
        addLog(text)
        if result.code == 0 && ownAlive {
            refreshStatus()
            await offerRestart(text, "API key")
        } else {
            refreshStatus()
            await inform("API key", text.isEmpty ? "Done." : text, style: result.code == 0 ? .informational : .critical)
        }
    }

    private func offerRestart(_ output: String, _ title: String) async {
        await offerRestartForChange(output: output, title: title)
    }

    // MARK: Lanes (2.3)

    func choosePreset(_ preset: RoutingPreset) async {
        guard preset.name != status?.routing.activeName else { return }
        guard await needRunning("Routing preset") else { return }
        guard await confirm("Routing preset", "Use the \(preset.label) routing preset?\n\nThis replaces the ladders of all lanes. You can switch back or edit them at any time.",
                            yes: "Use \(preset.label)", destructive: false, style: .informational) else { return }
        switch await call("POST", "lanes/preset", body: ["name": preset.name]) {
        case .failure(let message): await controlFailed(message)
        case .success(let answer):
            addLog("Routing preset: \(preset.label).", .action)
            if answer["harnessChanged"] as? Bool == true { addLog("DeepSeek Harness routes updated. Restart DeepSeek Harness to see them.") }
            say("Routing preset: \(preset.label).")
            refreshStatus()
        }
    }

    /// Opens settings.json in TextEdit (A:4556-4565).
    func editLanes() async {
        guard let home else { return }
        let file = home.appendingPathComponent("settings.json")
        guard FileManager.default.fileExists(atPath: file.path) else {
            await inform("Lanes", "settings.json is created the first time a setting is saved, for example when you add an API key. Until then the default lanes are used.")
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        if let editor = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.TextEdit") {
            NSWorkspace.shared.open([file], withApplicationAt: editor, configuration: configuration, completionHandler: nil)
        } else {
            NSWorkspace.shared.open(file)
        }
    }

    // MARK: Models (2.4)

    func offered(_ model: ChatModel) -> Bool { pendingTicks[model.id] ?? model.offered }

    func setOffered(_ model: ChatModel, _ on: Bool) async {
        guard offered(model) != on else { return }
        guard await needRunning("Models") else { return }
        pendingTicks[model.id] = on
        switch await call("POST", "models/choose", body: ["id": model.id, "offered": on]) {
        case .failure(let message): await controlFailed(message)
        case .success(let answer):
            addLog((on ? "Offering " : "No longer offering ") + model.id + (answer["harnessChanged"] as? Bool == true ? "; DeepSeek Harness routes updated. Restart DeepSeek Harness to see it." : "."))
            say("\(model.id) \(on ? "offered" : "switched off").")
            refreshStatus()
        }
    }

    func checkForModels() async {
        guard await needRunning("Models") else { return }
        checkingModels = true
        let result = await call("POST", "models/refresh", body: [:])
        checkingModels = false
        switch result {
        case .failure(let message): await controlFailed(message)
        case .success(let answer):
            let error = answer["catalogError"] as? String ?? ""
            let changed = answer["harnessChanged"] as? Bool == true
            addLog("Checked for new models" + (error.isEmpty ? "" : " (catalog not reachable: \(error))") + (changed ? "; DeepSeek Harness routes updated." : "."))
            refreshStatus()
        }
    }

    func replaceOnLanes(_ suggestion: Suggestion) async {
        let lanes = suggestion.lanes.joined(separator: ", ")
        guard await confirm("Lanes", "Put \(suggestion.to) in place of \(suggestion.from) on lane \(lanes)?\n\nThe rest of each ladder stays as it is. You can change it back in settings.json.",
                            yes: "Use \(suggestion.to)", destructive: false, style: .informational) else { return }
        switch await call("POST", "lanes/replace", body: ["from": suggestion.from, "to": suggestion.to, "lanes": suggestion.lanes]) {
        case .failure(let message): await controlFailed(message)
        case .success:
            addLog("\(suggestion.to) now replaces \(suggestion.from) on lane \(lanes).", .action)
            say("\(suggestion.to) now replaces \(suggestion.from).")
            refreshStatus()
        }
    }

    // MARK: DeepSeek Harness (2.5)

    func previewHarness() async {
        guard let result = await cli(["dsh", "apply", "--dry-run"], timeout: 120) else { return }
        let text = AppStore.text(result)
        sheet = .output(OutputSpec(title: "Preview", intro: nil, text: text.isEmpty ? "Done." : text, footnote: nil, good: result.code == 0))
    }

    func verifyHarness() async {
        guard let result = await cli(["dsh", "verify"], timeout: 120) else { return }
        let text = AppStore.text(result)
        addLog(text, result.code == 0 ? .plain : .warn)
        refreshStatus()
        sheet = .output(OutputSpec(title: "Verify DeepSeek Harness", intro: nil, text: text, footnote: nil, good: result.code == 0))
    }

    func removeFromHarness() async {
        guard await confirm("DeepSeek Harness", "Remove the DSHProxy routes from every DeepSeek Harness profile?", yes: "Remove routes") else { return }
        guard let result = await cli(["dsh", "remove"], timeout: 120) else { return }
        let text = AppStore.text(result)
        addLog(text)
        refreshStatus()
        sheet = .output(OutputSpec(title: "DeepSeek Harness", intro: nil, text: text.isEmpty ? "Done." : text, footnote: nil, good: result.code == 0))
    }

    /// `dsh bundle status --json`, 30 s: on the DeepSeek Harness pages and after Apply.
    func readHarnessSetup() async {
        guard let result = await cli(HarnessSetup.statusArguments, timeout: 30) else { return }
        let unreadBefore = harnessSetup?.state == .unreadable
        let setup = HarnessSetup.read(code: result.code, stdout: result.stdout, stderr: result.stderr)
        harnessSetup = setup
        harnessReadAt = Date()
        if setup.state == .unreadable && !unreadBefore { addLog("Video: could not read whether the video tools are installed in DeepSeek Harness: " + setup.reason, .warn) }
    }

    var videoToolsFolder: URL? { kit?.locations.checkout.appendingPathComponent("integrations/dsh-video") }

    var videoToolsFound: Bool {
        guard let folder = videoToolsFolder else { return false }
        return FileManager.default.fileExists(atPath: folder.appendingPathComponent("package.json").path)
    }

    static func deepSeekHarnessRunning() -> Bool {
        NSWorkspace.shared.runningApplications.contains { $0.localizedName == "DeepSeek Harness" }
    }

    // MARK: Apply to DeepSeek Harness (2.5.1)

    func applyToHarness() {
        guard !applying, kit != nil else { return }
        applying = true
        Task {
            defer { applying = false }
            guard let read = await cli(HarnessSetup.statusArguments, timeout: 30) else { return }
            let setup = HarnessSetup.read(code: read.code, stdout: read.stdout, stderr: read.stderr)
            harnessSetup = setup
            harnessReadAt = Date()
            guard await decide(.applyChecklist(setup)), !quitting else { return }
            sheet = .applyBusy("Writing the routes\u{2026}")
            guard let applied = await cli(["dsh", "apply"], timeout: 120) else { sheet = nil; return }
            let text = AppStore.text(applied)
            addLog(text)
            refreshStatus()
            if applied.code != 0 {
                sheet = nil
                let code = applied.code.map(String.init) ?? "?"
                await inform("Apply to DeepSeek Harness", text.isEmpty ? "The chat routes were not written: the DSHProxy command ended with code \(code)." : text, style: .critical)
                return
            }
            let folder = setup.folder.isEmpty ? (videoToolsFolder?.path ?? "") : setup.folder
            guard setup.willInstall else {
                await showApplyResult(setup.summary(applied: text, outcome: .nothingToInstall, install: nil, folder: folder))
                return
            }
            if AppStore.deepSeekHarnessRunning() {
                guard await decide(.harnessWait), !quitting else {
                    if !quitting {
                        addLog("Video tools: not installed. The step was skipped while DeepSeek Harness was open.")
                        await showApplyResult(setup.summary(applied: text, outcome: .skipped, install: nil, folder: folder))
                    }
                    return
                }
            }
            sheet = .applyBusy("Installing the video tools\u{2026}")
            guard let installed = await cli(HarnessSetup.installArguments, timeout: 180) else { sheet = nil; return }
            let answer = HarnessInstall.read(code: installed.code, stdout: installed.stdout, stderr: installed.stderr)
            addLog("Video tools: " + (answer.ok ? "installed in DeepSeek Harness." : "not installed.") + (answer.message.isEmpty ? "" : " " + answer.message))
            await showApplyResult(setup.summary(applied: text, outcome: answer.ok ? .installed : .failed, install: answer, folder: folder))
        }
    }

    private func showApplyResult(_ result: SetupResult) async {
        sheet = .applyResult(result)
        await readHarnessSetup()
    }

    /// Shows a sheet that answers yes or no (the checklist, the wait for DeepSeek Harness to quit).
    func decide(_ kind: SheetKind) async -> Bool {
        await withCheckedContinuation { continuation in
            decision = { continuation.resume(returning: $0) }
            sheet = kind
        }
    }

    func answer(_ yes: Bool) {
        let done = decision
        decision = nil
        if !yes { sheet = nil }
        done?(yes)
    }
}

/// The pending answer of a yes/no sheet; one at a time.
@MainActor private var pendingDecision: ((Bool) -> Void)?

extension AppStore {
    var decision: ((Bool) -> Void)? {
        get { pendingDecision }
        set { pendingDecision = newValue }
    }
}
