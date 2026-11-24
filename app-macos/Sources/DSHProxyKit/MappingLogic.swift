import Foundation

// Pure functions from the CLI's and the gateway's JSON to the values in Mapping.swift, chat side. Texts and
// rules are the Windows app's (app/DSHProxyApp.cs); the citations are to that file.

// MARK: - Reading JSON values as the Windows app's Json helpers do

enum JSONValue {
    static func object(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) as? [String: Any]
    }

    static func isBool(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    /// True only for a JSON `true`.
    static func bool(_ value: Any?) -> Bool { isBool(value) && (value as! NSNumber).boolValue }

    /// A JSON number (not a boolean).
    static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, !isBool(value) else { return nil }
        return number.doubleValue
    }

    /// A string as it is; a number as text; anything else "".
    static func string(_ value: Any?) -> String {
        if let text = value as? String { return text }
        if let number = number(value) { return number == number.rounded() && abs(number) < 1e15 ? String(Int64(number)) : String(number) }
        return ""
    }

    /// A non-empty string, else nil.
    static func text(_ value: Any?) -> String? {
        let text = string(value)
        return text.isEmpty ? nil : text
    }

    static func array(_ value: Any?) -> [Any] { value as? [Any] ?? [] }
    static func dictionary(_ value: Any?) -> [String: Any] { value as? [String: Any] ?? [:] }

    /// An ISO 8601 time, with or without fractional seconds.
    static func date(_ value: Any?) -> Date? {
        guard let text = value as? String, !text.isEmpty else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: text) { return date }
        return ISO8601DateFormatter().date(from: text)
    }

    /// The JSON object on the last line that has anything on it, or nil.
    static func lastLineObject(_ output: String) -> [String: Any]? {
        let lines = output.replacingOccurrences(of: "\r", with: "").split(separator: "\n", omittingEmptySubsequences: false)
        for raw in lines.reversed() {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            if line.count > 16384 { return nil }
            return object(line)
        }
        return nil
    }
}

// MARK: - Formats (A:243-277)

public enum Format {
    static let english = Locale(identifier: "en_US_POSIX")

    static func formatter(_ pattern: String, _ timeZone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = english
        formatter.timeZone = timeZone
        formatter.dateFormat = pattern
        return formatter
    }

    /// Token counts as the Models list shows them: "1.5M", "200K", "999" (A:2720-2725).
    public static func tokens(_ value: Double) -> String {
        if value >= 1_000_000 {
            let millions = (value / 1_000_000 * 100).rounded() / 100
            var text = String(format: "%.2f", millions)
            while text.hasSuffix("0") { text.removeLast() }
            if text.hasSuffix(".") { text.removeLast() }
            return text + "M"
        }
        if value >= 1000 { return "\(Int((value / 1000).rounded()))K" }
        return "\(Int(value.rounded()))"
    }

