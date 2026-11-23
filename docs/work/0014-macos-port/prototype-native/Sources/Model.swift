// Synthetic, in-memory data for the DSHProxy macOS prototype.
// Every value here is made up (a@example.com …, fake versions and limits).
// Texts and data follow ../prototype/index.html, which was accepted as the content reference.

import Foundation
import SwiftUI

// MARK: - Gateway, workspace, sections

enum Gateway: String, CaseIterable {
    case running, starting, notAnswering, stopped

    var menuText: String {
        switch self {
        case .running: return "DSHProxy: running"
        case .starting: return "DSHProxy: starting"
        case .notAnswering: return "DSHProxy: not answering"
        case .stopped: return "DSHProxy: stopped"
        }
    }

    var chipText: String {
        switch self {
        case .running: return "Running"
        case .starting: return "Starting"
        case .notAnswering: return "Not answering"
        case .stopped: return "Stopped"
        }
    }

    var color: Color {
        switch self {
        case .running: return .green
        case .starting, .notAnswering: return .orange
        case .stopped: return .red
        }
    }
}

enum Workspace: String, CaseIterable, Identifiable {
    case chat, video
    var id: String { rawValue }
    var title: String { self == .chat ? "Chat" : "Video" }
    var hint: String {
        self == .chat ? "Chat accounts, keys, lanes and models."
                      : "Video routing setup. Nothing is generated or charged from this window."
    }
}

enum Section: Int, CaseIterable, Identifiable {
    case accounts, apiKeys, lanes, models, harness, log
    var id: Int { rawValue }
    var title: String {
        switch self {
        case .accounts: return "Accounts"
        case .apiKeys: return "API keys"
        case .lanes: return "Lanes"
        case .models: return "Models"
        case .harness: return "DeepSeek Harness"
        case .log: return "Log"
        }
    }
}

// MARK: - Catalogue

struct Service {
    let id: String, label: String, letters: String, hue: Double, desc: String, tile: String, device: Bool
}

let SERVICE_ORDER = ["claude", "codex", "antigravity", "kimi"]
let SERVICES: [String: Service] = [
    "claude": Service(id: "claude", label: "Claude", letters: "Cl", hue: 22, desc: "Claude Pro or Max. Opens claude.ai.", tile: "Claude", device: false),
    "codex": Service(id: "codex", label: "ChatGPT", letters: "Ch", hue: 160, desc: "ChatGPT Plus or Pro. Opens chatgpt.com.", tile: "ChatGPT (Codex)", device: false),
    "antigravity": Service(id: "antigravity", label: "Gemini", letters: "Ge", hue: 215, desc: "Google AI Pro or Ultra. Opens accounts.google.com.", tile: "Gemini (Antigravity)", device: false),
    "kimi": Service(id: "kimi", label: "Kimi", letters: "Ki", hue: 270, desc: "Kimi Code. You type a short code on kimi.com.", tile: "Kimi", device: true),
]

struct KeyProvider: Identifiable {
    let id: String, label: String, letters: String, hue: Double, regions: [String]?
}

let KEY_PROVIDERS: [KeyProvider] = [
    KeyProvider(id: "deepseek", label: "DeepSeek", letters: "DS", hue: 205, regions: nil),
    KeyProvider(id: "moonshot", label: "Moonshot", letters: "Mo", hue: 250, regions: nil),
    KeyProvider(id: "zai", label: "Z.ai", letters: "Z", hue: 120, regions: ["International", "China"]),
    KeyProvider(id: "qwen", label: "Qwen", letters: "Qw", hue: 285, regions: ["International", "China"]),
    KeyProvider(id: "minimax", label: "MiniMax", letters: "MM", hue: 340, regions: ["International", "China"]),
    KeyProvider(id: "mistral", label: "Mistral", letters: "Mi", hue: 30, regions: nil),
    KeyProvider(id: "openrouter", label: "OpenRouter", letters: "OR", hue: 180, regions: nil),
]
func keyProvider(_ id: String) -> KeyProvider { KEY_PROVIDERS.first { $0.id == id }! }

struct Preset: Identifiable {
    let id: String, label: String, summary: String, lanes: [String: [String]]
}

let LANES = ["main", "scout", "builder", "architect", "reviewer", "google"]

