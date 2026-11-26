import Foundation

// Pure functions for the video side: `video settings`, `video key`, `dsh bundle status|install --json` and the
// Krea helper. Ported from the Windows app's VideoSettings, VideoKeys, HarnessSetup and Krea classes
// (app/DSHProxyApp.cs A:4585-5508); every sentence is theirs.

// MARK: - Video settings

public enum VideoSettings {
    /// Stands in for "no route" on the command line; only ever switches a model off.
    public static let noRoute = "none"
    public static let readArguments = ["video", "settings"]

    /// Model and route names are plain tokens: letters, digits, and after the first character dot, dash, underscore.
    public static func isName(_ value: String?) -> Bool {
        guard let value, !value.isEmpty, value.count <= 64 else { return false }
        for (index, scalar) in value.unicodeScalars.enumerated() {
            let alnum = ("a"..."z").contains(scalar) || ("A"..."Z").contains(scalar) || ("0"..."9").contains(scalar)
            if !alnum && (index == 0 || !".-_".unicodeScalars.contains(scalar)) { return false }
        }
        return true
    }

    /// Reads the JSON `video settings` (and `set`) prints. Anything not the agreed shape is refused as a whole.
    public static func parse(_ text: String) -> Result<[VideoModel], KitError> {
        guard let data = text.data(using: .utf8), let parsed = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            return .failure(KitError("DSHProxy did not answer with JSON."))
        }
        guard let root = parsed as? [String: Any], let list = root["models"] as? [Any] else { return .failure(KitError("The answer has no list of video models.")) }
        var models: [VideoModel] = []
        var seen = Set<String>()
        for item in list {
            let entry = item as? [String: Any]
            let id = entry?["model"] as? String
            guard let entry, let id, isName(id), seen.insert(id).inserted else {
                return .failure(KitError("The answer lists a video model without a usable, unique name."))
            }
            var routes: [String] = []
            for route in JSONValue.array(entry["routes"]) {
                if let name = route as? String, isName(name), name != noRoute, !routes.contains(name) { routes.append(name) }
            }
            var route = JSONValue.string(entry["route"])
            if route == noRoute { route = "" }
            models.append(VideoModel(id: id, enabled: JSONValue.bool(entry["enabled"]), route: route, routes: routes))
        }
        return .success(models)
    }

    public static func read(code: Int32?, stdout: String, stderr: String) -> Result<[VideoModel], KitError> {
        guard code == 0 else { return .failure(KitError(failure(code: code, stderr: stderr))) }
        return parse(stdout)
    }

    /// `video settings set MODEL ROUTE enabled|disabled`; nil for a name that is not a plain token, or for
    /// enabling without a route.
    public static func setArguments(model: String, route: String, enabled: Bool) -> [String]? {
        guard isName(model), isName(route), !(enabled && route == noRoute) else { return nil }
        return ["video", "settings", "set", model, route, enabled ? "enabled" : "disabled"]
    }

    /// One line saying why a command failed (A:4701-4708).
    public static func failure(code: Int32?, stderr: String) -> String {
        let text = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            guard let code else { return "The DSHProxy command did not finish in time." }
            return "The DSHProxy command ended with code \(code)."
        }
        var line = String(text.split(separator: "\n", omittingEmptySubsequences: false)[0]).trimmingCharacters(in: .whitespacesAndNewlines)
        if line.hasPrefix("DSHProxy: ") { line.removeFirst(10) }
        return line.count > 200 ? String(line.prefix(199)) + "\u{2026}" : line
    }

    public static func routeLabel(_ route: String) -> String {
        switch route {
        case "krea": return "Krea workspace"
        case "videorouter": return "VideoRouter"
        case "videorouter-replicate": return "VideoRouter (Replicate)"
        case "kovapi": return "KovAPI"
        case "callirra": return "Callirra"
        case "elevenlabs": return "ElevenLabs"
        default: return route
        }
    }

    /// The label with the exact name that is saved.
    public static func routeName(_ route: String) -> String {
        let label = routeLabel(route)
        return label == route ? route : label + " \u{B7} " + route
    }

    /// What a route bills in; the app never converts between them.
    public static func units(_ route: String) -> String {
        switch route {
        case "krea": return "workspace compute units"
        case "callirra": return "plan credits"
        case "videorouter", "videorouter-replicate", "kovapi": return "US dollars"
        default: return "units not known to this app"
        }
    }

    /// The company behind a model and its logo name (the company's mark, not the model's); "" when not known.
    public static func company(_ model: String) -> (label: String, logo: String) {
        if model == "wan-3.0" { return ("Alibaba", "alibaba") }
        if model == "minimax-h3" { return ("MiniMax", "minimax") }
        if model.hasPrefix("seedance-") { return ("ByteDance", "bytedance") }
        return ("", "")
    }
}