    /// "12 min", "2 h 12 min", "3 d 5 h", or "now" (A:253-260).
    public static func until(_ when: Date, now: Date) -> String {
        let seconds = when.timeIntervalSince(now)
        if seconds <= 0 { return "now" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(max(1, Int(minutes.rounded(.up)))) min" }
        let totalMinutes = Int(minutes)
        if minutes < 24 * 60 { return "\(totalMinutes / 60) h \(totalMinutes % 60) min" }
        return "\(totalMinutes / 1440) d \((totalMinutes % 1440) / 60) h"
    }

    /// "resets in 2 h 12 min (today 12:12)", or "reset time not reported" (A:262-268).
    public static func reset(_ when: Date?, now: Date, timeZone: TimeZone = .current) -> String {
        guard let when else { return "reset time not reported" }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let day: String
        if calendar.isDate(when, inSameDayAs: now) {
            day = "today"
        } else if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(when, inSameDayAs: tomorrow) {
            day = "tomorrow"
        } else {
            day = formatter("EEE d MMM", timeZone).string(from: when)
        }
        return "resets in \(until(when, now: now)) (\(day) \(formatter("HH:mm", timeZone).string(from: when)))"
    }

    /// "just now", "7 min ago", else the time "HH:mm" (A:270-276).
    public static func ago(_ when: Date, now: Date, timeZone: TimeZone = .current) -> String {
        let seconds = now.timeIntervalSince(when)
        if seconds < 45 { return "just now" }
        if seconds < 3600 { return "\(Int((seconds / 60).rounded())) min ago" }
        return formatter("HH:mm", timeZone).string(from: when)
    }

    /// "HH:mm:ss".
    public static func clock(_ date: Date, timeZone: TimeZone = .current) -> String {
        formatter("HH:mm:ss", timeZone).string(from: date)
    }

    /// A percentage as "{0:0}" writes it (half away from zero).
    public static func percent(_ value: Double) -> String { "\(Int(value.rounded()))" }
}

// MARK: - `status --json` (C:308-349, A:2076-2227)

extension FullStatus {
    public static func parse(_ text: String) -> FullStatus? {
        guard let root = JSONValue.object(text) else { return nil }
        let backend = JSONValue.dictionary(root["backend"])
        let lock = JSONValue.dictionary(root["backendLock"])
        let updateObject = root["update"] as? [String: Any]
        let discovery = JSONValue.dictionary(root["discovery"])
        let keys = JSONValue.dictionary(root["apiKeys"])
        var readable: [String: String] = [:]
        for item in JSONValue.array(keys["readable"]) {
            let entry = JSONValue.dictionary(item)
            readable[JSONValue.string(entry["provider"])] = JSONValue.string(entry["region"])
        }
        let unreadable = Set(JSONValue.array(keys["unreadable"]).map { JSONValue.string($0) })
        let keyProviders = JSONValue.array(root["providers"]).map { item -> KeyProvider in
            let entry = JSONValue.dictionary(item)
            let key = JSONValue.string(entry["key"])
            let regions = JSONValue.array(entry["regions"]).map { region -> KeyRegion in
                let value = JSONValue.dictionary(region)
                return KeyRegion(key: JSONValue.string(value["key"]), label: JSONValue.string(value["label"]))
            }
            let state: KeyState = readable[key] != nil ? .saved : unreadable.contains(key) ? .unreadable : .notSet
            return KeyProvider(key: key, label: JSONValue.string(entry["label"]), regions: regions, state: state, savedRegion: readable[key])
        }
        let lanes = JSONValue.array(root["lanes"]).map { item -> Lane in
            let lane = JSONValue.dictionary(item)
            let rungs = JSONValue.array(lane["ladder"]).map { rung -> Rung in
                let value = JSONValue.dictionary(rung)
                return Rung(model: JSONValue.string(value["model"]), available: JSONValue.bool(value["available"]), coolingUntil: JSONValue.date(value["coolingUntil"]))
            }
            return Lane(name: JSONValue.string(lane["name"]), rungs: rungs)
        }
        let routingObject = JSONValue.dictionary(root["routing"])
        let active = JSONValue.dictionary(routingObject["active"])
        let presets = JSONValue.array(routingObject["presets"]).map { item -> RoutingPreset in
            let preset = JSONValue.dictionary(item)
            return RoutingPreset(name: JSONValue.string(preset["name"]), label: JSONValue.string(preset["label"]), summary: JSONValue.string(preset["summary"]))
        }
        let models = JSONValue.array(root["modelList"]).map { item -> ChatModel in
            let model = JSONValue.dictionary(item)
            return ChatModel(id: JSONValue.string(model["id"]), name: JSONValue.string(model["name"]), account: JSONValue.string(model["account"]),
                             contextWindow: JSONValue.number(model["contextWindow"]) ?? 0, maxTokens: JSONValue.number(model["maxTokens"]) ?? 0,
                             efforts: JSONValue.array(model["efforts"]).map { JSONValue.string($0) },
                             isNew: JSONValue.bool(model["isNew"]), offered: JSONValue.bool(model["offered"]), reason: JSONValue.string(model["reason"]))
        }
        let suggestions = JSONValue.array(root["suggestions"]).map { item -> Suggestion in
            let value = JSONValue.dictionary(item)
            return Suggestion(from: JSONValue.string(value["from"]), to: JSONValue.string(value["to"]), lanes: JSONValue.array(value["lanes"]).map { JSONValue.string($0) })
        }
        let harness = JSONValue.dictionary(root["deepseekHarness"])
        let profiles = JSONValue.array(harness["profiles"]).map { item -> HarnessProfile in
            let profile = JSONValue.dictionary(item)
            let routes = JSONValue.array(profile["routes"])
            let count = routes.reduce(0) { $0 + Int(JSONValue.number(JSONValue.dictionary($1)["models"]) ?? 0) }
            return HarnessProfile(profile: JSONValue.string(profile["profile"]), routeCount: routes.count, modelCount: count,
                                  current: JSONValue.bool(profile["current"]), error: JSONValue.text(profile["error"]))
        }
        let update = updateObject.map {
            BackendUpdate(available: JSONValue.bool($0["available"]), latest: JSONValue.string($0["latest"]), publishedAt: JSONValue.date($0["publishedAt"]))
        }
        return FullStatus(
            running: JSONValue.bool(root["running"]),
            origin: JSONValue.string(root["origin"]),
            home: JSONValue.string(root["home"]),
            inFlight: InFlight.count(root),
            backendName: JSONValue.string(backend["name"]),
            backendVersion: JSONValue.string(backend["version"]),
            lockVersion: JSONValue.string(lock["version"]),
            previousVersion: JSONValue.text(lock["previous"]),
            update: update,
            accountCount: JSONValue.array(root["accounts"]).count,
            modelsOffered: JSONValue.array(root["models"]).count,
            loginProviders: JSONValue.array(root["loginProviders"]).map { item in
                let value = JSONValue.dictionary(item)
                return LoginProvider(key: JSONValue.string(value["key"]), label: JSONValue.string(value["label"]))
            },
            keyProviders: keyProviders,
            lanes: lanes,
            routing: Routing(activeName: JSONValue.string(active["name"]), activeLabel: JSONValue.string(active["label"]), presets: presets),
            models: models,
            catalogError: JSONValue.text(discovery["catalogError"]),
            catalogCheckedAt: JSONValue.date(discovery["fetchedAt"]),
            suggestions: suggestions,
            profiles: profiles)
    }