let PRESETS: [Preset] = [
    Preset(id: "performance", label: "Max performance",
           summary: "The strongest model each lane can reach, whatever it costs. Slowest and most quota-hungry.",
           lanes: ["main": ["gpt-6-astra", "claude-opus-5-5", "claude-fable-5-2", "gemini-4-carbon-high"],
                   "scout": ["claude-sonnet-5-5", "gpt-6.1-sol", "gemini-4-argon-high", "deepseek/deepseek-v4-pro"],
                   "builder": ["gpt-6-astra", "claude-sonnet-5-5", "claude-fable-5-2", "gemini-4-argon-high"],
                   "architect": ["claude-fable-5-2", "gpt-6.1-terra", "claude-opus-5-5", "gemini-4-carbon-high"],
                   "reviewer": ["gemini-4-carbon-high", "claude-opus-5-5", "deepseek/deepseek-v4-pro"],
                   "google": ["gemini-4-carbon-high", "gemini-4-hydrogen-xhigh", "gemini-3.8-flash-high", "gemini-3.8-flash-tiered"]]),
    Preset(id: "balanced", label: "Balanced",
           summary: "Strong models first with cheaper ones as failover. The working default.",
           lanes: ["main": ["gpt-6-astra", "claude-fable-5-2", "claude-opus-5-5", "gemini-4-carbon-high", "deepseek/deepseek-v4-pro"],
                   "scout": ["claude-haiku-5-5", "gemini-3.8-flash-high", "gpt-6-luna", "deepseek/deepseek-flash", "qwen/qwen3.8-flash"],
                   "builder": ["gpt-6-astra", "claude-sonnet-5-5", "deepseek/deepseek-v4-pro", "gemini-4-argon-high"],
                   "architect": ["claude-fable-5-2", "gpt-6.1-terra", "claude-opus-5-5", "deepseek/deepseek-v4-pro", "gemini-4-argon-high"],
                   "reviewer": ["gemini-4-carbon-high", "deepseek/deepseek-v4-pro", "claude-opus-5-5"],
                   "google": ["gemini-3.8-flash-high", "gemini-4-carbon-high", "gemini-4-hydrogen-xhigh", "gemini-3.8-flash-tiered"]]),
    Preset(id: "cheap", label: "Cheap production",
           summary: "Subscription quota first, then the cheapest paid models. Leaves GPT and Opus out.",
           lanes: ["main": ["claude-haiku-5-5", "gemini-3.8-flash-high", "gemini-4-carbon-high", "deepseek/deepseek-flash"],
                   "scout": ["gemini-3.8-flash-high", "claude-haiku-5-5", "deepseek/deepseek-flash", "qwen/qwen3.8-flash"],
                   "builder": ["claude-haiku-5-5", "gemini-4-argon-high", "deepseek/deepseek-v4-pro", "qwen/qwen3.8-flash"],
                   "architect": ["claude-sonnet-5-5", "gemini-4-carbon-high", "deepseek/deepseek-v4-pro", "gemini-4-argon-high"],
                   "reviewer": ["gemini-3.8-flash-high", "deepseek/deepseek-flash", "claude-haiku-5-5"],
                   "google": ["gemini-3.8-flash-high", "gemini-3.1-flash-lite", "gemini-3-flash", "gemini-4-hydrogen-xhigh"]]),
]
func presetNamed(_ id: String) -> Preset? { PRESETS.first { $0.id == id } }

func serviceOf(_ model: String) -> String {
    if model.hasPrefix("claude") { return "claude" }
    if model.hasPrefix("gpt") { return "codex" }
    if model.hasPrefix("gemini") { return "antigravity" }
    if model.hasPrefix("kimi") { return "kimi" }
    return String(model.split(separator: "/").first ?? Substring(model))
}

func serviceLabel(_ s: String) -> String {
    SERVICES[s]?.label ?? KEY_PROVIDERS.first { $0.id == s }?.label ?? s
}

struct VRoute { let id: String, label: String, units: String }
let VROUTES: [String: VRoute] = [
    "krea": VRoute(id: "krea", label: "Krea workspace", units: "workspace compute units"),
    "videorouter": VRoute(id: "videorouter", label: "VideoRouter", units: "USD"),
    "kovapi": VRoute(id: "kovapi", label: "KovAPI", units: "KovAPI credits"),
    "callirra": VRoute(id: "callirra", label: "Callirra", units: "USD"),
]