extension VideoModel {
    /// A saved route counts only if DSHProxy allows it for this model.
    public var hasRoute: Bool { !route.isEmpty && routes.contains(route) }

    /// A:3439-3444.
    public var routeCell: String {
        if route.isEmpty { return "Not configured" }
        if !hasRoute { return "Not allowed: " + (route.count > 40 ? String(route.prefix(39)) + "\u{2026}" : route) }
        return VideoSettings.routeName(route)
    }

    public var routeTone: Tone { route.isEmpty ? .warn : hasRoute ? .normal : .bad }

    /// nil: "Choose a billing route".
    public var billedIn: String? { hasRoute ? VideoSettings.units(route) : nil }
}

// MARK: - Video keys

public enum VideoKeys {
    public static let maxLength = 512
    public static let listArguments = ["video", "key", "list"]

    public static func setArguments(_ provider: String) -> [String]? {
        VideoSettings.isName(provider) ? ["video", "key", "set", provider] : nil
    }

    public static func removeArguments(_ provider: String) -> [String]? {
        VideoSettings.isName(provider) ? ["video", "key", "remove", provider] : nil
    }

    private static func isLabel(_ value: String?) -> Bool {
        guard let value, !value.isEmpty, value.count <= 40, value.trimmingCharacters(in: .whitespaces) == value else { return false }
        return value.unicodeScalars.allSatisfy { $0.value >= 0x20 && $0.value <= 0x7E }
    }

    private static func isVariable(_ value: String?) -> Bool {
        guard let value, !value.isEmpty, value.count <= 64 else { return false }
        for (index, scalar) in value.unicodeScalars.enumerated() {
            let ok = ("A"..."Z").contains(scalar) || (index > 0 && (("0"..."9").contains(scalar) || scalar == "_"))
            if !ok { return false }
        }
        return true
    }