    /// The header's second line while the gateway runs (A:2126).
    public var detailLine: String {
        "\(origin)  \u{B7}  \(backendName) \(backendVersion)  \u{B7}  \(accountCount) account\(accountCount == 1 ? "" : "s")  \u{B7}  \(modelsOffered) models offered"
    }

    /// The backend bar's sentence, or nil when the bar is not shown (A:2887-2905).
    public func updateText(timeZone: TimeZone = .current) -> String? {
        if let update, update.available {
            let released = update.publishedAt.map { ", released " + Format.formatter("d MMM HH:mm", timeZone).string(from: $0) } ?? ""
            return "CLIProxyAPI \(update.latest) is available (you run \(lockVersion))\(released). Updating tries it first and keeps \(lockVersion) for rollback."
        }
        if let previousVersion { return "Running CLIProxyAPI \(lockVersion). The previous version \(previousVersion) is kept." }
        return nil
    }

    /// The line under the Models list (A:2197-2201).
    public func catalogNote(now: Date, timeZone: TimeZone = .current) -> String {
        if let catalogError { return "Model catalog not reachable: " + catalogError }
        if let catalogCheckedAt { return "Last checked " + Format.ago(catalogCheckedAt, now: now, timeZone: timeZone) + "." }
        return "Not checked yet."
    }
}

extension LoginProvider {
    /// The services the gateway can sign in to, when the status has not said (A:545-553).
    public static let defaults = [LoginProvider(key: "claude", label: "Claude"), LoginProvider(key: "codex", label: "ChatGPT (Codex)"),
                                  LoginProvider(key: "antigravity", label: "Gemini (Antigravity)"), LoginProvider(key: "kimi", label: "Kimi")]

    /// The sign-in tile's second line (A:607-612).
    public var details: String {
        switch key {
        case "claude": return "Claude Pro or Max. Opens claude.ai."
        case "codex": return "ChatGPT Plus or Pro. Opens chatgpt.com."
        case "antigravity": return "Google AI Pro or Ultra. Opens accounts.google.com."
        case "kimi": return "Kimi Code. You type a short code on kimi.com."
        default: return ""
        }
    }
}

extension KeyProvider {
    public var stateText: String {
        switch state {
        case .saved: return "Saved"
        case .unreadable: return "Saved, cannot be read: add it again"
        case .notSet: return "Not set"
        }
    }