struct Company { let label: String, letters: String, hue: Double }
let COMPANIES: [String: Company] = [
    "alibaba": Company(label: "Alibaba", letters: "Al", hue: 25),
    "minimax": Company(label: "MiniMax", letters: "MM", hue: 340),
    "bytedance": Company(label: "ByteDance", letters: "BD", hue: 200),
]

struct VKeyProvider: Identifiable { let id: String, label: String, letters: String, hue: Double, variable: String }
let VKEY_PROVIDERS: [VKeyProvider] = [
    VKeyProvider(id: "videorouter", label: "VideoRouter", letters: "VR", hue: 45, variable: "VIDEOROUTER_API_KEY"),
    VKeyProvider(id: "kovapi", label: "KovAPI", letters: "Ka", hue: 95, variable: "KOVAPI_API_KEY"),
    VKeyProvider(id: "callirra", label: "Callirra", letters: "Ca", hue: 325, variable: "CALLIRRA_API_KEY"),
]
func vkeyProvider(_ id: String) -> VKeyProvider { VKEY_PROVIDERS.first { $0.id == id }! }

// MARK: - Data

struct LimitWindow: Identifiable, Hashable {
    let id = UUID()
    var title: String
    var left: Int?        // nil = not reported for this plan
    var minutes: Int?     // minutes until reset; nil = not reported
}

struct ResetCredit: Identifiable, Hashable {
    let id: String, title: String, description: String, expires: String
}

struct Account: Identifiable, Hashable {
    let id: String
    var provider: String
    var email: String
    var plan: String
    var primary: Bool
    var disabled: Bool
    var supported: Bool
    var windows: [LimitWindow]
    var credits: [ResetCredit]

    var service: Service { SERVICES[provider]! }
    var who: String { "\(service.label) (\(email))" }
    var planText: String {
        let p = plan.replacingOccurrences(of: "_", with: " ")
        return p.count > 16 ? String(p.prefix(15)) + "…" : p
    }
}

enum KeyState { case saved, unreadable, none }
struct ChatKey { var state: KeyState; var region: String? }

struct ModelRow: Identifiable, Hashable {
    let id: String
    var ctx: Int, out: Int, reasoning: String
    var reason: String     // new, auto, user-on, user-off, older, notchat, nodetails
    var offered: Bool
    var service: String { serviceOf(id) }
}

struct Profile: Identifiable, Hashable {
    var name: String, routes: Int, models: Int
    var points: String     // yes, stale, none
    var id: String { name }
}

enum VideoTools { case installed, off, notInstalled, notAvailable
    var text: String {
        switch self {
        case .installed: return "Installed and switched on"
        case .off: return "Installed, switched off"
        case .notInstalled: return "Not installed: press Apply to DeepSeek Harness"
        case .notAvailable: return "Not available on macOS yet"
        }
    }
    var color: Color {
        switch self { case .installed: return .green; case .off, .notInstalled: return .orange; case .notAvailable: return .red }
    }
}

enum KreaState: Equatable { case signedIn(Date), signing, none }

struct VKey { var state: KeyState; var env: Bool }

struct VModel: Identifiable, Hashable {
    let id: String
    var company: String
    var enabled: Bool
    var route: String?
    var allowed: [String]
    var validRoute: Bool { route.map { allowed.contains($0) } ?? false }
}

struct Suggestion { var to: String, from: String }

struct DataSet {
    var accounts: [Account]
    var keys: [String: ChatKey]
    var preset: String                 // preset id or "custom"
    var lanes: [String: [String]]
    var cooling: [String: Int]         // model -> minutes until back
    var models: [ModelRow]
    var suggestion: Suggestion?
    var showHidden: Bool
    var modelsChecked: Int?            // minutes ago; nil = not checked yet
    var profiles: [Profile]
    var videoTools: VideoTools
    var krea: KreaState
    var vkeys: [String: VKey]
    var vmodels: [VModel]
    var vRead: Date