    /// Reads what `video key list` prints. A state is shown as reported or not at all.
    public static func parse(_ text: String) -> Result<[VideoKeyProvider], KitError> {
        guard let data = text.data(using: .utf8), let parsed = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            return .failure(KitError("DSHProxy did not answer with JSON."))
        }
        guard let root = parsed as? [String: Any] else { return .failure(KitError("DSHProxy did not answer with a JSON object.")) }
        guard let list = root["providers"] as? [Any] else { return .failure(KitError("The answer has no list of video key providers.")) }
        var providers: [VideoKeyProvider] = []
        var seen = Set<String>()
        for item in list {
            let entry = item as? [String: Any]
            let id = entry?["provider"] as? String
            guard let entry, let id, VideoSettings.isName(id), seen.insert(id).inserted else {
                return .failure(KitError("The answer lists a video key provider without a usable, unique name."))
            }
            let label = entry["label"] as? String, variable = entry["variable"] as? String
            guard isLabel(label), isVariable(variable), let label, let variable else {
                return .failure(KitError("The answer names a video key provider or its variable in a form this app does not show."))
            }
            guard JSONValue.isBool(entry["saved"]), JSONValue.isBool(entry["readable"]), JSONValue.isBool(entry["inEnvironment"]) else {
                return .failure(KitError("The answer does not say whether each video key is saved."))
            }
            var routes: [String] = []
            for route in JSONValue.array(entry["routes"]) {
                if let name = route as? String, VideoSettings.isName(name), !routes.contains(name) { routes.append(name) }
            }
            let saved = JSONValue.bool(entry["saved"])
            providers.append(VideoKeyProvider(id: id, label: label, variable: variable, routes: routes, saved: saved,
                                              readable: saved && JSONValue.bool(entry["readable"]), inEnvironment: JSONValue.bool(entry["inEnvironment"])))
        }
        if providers.isEmpty { return .failure(KitError("The answer lists no video key provider.")) }
        return .success(providers)
    }

    public static func read(code: Int32?, stdout: String, stderr: String) -> Result<[VideoKeyProvider], KitError> {
        guard code == 0 else { return .failure(KitError(VideoSettings.failure(code: code, stderr: stderr))) }
        return parse(stdout)
    }

    /// Why a key is not sent at all, or nil when it can be: the command line's own rule and sentences.
    public static func refusal(_ key: String) -> String? {
        if key.isEmpty { return "No video API key was given. Nothing was saved." }
        if key.utf16.count > maxLength { return "A video API key can be at most 512 characters. Nothing was saved." }
        if key.unicodeScalars.contains(where: { $0.value < 0x21 || $0.value > 0x7E }) {
            return "A video API key cannot contain spaces, line breaks or anything else outside printable ASCII. Nothing was saved."
        }
        return nil
    }

    /// Whether a finished `set` answered {"provider":P,"saved":true}.
    public static func saved(code: Int32?, stdout: String, provider: String) -> Bool {
        guard code == 0, let root = JSONValue.object(stdout) else { return false }
        return root["provider"] as? String == provider && JSONValue.bool(root["saved"])
    }

    /// What a finished `remove` answered: true removed, false none was saved, nil not as agreed.
    public static func removed(code: Int32?, stdout: String, provider: String) -> Bool? {
        guard code == 0, let root = JSONValue.object(stdout), root["provider"] as? String == provider,
              JSONValue.isBool(root["saved"]), !JSONValue.bool(root["saved"]), JSONValue.isBool(root["removed"]) else { return nil }
        return JSONValue.bool(root["removed"])
    }

    /// A sentence from the command line, dropped should it ever repeat the key.
    public static func without(_ text: String, key: String) -> String {
        if key.isEmpty || !text.contains(key) { return text }
        return "DSHProxy refused, with a message that is not shown here because it repeats what was typed."
    }
}

extension VideoKeyProvider {
    public var stateText: String {
        let text = !saved ? "Not saved" : readable ? "Saved" : "Saved, cannot be read: enter it again"
        return inEnvironment ? text + " \u{B7} also set in the environment" : text
    }

    public var stateTone: Tone { !saved ? .muted : readable ? .normal : .warn }
    public var units: String { VideoSettings.units(routes.first ?? "") }
}

// MARK: - DeepSeek Harness setup

extension HarnessSetup {
    public static let statusArguments = ["dsh", "bundle", "status", "--json"]
    public static let installArguments = ["dsh", "bundle", "install", "--json"]
    private static let applyName = "Apply to DeepSeek Harness"

    /// Text from the command line as shown: no control characters, not without end.
    static func clean(_ value: Any?, _ max: Int) -> String {
        guard let text = value as? String else { return "" }
        let cleaned = String(String.UnicodeScalarView(text.unicodeScalars.map { $0.value < 0x20 || $0.value == 0x7F ? " " : $0 }))
            .trimmingCharacters(in: .whitespaces)
        return cleaned.count > max ? String(cleaned.prefix(max - 1)) + "\u{2026}" : cleaned
    }

    public static func unread(_ why: String) -> HarnessSetup {
        var setup = HarnessSetup(state: .unreadable)
        setup.reason = clean(why, 300)
        return setup
    }