    public var stateTone: Tone {
        switch state {
        case .saved: return .ok
        case .unreadable: return .bad
        case .notSet: return .muted
        }
    }

    /// The label of the saved key's region; "" when no readable key is saved (A:2159, A:2229-2236).
    public var regionLabel: String {
        guard let savedRegion else { return "" }
        return regions.first { $0.key == savedRegion }?.label ?? savedRegion
    }
}

extension Rung {
    public var state: RungState { !available ? .unavailable : coolingUntil != nil ? .cooling : .ok }

    public func why(now: Date) -> String {
        switch state {
        case .ok: return "can serve"
        case .cooling: return "sitting out after running out of quota, back in " + Format.until(coolingUntil ?? now, now: now)
        case .unavailable: return "no account or key"
        }
    }
}

extension Lane { public var title: String { "lane-" + name } }

extension Routing {
    /// A:2691-2693.
    public var note: String {
        if activeName == "custom" { return "Custom ladders, edited in settings.json. Pick a preset to replace them." }
        let summary = presets.first { $0.name == activeName }?.summary ?? ""
        return "Active: \(activeLabel). \(summary)"
    }
}

extension ChatModel {
    /// A:2761-2771.
    public var statusText: String {
        switch reason {
        case "new": return "NEW \u{B7} found automatically"
        case "known": return "Offered"
        case "switched on": return "Offered (you switched it on)"
        case "switched off": return "Off (you switched it off)"
        case "older generation": return "Hidden: older generation"
        case "not a chat model": return "Hidden: not a chat model"
        case "not in the catalog": return "Hidden: no details known"
        default: return reason
        }
    }

    /// A:2715-2718.
    public var serviceLabel: String {
        switch account {
        case "claude": return "Claude"
        case "codex": return "ChatGPT"
        case "antigravity": return "Gemini (Google)"
        case "kimi": return "Kimi"
        default: return account
        }
    }

    public var contextText: String { Format.tokens(contextWindow) }
    public var outputText: String { Format.tokens(maxTokens) }
    public var reasoningText: String { efforts.isEmpty ? "none" : efforts.joined(separator: ", ") }
    public var tooltip: String { (name.isEmpty ? "" : name + "  \u{B7}  ") + "Service: " + serviceLabel }
    /// New and offered: brass and bold (A:2791).
    public var highlighted: Bool { reason == "new" && offered }
    public var tone: Tone { highlighted ? .accent : offered ? .normal : .muted }

    /// Offered ones, the ones switched off, and the hidden ones when asked; new and offered first, then by
    /// service and id (A:2729-2745).
    public static func visible(_ models: [ChatModel], showHidden: Bool) -> [ChatModel] {
        models.filter { $0.offered || showHidden || $0.reason == "switched off" }.sorted { a, b in
            let newA = a.isNew && a.offered, newB = b.isNew && b.offered
            if newA != newB { return newA }
            if a.account != b.account { return a.account.compare(b.account, options: .literal) == .orderedAscending }
            return a.id.compare(b.id, options: .literal) == .orderedAscending
        }
    }
}

extension Suggestion {
    public var text: String { "Newer model: \(to) could replace \(from) on lane \(lanes.joined(separator: ", "))." }
}

extension HarnessProfile {
    /// A:2222.
    public var pointing: String {
        if let error { return error }
        if routeCount == 0 { return "Not applied" }
        return current ? "Yes" : "No: apply again"
    }

    public var good: Bool { routeCount > 0 && current && error == nil }
}

// MARK: - The fast check and requests in flight (A:5825-5840, A:6376-6425)

extension FastStatus {
    public static func read(_ object: [String: Any]) -> FastStatus {
        var rest = object
        rest.removeValue(forKey: "inFlight")
        let data = (try? JSONSerialization.data(withJSONObject: rest, options: [.sortedKeys])) ?? Data()
        return FastStatus(inFlight: InFlight.count(object), print: String(decoding: data, as: UTF8.self))
    }
}

public enum InFlight {
    /// The count in a status answer: a number of at least 1, else 0; at most 1,000,000.
    public static func count(_ object: [String: Any]) -> Int {
        guard let number = JSONValue.number(object["inFlight"]), !number.isNaN, number >= 1 else { return 0 }
        return number > 1_000_000 ? 1_000_000 : Int(number.rounded(.down))
    }