    static func sample(now: Date = Date()) -> DataSet {
        func m(_ id: String, _ ctx: Int, _ out: Int, _ r: String, _ reason: String, _ offered: Bool) -> ModelRow {
            ModelRow(id: id, ctx: ctx, out: out, reasoning: r, reason: reason, offered: offered)
        }
        return DataSet(
            accounts: [
                Account(id: "a1", provider: "claude", email: "a@example.com", plan: "max_20x", primary: true, disabled: false, supported: true,
                        windows: [LimitWindow(title: "5-hour", left: 64, minutes: 132),
                                  LimitWindow(title: "Weekly", left: 27, minutes: 3 * 1440 + 305),
                                  LimitWindow(title: "Weekly · Opus", left: 81, minutes: 3 * 1440 + 305)], credits: []),
                Account(id: "a2", provider: "claude", email: "b@example.com", plan: "pro", primary: false, disabled: false, supported: true,
                        windows: [LimitWindow(title: "5-hour", left: 8, minutes: 41),
                                  LimitWindow(title: "Weekly", left: 46, minutes: 5 * 1440 + 70)], credits: []),
                Account(id: "a3", provider: "codex", email: "c@example.com", plan: "pro", primary: false, disabled: false, supported: true,
                        windows: [LimitWindow(title: "5-hour", left: 91, minutes: 250),
                                  LimitWindow(title: "Weekly", left: 14, minutes: 1440 + 600),
                                  LimitWindow(title: "Code review", left: nil, minutes: nil)],
                        credits: [ResetCredit(id: "cr1", title: "Weekly limit reset", description: "Included with ChatGPT Pro", expires: "31 Dec 2026"),
                                  ResetCredit(id: "cr2", title: "Weekly limit reset", description: "Promotional credit", expires: "15 Jan 2027")]),
                Account(id: "a4", provider: "antigravity", email: "d@example.com", plan: "google_ai_ultra", primary: false, disabled: false, supported: true,
                        windows: [LimitWindow(title: "Daily", left: 72, minutes: 610)], credits: []),
                Account(id: "a5", provider: "kimi", email: "e@example.com", plan: "kimi_code", primary: false, disabled: true, supported: false,
                        windows: [], credits: []),
            ],
            keys: ["deepseek": ChatKey(state: .saved, region: nil), "moonshot": ChatKey(state: .none, region: nil),
                   "zai": ChatKey(state: .unreadable, region: "International"), "qwen": ChatKey(state: .none, region: "International"),
                   "minimax": ChatKey(state: .none, region: "China"), "mistral": ChatKey(state: .none, region: nil),
                   "openrouter": ChatKey(state: .saved, region: nil)],
            preset: "balanced",
            lanes: presetNamed("balanced")!.lanes,
            cooling: ["gpt-6.1-terra": 23],
            models: [
                m("claude-opus-5-6", 1_000_000, 128_000, "low, medium, high, max", "new", true),
                m("gpt-6-astra", 400_000, 128_000, "low, medium, high, xhigh", "auto", true),
                m("gpt-6.1-terra", 400_000, 128_000, "low, medium, high, xhigh", "auto", true),
                m("gpt-6.1-sol", 400_000, 128_000, "low, medium, high", "auto", true),
                m("gpt-6-luna", 272_000, 64_000, "minimal, low, medium", "user-off", false),
                m("claude-opus-5-5", 1_000_000, 128_000, "low, medium, high, max", "auto", true),
                m("claude-fable-5-2", 1_000_000, 64_000, "low, medium, high", "auto", true),
                m("claude-sonnet-5-5", 1_000_000, 64_000, "low, medium, high", "auto", true),
                m("claude-haiku-5-5", 200_000, 64_000, "none", "auto", true),
                m("gemini-4-carbon-high", 2_000_000, 65_000, "high", "auto", true),
                m("gemini-4-argon-high", 1_000_000, 65_000, "high", "auto", true),
                m("gemini-4-hydrogen-xhigh", 1_000_000, 65_000, "xhigh", "auto", true),
                m("gemini-3.8-flash-high", 1_000_000, 65_000, "high", "auto", true),
                m("gemini-3.8-flash-tiered", 1_000_000, 65_000, "low, medium, high", "user-on", true),
                m("gemini-3.1-flash-lite", 1_000_000, 65_000, "none", "older", false),
                m("gemini-3-flash", 1_000_000, 65_000, "none", "older", false),
                m("kimi-k3", 256_000, 32_000, "none", "auto", true),
                m("deepseek/deepseek-v4-pro", 1_000_000, 64_000, "high", "auto", true),
                m("deepseek/deepseek-flash", 256_000, 32_000, "none", "auto", true),
                m("qwen/qwen3.8-flash", 1_000_000, 32_000, "none", "auto", true),
                m("gemini-embedding-3", 8_000, 0, "none", "notchat", false),
            ],
            suggestion: Suggestion(to: "claude-opus-5-6", from: "claude-opus-5-5"),
            showHidden: false,
            modelsChecked: 42,
            profiles: [Profile(name: "desktop", routes: 6, models: 19, points: "yes"),
                       Profile(name: "work", routes: 6, models: 18, points: "stale")],
            videoTools: .installed,
            krea: .signedIn(now.addingTimeInterval(89 * 86400)),
            vkeys: ["videorouter": VKey(state: .saved, env: false), "kovapi": VKey(state: .none, env: false), "callirra": VKey(state: .none, env: true)],
            vmodels: [
                VModel(id: "wan-3.0", company: "alibaba", enabled: true, route: "krea", allowed: ["krea", "videorouter", "kovapi"]),
                VModel(id: "minimax-h3", company: "minimax", enabled: true, route: nil, allowed: ["krea", "callirra"]),
                VModel(id: "seedance-2-pro", company: "bytedance", enabled: false, route: "videorouter", allowed: ["videorouter", "kovapi", "callirra"]),
                VModel(id: "seedance-2-lite", company: "bytedance", enabled: false, route: nil, allowed: ["videorouter", "kovapi", "callirra"]),
            ],
            vRead: now)
    }