    /// Reads the line `dsh bundle status --json` prints. Never fails: a line not of that shape is "unreadable".
    public static func parse(_ output: String) -> HarnessSetup {
        if output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return unread("DSHProxy gave no answer.") }
        let odd = "DSHProxy did not answer as expected."
        guard let root = JSONValue.lastLineObject(output) else { return unread(odd) }
        let harness = root["harness"] as? String
        guard harness == "found" || harness == "not-found" else { return unread(odd) }
        guard JSONValue.isBool(root["harnessRunning"]), JSONValue.isBool(root["profileExists"]), JSONValue.isBool(root["canInstall"]),
              JSONValue.isBool(root["canInstallAfterQuit"]) else { return unread(odd) }
        let bundle: Kind
        switch root["bundle"] as? String {
        case "installed": bundle = .installed
        case "switched-off": bundle = .switchedOff
        case "other-folder": bundle = .otherFolder
        case "folder-missing": bundle = .folderMissing
        case "not-installed": bundle = .notInstalled
        default: return unread(odd)
        }
        var read = HarnessSetup(state: bundle)
        read.harnessFound = harness == "found"
        read.profileExists = JSONValue.bool(root["profileExists"])
        read.harnessRunning = JSONValue.bool(root["harnessRunning"])
        read.canInstall = JSONValue.bool(root["canInstall"])
        read.canInstallAfterQuit = JSONValue.bool(root["canInstallAfterQuit"])
        read.folder = clean(root["folder"], 400)
        read.linkedTo = clean(root["linkedTo"], 400)
        read.version = clean(root["version"], 24)
        read.reason = clean(root["reason"], 300)
        if read.profileExists && (bundle == .installed || bundle == .switchedOff) { read.state = bundle }
        else if !read.harnessFound { read.state = .notFound }
        else if !read.profileExists { read.state = .neverOpened }
        return read
    }

    public static func read(code: Int32?, stdout: String, stderr: String) -> HarnessSetup {
        code == 0 ? parse(stdout) : unread(VideoSettings.failure(code: code, stderr: stderr))
    }

    public var planned: Plan {
        switch state {
        case .installed, .switchedOff: return .nothing
        case .unreadable: return .unknown
        case .neverOpened, .notFound: return .cannot
        default: return canInstall ? .install : canInstallAfterQuit ? .installAfterQuit : .cannot
        }
    }

    public var willInstall: Bool { planned == .install || planned == .installAfterQuit }

    /// The row on Video › DeepSeek Harness.
    public var rowText: String {
        switch state {
        case .installed: return "Yes \u{B7} switched on" + (version.isEmpty ? "" : " \u{B7} version " + version)
        case .switchedOff: return "Yes \u{B7} switched off in DeepSeek Harness"
        case .otherFolder: return "Yes \u{B7} from another folder"
        case .folderMissing: return "Not working \u{B7} its folder is gone"
        case .notInstalled: return "No \u{B7} Apply to DeepSeek Harness installs them"
        case .neverOpened: return "No \u{B7} DeepSeek Harness has not been opened yet"
        case .notFound: return "No \u{B7} DeepSeek Harness was not found"
        case .unreadable: return "Could not be read"
        }
    }

    public var rowTone: Tone {
        switch state {
        case .installed: return .ok
        case .folderMissing, .unreadable: return .bad
        default: return .warn
        }
    }

    public var pageLine: String {
        let name = Self.applyName
        switch state {
        case .installed: return "The video tools are installed and switched on in DeepSeek Harness."
        case .switchedOff: return "The video tools are installed, but switched off in DeepSeek Harness. \(name) leaves them off: you can switch them on in DeepSeek Harness under Plugins."
        case .otherFolder: return "DeepSeek Harness has the video tools from another folder. " + repair + (linkedTo.isEmpty ? "" : " The other folder: " + linkedTo)
        case .folderMissing: return "DeepSeek Harness has the video tools from a folder that is gone. Was the DSHProxy folder moved? " + repair + (linkedTo.isEmpty ? "" : " The folder that is gone: " + linkedTo)
        case .notInstalled: return "The video tools are not installed in DeepSeek Harness. " + repair
        case .neverOpened: return "DeepSeek Harness has not been opened yet, so the video tools cannot be installed. " + remedy
        case .notFound: return "DeepSeek Harness was not found on this computer, so the video tools cannot be installed."
        case .unreadable: return "Could not read whether the video tools are installed in DeepSeek Harness: " + Self.sentence(reason)
        }
    }

    private var repair: String {
        let does = state == .notInstalled ? "installs them." : "points them at this DSHProxy folder."
        if planned == .cannot { return Self.applyName + " cannot do that from here: " + Self.sentence(reason.isEmpty ? "DSHProxy did not say why." : reason) }
        return Self.applyName + ", at the top of the window, " + does
    }

    private static func sentence(_ text: String) -> String {
        text.isEmpty || text.hasSuffix(".") || text.hasSuffix("\u{2026}") ? text : text + "."
    }

    private var remedy: String {
        if state == .notFound { return "Install DeepSeek Harness, open it once and quit it, then press \(Self.applyName) again." }
        if state == .neverOpened { return "Open DeepSeek Harness once, quit it, then press \(Self.applyName) again." }
        return ""
    }

    /// The checklist an Apply asks with.
    public var confirmLines: [SetupLine] {
        var lines: [SetupLine] = []
        if state == .unreadable { lines.append(SetupLine(.note, "DeepSeek Harness could not be checked.", Self.sentence(reason))) }
        else if !harnessFound { lines.append(SetupLine(.cannot, "DeepSeek Harness was not found on this computer.")) }
        else if !profileExists { lines.append(SetupLine(.cannot, "DeepSeek Harness is installed, but has not been opened yet.")) }
        else { lines.append(SetupLine(.done, "DeepSeek Harness is installed and has been opened once.")) }
        lines.append(SetupLine(.toDo, "The chat routes will be written into every DeepSeek Harness profile.", "Each profile is backed up first.\nNothing else in it is changed."))
        lines.append(toolsPlan)
        lines.append(SetupLine(.toDo, (planned == .installAfterQuit ? "Start DeepSeek Harness again afterwards." : "Restart DeepSeek Harness afterwards.") + " DSHProxy does not do that for you."))
        return lines
    }

    private var toolsPlan: SetupLine {
        let after = planned == .installAfterQuit
        let open = "DeepSeek Harness is open now.\nYou will be asked to quit it, and you can skip that step."
        switch planned {
        case .nothing:
            if state == .installed { return SetupLine(.done, "The video tools are already installed.") }
            return SetupLine(.done, "The video tools are installed, but switched off in DeepSeek Harness.", "They are left off.\nYou can switch them on in DeepSeek Harness under Plugins.")
        case .unknown:
            return SetupLine(.note, "The video tools could not be checked, so they are left as they are.")
        case .cannot:
            let why = !reason.isEmpty ? Self.sentence(reason) : state == .notFound || state == .neverOpened ? "" : "DSHProxy did not say why."
            return SetupLine(.cannot, "The video tools cannot be installed.", why + (!why.isEmpty && !remedy.isEmpty ? "\n" : "") + remedy)
        default:
            if state == .notInstalled {
                return SetupLine(.toDo, after ? "The video tools will be installed after you quit DeepSeek Harness." : "The video tools will be installed in DeepSeek Harness.", after ? open : "")
            }
            let from = (state == .folderMissing ? "DeepSeek Harness has them from a folder that is gone:\n" : "DeepSeek Harness has them from another folder:\n") + linkedTo
            return SetupLine(.toDo, "The video tools will be pointed at this DSHProxy folder" + (after ? " after you quit DeepSeek Harness." : "."), from + (after ? "\n" + open : ""))
        }
    }

    /// What `dsh apply` printed, as much of it as a dialog holds; all of it is in the log.
    private static func shown(_ applied: String) -> String {
        var lines = applied.replacingOccurrences(of: "\r", with: "").split(separator: "\n", omittingEmptySubsequences: false)
            .map { clean(String($0), 200) }.filter { !$0.isEmpty }
        if lines.count > 10 {
            let more = lines.count - 9
            lines.removeSubrange(9...)
            lines.append("And \(more) more lines, on the Log page.")
        }
        return lines.joined(separator: "\n")
    }

    /// What an Apply says when it has ended. `folder`: this DSHProxy's video tools.
    public func summary(applied: String, outcome: Outcome, install: HarnessInstall?, folder: String) -> SetupResult {
        var lines: [SetupLine] = []
        let said = Self.shown(applied)
        lines.append(SetupLine(.done, said.isEmpty ? "The chat routes were applied." : "The chat routes were applied. DSHProxy reported:", said))
        let restart = "If anything above was updated, restart DeepSeek Harness so it uses the change."
        var heading: String
        var byHand = false
        switch outcome {
        case .installed:
            heading = "DeepSeek Harness is set up"
            lines.append(SetupLine(.done, "The video tools are installed in DeepSeek Harness.", install?.message ?? ""))
            lines.append(SetupLine(.toDo, "Start DeepSeek Harness again."))
        case .failed:
            heading = "The video tools were not installed"
            var detail = install?.message ?? ""
            if let log = install?.log, !log.isEmpty { detail += (detail.isEmpty ? "" : "\n") + "More is in this file:\n" + log }
            lines.append(SetupLine(.cannot, "The video tools were not installed.", detail))
            byHand = true
        case .skipped:
            heading = "The video tools were not installed"
            lines.append(SetupLine(.note, "The video tools were not installed, because you skipped that step."))
            lines.append(SetupLine(.toDo, "To install them, quit DeepSeek Harness and press \(Self.applyName) again."))
            lines.append(SetupLine(.toDo, restart))
        case .nothingToInstall:
            if planned == .nothing && state == .installed {
                heading = "DeepSeek Harness is set up"
                lines.append(SetupLine(.done, "The video tools were already installed. Nothing was changed for them."))
                lines.append(SetupLine(.toDo, restart))
            } else if planned == .nothing {
                heading = "The video tools were left switched off"
                lines.append(SetupLine(.note, "The video tools are installed, but switched off in DeepSeek Harness. They were left off.", "You can switch them on in DeepSeek Harness under Plugins."))
                lines.append(SetupLine(.toDo, restart))
            } else if planned == .unknown {
                heading = "The video tools were not checked"
                lines.append(SetupLine(.note, "The video tools could not be checked. Nothing was installed.", Self.sentence(reason)))
                lines.append(SetupLine(.toDo, restart))
                lines.append(SetupLine(.toDo, "Press \(Self.applyName) again later to check the video tools."))
            } else {
                heading = "The video tools were not installed"
                let why = !reason.isEmpty ? Self.sentence(reason) : state == .notFound ? "DeepSeek Harness was not found on this computer."
                    : state == .neverOpened ? "DeepSeek Harness has not been opened yet." : "DSHProxy did not say why."
                lines.append(SetupLine(.cannot, "The video tools were not installed.", why))
                if !remedy.isEmpty {
                    lines.append(SetupLine(.toDo, remedy))
                    lines.append(SetupLine(.toDo, restart))
                } else {
                    byHand = true
                }
            }
        }
        if byHand {
            lines.append(SetupLine(.toDo, "To install them by hand, start DeepSeek Harness, open Plugins > Add plugin and choose this folder:", folder))
        }
        return SetupResult(heading: heading, lines: lines, copyPath: byHand && !folder.isEmpty ? folder : nil)
    }
}