    private static func requests(_ count: Int) -> String {
        count == 1 ? "1 model request was in flight" : "\(count) model requests were in flight"
    }

    private static func unanswered(_ count: Int) -> String {
        "The gateway did not answer when it was last checked, so requests may be in flight."
            + (count <= 0 ? "" : count == 1 ? " 1 model request was in flight when it last answered." : " \(count) model requests were in flight when it last answered.")
    }

    /// What Stop and Quit ask before they cut requests.
    public static func cutQuestion(count: Int, unanswered isUnanswered: Bool, quitting: Bool) -> String {
        let ask = quitting ? "Quit anyway?" : "Stop anyway?"
        if isUnanswered {
            return unanswered(count) + " " + (quitting ? "Quitting stops the gateway now and cuts any that are" : "Stopping the gateway now cuts any that are") + ".\n\n" + ask
        }
        return requests(count) + " when the gateway was last checked, a few seconds ago at most. "
            + (quitting ? "Quitting stops the gateway now and cuts " : "Stopping the gateway now cuts ") + (count == 1 ? "it" : "them") + ".\n\n" + ask
    }

    /// What a restart for a key change asks when the gateway could not be asked to wait for an idle moment.
    public static func restartQuestion(count: Int, unanswered isUnanswered: Bool) -> String {
        if isUnanswered { return unanswered(count) + " Restarting the gateway now cuts any that are.\n\nRestart anyway?" }
        return requests(count) + " when the gateway was last checked, a few seconds ago at most. Restarting the gateway now cuts " + (count == 1 ? "it" : "them") + ".\n\nRestart anyway?"
    }

    /// The question after a key change (A:4536-4537).
    public static func restartOffer(output: String, inFlight: Int) -> String {
        let busy = inFlight <= 0 ? "" : "\n\n" + (inFlight == 1 ? "1 request is" : "\(inFlight) requests are") + " in flight: the restart waits for a moment with none, at most 5 minutes, and cuts nothing."
        return output + "\n\nRestart the gateway now so it uses the change?" + busy
    }

    /// A:4116.
    public static func stillBusy(_ count: Int) -> String {
        (count == 1 ? "1 request is" : "\(count) requests are")
            + " still running after 5 minutes of waiting.\n\nNothing was restarted: the gateway keeps running as it was. The key change is used after the next restart of the gateway."
    }
}

// MARK: - `GET limits` (A:2293-2531)

extension LimitLevel {
    /// Amber below 30%, red below 10% (the note's wording; the prototype's accepted difference).
    public init(left: Double) { self = left < 10 ? .critical : left < 30 ? .low : .ok }
}

extension LimitWindow {
    public var level: LimitLevel { LimitLevel(left: leftPercent) }

    /// "64% left · resets in 2 h 12 min (today 12:12)" (A:2451).
    public func line(now: Date, timeZone: TimeZone = .current) -> String {
        "\(Format.percent(leftPercent))% left \u{B7} " + Format.reset(resetsAt, now: now, timeZone: timeZone)
    }
}

extension AccountLimits {
    /// Underscores to spaces, cut to 15 characters and "…" past 16 (A:2402-2403).
    public var planText: String {
        let text = plan.replacingOccurrences(of: "_", with: " ")
        return text.count > 16 ? String(text.prefix(15)) + "\u{2026}" : text
    }

    public var showsPrimaryChip: Bool { primary && siblings > 1 }

    /// A:2423-2434.
    public var primaryAction: PrimaryAction {
        if siblings > 1 && !primary && !disabled { return .make }
        if siblings > 1 && primary { return .clear }
        return .none
    }

    /// A:2477-2483.
    public var note: AccountNote? {
        if disabled { return AccountNote(text: "Paused: DSHProxy does not use this account until you resume it.", isError: false) }
        if !supported { return AccountNote(text: "\(label) does not report its limits.", isError: false) }
        if let error { return AccountNote(text: error, isError: true) }
        return nil
    }