    static func empty(now: Date = Date()) -> DataSet {
        var d = sample(now: now)
        d.accounts = []
        for k in d.keys.keys { d.keys[k]!.state = .none }
        d.cooling = [:]
        d.suggestion = nil
        d.models = d.models.filter { $0.id != "claude-opus-5-6" }.map { m in
            var m = m
            if m.reason == "user-off" || m.reason == "user-on" { m.reason = "auto" }
            m.offered = !["older", "notchat"].contains(m.reason)
            return m
        }
        d.modelsChecked = nil
        d.profiles = []
        d.videoTools = .notInstalled
        d.krea = .none
        for k in d.vkeys.keys { d.vkeys[k] = VKey(state: .none, env: false) }
        for i in d.vmodels.indices { d.vmodels[i].enabled = false; d.vmodels[i].route = nil }
        return d
    }
}

struct Backend { var current: String, latest: String?, released: String, previous: String?, busy: Bool }

struct LogLine: Identifiable { let id = UUID(); let time: String; let text: String; let kind: Kind
    enum Kind { case plain, action, warn, error }
}

// MARK: - Formatting

enum Fmt {
    static let en = Locale(identifier: "en_US_POSIX")

    static func hm(_ d: Date) -> String { f("HH:mm").string(from: d) }
    static func hms(_ d: Date) -> String { f("HH:mm:ss").string(from: d) }
    static func f(_ pattern: String) -> DateFormatter {
        let df = DateFormatter(); df.locale = en; df.dateFormat = pattern; return df
    }

    static func dayText(_ d: Date, now: Date = Date()) -> String {
        let cal = Calendar.current
        if cal.isDate(d, inSameDayAs: now) { return "today" }
        if let t = cal.date(byAdding: .day, value: 1, to: now), cal.isDate(d, inSameDayAs: t) { return "tomorrow" }
        return f("EEE d MMM").string(from: d)
    }

    static func resetText(_ minutes: Int?, now: Date = Date()) -> String {
        guard let min = minutes else { return "reset time not reported" }
        let d = now.addingTimeInterval(Double(min) * 60)
        let rel: String
        if min < 60 { rel = "\(min) min" }
        else if min < 1440 { rel = "\(min / 60) h \(min % 60) min" }
        else { rel = "\(min / 1440) d \((min % 1440) / 60) h" }
        return "resets in \(rel) (\(dayText(d, now: now)) \(hm(d)))"
    }

    static func tokens(_ n: Int) -> String {
        if n == 0 { return "—" }
        if n >= 1_000_000 { return n % 1_000_000 == 0 ? "\(n / 1_000_000)M" : String(format: "%.1fM", Double(n) / 1e6) }
        return "\(Int((Double(n) / 1000).rounded()))K"
    }

    static func until(_ d: Date) -> String { f("EEE d MMM yyyy, HH:mm").string(from: d) }
}

/// Bars turn amber below 30% and red below 10% (the note's wording; see README).
func levelColor(_ left: Int) -> Color { left < 10 ? .red : left < 30 ? .orange : .green }

let REASON_TEXT: [String: String] = [
    "new": "NEW · found automatically", "auto": "Offered", "user-on": "Offered (you switched it on)",
    "user-off": "Off (you switched it off)", "older": "Hidden: older generation",
    "notchat": "Hidden: not a chat model", "nodetails": "Hidden: no details known",
]