extension HarnessInstall {
    /// What a finished `dsh bundle install --json` said: installed only when it says so and ended with code 0.
    public static func read(code: Int32?, stdout: String, stderr: String) -> HarnessInstall {
        guard let root = JSONValue.lastLineObject(stdout), JSONValue.isBool(root["ok"]) else {
            return HarnessInstall(ok: false, message: code != 0 ? VideoSettings.failure(code: code, stderr: stderr)
                                  : "DSHProxy did not answer as expected, so it is not known whether the video tools were installed.", log: "")
        }
        return HarnessInstall(ok: JSONValue.bool(root["ok"]) && code == 0, message: HarnessSetup.clean(root["message"], 400), log: HarnessSetup.clean(root["log"], 400))
    }
}

// MARK: - Krea helper

public enum Krea {
    private static let hosts: Set<String> = ["krea.ai", "www.krea.ai", "api.krea.ai"]

    /// The one line `status` prints: {"signedIn":true,"expiresAt":<ms>} or {"signedIn":false}. nil for anything
    /// else, a sign-in until a time already past included.
    public static func parseStatus(_ output: String, now: Date) -> KreaStatus? {
        let text = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= 512, !text.contains("\n"), let root = JSONValue.object(text), JSONValue.isBool(root["signedIn"]) else { return nil }
        if !JSONValue.bool(root["signedIn"]) { return KreaStatus(signedIn: false, until: nil) }
        guard let ms = JSONValue.number(root["expiresAt"]), !ms.isNaN, ms <= 4_102_444_800_000 else { return nil }
        let until = Date(timeIntervalSince1970: (ms.rounded(.down)) / 1000)
        guard until > now else { return nil }
        return KreaStatus(signedIn: true, until: until)
    }