    public var who: String { "\(label) (\(account))" }
}

extension LimitsReport {
    public static func parse(_ object: [String: Any]) -> LimitsReport {
        let accounts = JSONValue.array(object["accounts"]).map { item -> AccountLimits in
            let entry = JSONValue.dictionary(item)
            let windows = JSONValue.array(entry["windows"]).map { window -> LimitWindow in
                let value = JSONValue.dictionary(window)
                let reported = !JSONValue.isBool(value["reported"]) || JSONValue.bool(value["reported"])
                return LimitWindow(title: JSONValue.string(value["title"]), reported: reported,
                                   leftPercent: JSONValue.number(value["leftPercent"]) ?? (reported ? 0 : 100), resetsAt: JSONValue.date(value["resetsAt"]))
            }
            return AccountLimits(file: JSONValue.string(entry["file"]), provider: JSONValue.string(entry["provider"]), label: JSONValue.string(entry["label"]),
                                 account: JSONValue.string(entry["account"]), plan: JSONValue.string(entry["plan"]), disabled: JSONValue.bool(entry["disabled"]),
                                 supported: JSONValue.bool(entry["supported"]), error: JSONValue.text(entry["error"]), primary: JSONValue.bool(entry["primary"]),
                                 siblings: Int(JSONValue.number(entry["siblings"]) ?? 1),
                                 resetsAvailable: Int(JSONValue.number(JSONValue.dictionary(entry["resets"])["available"]) ?? 0), windows: windows)
        }
        return LimitsReport(fetchedAt: JSONValue.date(object["fetchedAt"]), accounts: accounts)
    }

    /// "Lowest limit: {label} {window}, {n}% left" over every reported window (A:2324-2338).
    public var lowest: LowestLimit? {
        var found: LowestLimit?
        for account in accounts {
            for window in account.windows where window.reported && window.leftPercent < (found?.left ?? 101) {
                found = LowestLimit(text: "Lowest limit: \(account.label) \(window.title), \(Format.percent(window.leftPercent))% left", left: window.leftPercent)
            }
        }
        return found
    }
}

extension ResetCredits {
    public static func parse(_ object: [String: Any]) -> ResetCredits {
        let credits = JSONValue.array(object["credits"]).map { item -> ResetCredit in
            let value = JSONValue.dictionary(item)
            return ResetCredit(id: JSONValue.string(value["id"]), title: JSONValue.string(value["title"]),
                               description: JSONValue.text(value["description"]), expiresAt: JSONValue.date(value["expiresAt"]))
        }
        return ResetCredits(available: Int(JSONValue.number(object["available"]) ?? 0), credits: credits)
    }

    /// How many resets the danger-zone dialog says are left (A:2589).
    public var count: Int { max(available, credits.count) }
}

extension ResetCredit {
    /// "{description} · expires d MMM yyyy" (A:6521-6523).
    public func line(timeZone: TimeZone = .current) -> String {
        var detail = description ?? ""
        if let expiresAt {
            detail = (detail.isEmpty ? "" : detail + " \u{B7} ") + "expires " + Format.formatter("d MMM yyyy", timeZone).string(from: expiresAt)
        }
        return detail
    }
}

extension LoginStart {
    /// `POST login/start` (src/login.js): nil without an id.
    public static func parse(_ object: [String: Any]) -> LoginStart? {
        guard let id = JSONValue.text(object["id"]) else { return nil }
        return LoginStart(id: id, url: JSONValue.string(object["url"]), device: JSONValue.string(object["flow"]) == "device", userCode: JSONValue.string(object["userCode"]))
    }
}

extension LoginProgress {
    /// `GET login/status`.
    public static func parse(_ object: [String: Any]) -> LoginProgress {
        switch JSONValue.string(object["status"]) {
        case "ok": return .ok(account: JSONValue.string(object["account"]))
        case "error": return .error(JSONValue.text(object["error"]) ?? "The sign-in failed.")
        default: return .wait
        }
    }
}

public enum Links {
    /// A sign-in address to open in the browser: only an absolute https address (A:726-733).
    public static func signInURL(_ text: String) -> URL? {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)), url.scheme?.lowercased() == "https",
              let host = url.host, !host.isEmpty else { return nil }
        return url
    }
}
