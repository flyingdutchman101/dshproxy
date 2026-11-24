// UI-side enums, colours, log lines and logos. Every value shown comes from DSHProxyKit's mapping
// (Mapping.swift); this file only turns its tones into colours.

import AppKit
import DSHProxyKit
import SwiftUI

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

struct LogLine: Identifiable {
    enum Kind { case plain, action, warn, error }
    let id = UUID()
    let time: String
    let text: String
    let kind: Kind
}

extension Tone {
    var color: Color {
        switch self {
        case .normal: return .primary
        case .muted: return .secondary
        case .ok: return .green
        case .warn: return .orange
        case .bad: return .red
        case .accent: return .accentColor
        }
    }
}

extension LimitLevel {
    var color: Color {
        switch self {
        case .ok: return .green
        case .low: return .orange
        case .critical: return .red
        }
    }
}

func levelColor(_ left: Double) -> Color { LimitLevel(left: left).color }

/// The provider and company logos of the Windows app (app/logos/*.png, LobeHub Icons, MIT), read from the
/// DSHProxy folder the app was built in. A letter badge stands in when a logo is not there.
@MainActor
enum Logos {
    static var folder: URL?
    private static var cache: [String: NSImage] = [:]
    private static var missing: Set<String> = []

    static func image(_ name: String) -> NSImage? {
        guard !name.isEmpty, let folder else { return nil }
        if let image = cache[name] { return image }
        if missing.contains(name) { return nil }
        let url = folder.appendingPathComponent("app/logos/\(name).png")
        guard let image = NSImage(contentsOf: url) else { missing.insert(name); return nil }
        cache[name] = image
        return image
    }

    static let letters: [String: (String, Double)] = [
        "claude": ("Cl", 22), "codex": ("Ch", 160), "antigravity": ("Ge", 215), "kimi": ("Ki", 270),
        "deepseek": ("DS", 205), "moonshot": ("Mo", 250), "zai": ("Z", 120), "qwen": ("Qw", 285), "minimax": ("MM", 340),
        "mistral": ("Mi", 30), "openrouter": ("OR", 180), "krea": ("Kr", 300), "alibaba": ("Al", 25), "bytedance": ("BD", 200),
        "gemini": ("Ge", 215),
    ]
}

enum Fmt {
    static func hms(_ date: Date) -> String { Format.clock(date) }
}