    public static func describe(_ status: KreaStatus, timeZone: TimeZone = .current) -> String {
        guard status.signedIn, let until = status.until else { return "Not signed in" }
        return "Signed in \u{B7} until " + Format.formatter("EEE d MMM yyyy, HH:mm", timeZone).string(from: until)
    }

    /// The consent address from the first line `login` prints, or nil: an https address on krea.ai, www.krea.ai
    /// or api.krea.ai, written plainly; checked as text and as a parsed address.
    public static func consentAddress(_ line: String) -> String? {
        let text = line.trimmingCharacters(in: .whitespacesAndNewlines)
        let scheme = "https://"
        guard text.count > scheme.count, text.count <= 4096, text.hasPrefix(scheme) else { return nil }
        guard !text.unicodeScalars.contains(where: { $0.value <= 0x20 || $0.value >= 0x7F || $0 == "\\" }) else { return nil }
        let rest = text.dropFirst(scheme.count)
        let authority = rest.prefix { $0 != "/" && $0 != "?" && $0 != "#" }
        guard hosts.contains(String(authority)) else { return nil }
        guard let components = URLComponents(string: text), components.scheme == "https", components.port == nil,
              components.user == nil, components.password == nil, let host = components.host, hosts.contains(host) else { return nil }
        return text
    }

    /// How a finished `login` ended: exit 0 is signed in, otherwise the code it printed.
    public static func ended(exitCode: Int32?, errors: String) -> KreaOutcome {
        if exitCode == 0 { return .signedIn }
        var outcome = KreaOutcome.failed
        for line in errors.split(separator: "\n") {
            switch line.trimmingCharacters(in: .whitespaces) {
            case "KREA_REFUSED": outcome = .refused
            case "KREA_LOGIN_REQUIRED": outcome = .loginRequired
            case "KREA_UNCERTAIN": outcome = .uncertain
            default: break
            }
        }
        return outcome
    }

    public static func message(_ outcome: KreaOutcome) -> String {
        switch outcome {
        case .signedIn: return "Signed in to Krea."
        case .cancelled: return "Sign-in cancelled: the Krea helper was stopped."
        case .refused: return "Krea sign-in did not complete (KREA_REFUSED): it was refused or closed in the browser, took longer than three minutes, or Krea could not be reached."
        case .loginRequired: return "Krea sign-in did not complete (KREA_LOGIN_REQUIRED): no sign-in is present."
        case .uncertain: return "Krea sign-in ended uncertain (KREA_UNCERTAIN): the helper could not tell whether it completed."
        case .addressRefused: return "Refused: the Krea helper gave a consent address that is not an https address on krea.ai, www.krea.ai or api.krea.ai. It was not opened, and the helper was stopped."
        case .browserNotOpened: return "The consent page could not be opened in your browser. The Krea helper was stopped."
        case .noAddressInTime: return "The Krea helper gave no consent address within a minute. It was stopped."
        case .notFinishedInTime: return "The Krea helper did not finish in time. It was stopped."
        case .notStarted: return "The Krea helper could not be started."
        case .endedWithoutAddress: return "The Krea helper ended without giving a consent address."
        case .failed: return "The Krea helper ended with an error it did not name."
        }
    }
}
