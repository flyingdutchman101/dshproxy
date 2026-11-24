import Foundation

// The values the app shows, read from the JSON the CLI and the gateway print. Plain structs, no UI: the
// pure functions that make them are in MappingLogic.swift (chat side) and VideoMapping.swift (video side,
// DeepSeek Harness setup, Krea). Shapes are those of src/cli.js statusJson, src/daemon.js control routes,
// src/limits.js, src/video/command.js, src/dsh/bundle.js and bin/dshproxy-krea.js; texts are the Windows
// app's (app/DSHProxyApp.cs), see docs/work/0014-macos-port/research/app-inventory.md.

/// How a value is coloured: the app maps it to its own colours.
public enum Tone: Equatable { case normal, muted, ok, warn, bad, accent }

// MARK: - `status --json`

public struct FullStatus: Equatable {
    public var running: Bool
    /// "" when the status did not say.
    public var origin: String
    public var home: String
    /// Requests in flight (0 when not said; see InFlight.count).
    public var inFlight: Int
    public var backendName: String
    public var backendVersion: String
    /// The version in the lock file (backendLock.version) and the one kept for rollback.
    public var lockVersion: String
    public var previousVersion: String?
    public var update: BackendUpdate?
    public var accountCount: Int
    /// `models` (what is offered to DeepSeek Harness, lanes included).
    public var modelsOffered: Int
    public var loginProviders: [LoginProvider]
    public var keyProviders: [KeyProvider]
    public var lanes: [Lane]
    public var routing: Routing
    public var models: [ChatModel]
    public var catalogError: String?
    public var catalogCheckedAt: Date?
    public var suggestions: [Suggestion]
    public var profiles: [HarnessProfile]
}

public struct BackendUpdate: Equatable {
    public var available: Bool
    public var latest: String
    public var publishedAt: Date?
}

public struct LoginProvider: Equatable, Identifiable, Hashable {
    public var key: String
    public var label: String
    public var id: String { key }
    public init(key: String, label: String) { self.key = key; self.label = label }
}

public struct KeyRegion: Equatable, Hashable, Identifiable {
    public var key: String
    public var label: String
    public var id: String { key }
}

public enum KeyState: Equatable { case saved, unreadable, notSet }

public struct KeyProvider: Equatable, Identifiable {
    public var key: String
    public var label: String
    public var regions: [KeyRegion]
    public var state: KeyState
    /// The region key of a readable saved key.
    public var savedRegion: String?
    public var id: String { key }
}

public enum RungState: Equatable { case ok, cooling, unavailable }

public struct Rung: Equatable, Hashable {
    public var model: String
    public var available: Bool
    public var coolingUntil: Date?
}

public struct Lane: Equatable, Identifiable {
    public var name: String
    public var rungs: [Rung]
    public var id: String { name }
}

public struct RoutingPreset: Equatable, Identifiable {
    public var name: String
    public var label: String
    public var summary: String
    public var id: String { name }
}

public struct Routing: Equatable {
    /// "custom" when the ladders match no preset.
    public var activeName: String
    public var activeLabel: String
    public var presets: [RoutingPreset]
}

public struct ChatModel: Equatable, Identifiable {
    public var id: String
    public var name: String
    /// The service: claude, codex, antigravity, kimi (or another account key).
    public var account: String
    public var contextWindow: Double
    public var maxTokens: Double
    public var efforts: [String]
    public var isNew: Bool
    public var offered: Bool
    /// new, known, switched on, switched off, older generation, not a chat model, not in the catalog.
    public var reason: String
}

public struct Suggestion: Equatable, Identifiable {
    public var from: String
    public var to: String
    public var lanes: [String]
    public var id: String { from + ">" + to }
}

public struct HarnessProfile: Equatable, Identifiable {
    public var profile: String
    public var routeCount: Int
    public var modelCount: Int
    public var current: Bool
    public var error: String?
    public var id: String { profile }
}

/// What the fast check (GET /dshproxy/status) gave: the count and everything else as one text, which changes
/// only when something other than the count does.
public struct FastStatus: Equatable {
    public var inFlight: Int
    public var print: String
}

// MARK: - `GET limits`, `GET resets`, sign-in

public enum LimitLevel: Equatable { case ok, low, critical }

public struct LimitWindow: Equatable, Identifiable {
    public var title: String
    public var reported: Bool
    public var leftPercent: Double
    public var resetsAt: Date?
    public var id: String { title }
}

public enum PrimaryAction: Equatable { case none, make, clear }

public struct AccountNote: Equatable {
    public var text: String
    public var isError: Bool
    public init(text: String, isError: Bool) { self.text = text; self.isError = isError }
}

public struct AccountLimits: Equatable, Identifiable {
    public var file: String
    public var provider: String
    public var label: String
    public var account: String
    public var plan: String
    public var disabled: Bool
    public var supported: Bool
    public var error: String?
    public var primary: Bool
    public var siblings: Int
    public var resetsAvailable: Int
    public var windows: [LimitWindow]
    public var id: String { file }
}

public struct LimitsReport: Equatable {
    public var fetchedAt: Date?
    public var accounts: [AccountLimits]
}

public struct LowestLimit: Equatable {
    public var text: String
    public var left: Double
    public init(text: String, left: Double) { self.text = text; self.left = left }
}

public struct ResetCredit: Equatable, Identifiable, Hashable {
    public var id: String
    public var title: String
    public var description: String?
    public var expiresAt: Date?
}

public struct ResetCredits: Equatable {
    public var available: Int
    public var credits: [ResetCredit]
}

public struct LoginStart: Equatable {
    public var id: String
    public var url: String
    public var device: Bool
    public var userCode: String
    public init(id: String, url: String, device: Bool, userCode: String) { self.id = id; self.url = url; self.device = device; self.userCode = userCode }
}

public enum LoginProgress: Equatable { case wait, ok(account: String), error(String) }

// MARK: - Video settings and keys

public struct VideoModel: Equatable, Identifiable {
    public var id: String
    public var enabled: Bool
    /// "" when no route is saved.
    public var route: String
    /// The billing routes DSHProxy allows for this model.
    public var routes: [String]
}

public struct VideoKeyProvider: Equatable, Identifiable {
    public var id: String
    public var label: String
    public var variable: String
    public var routes: [String]
    public var saved: Bool
    /// False for a saved key that cannot be decrypted.
    public var readable: Bool
    public var inEnvironment: Bool
}

// MARK: - DeepSeek Harness setup (`dsh bundle status|install --json`)

public enum SetupMark: Equatable { case done, toDo, cannot, note }

public struct SetupLine: Equatable, Hashable {
    public var mark: SetupMark
    public var text: String
    public var detail: String
    public init(_ mark: SetupMark, _ text: String, _ detail: String = "") { self.mark = mark; self.text = text; self.detail = detail }
}

public struct SetupResult: Equatable {
    public var heading: String
    public var lines: [SetupLine]
    /// The folder a button copies, for installing by hand; nil when there is nothing to copy.
    public var copyPath: String?
}

public struct HarnessSetup: Equatable {
    public enum Kind: Equatable { case installed, switchedOff, otherFolder, folderMissing, notInstalled, neverOpened, notFound, unreadable }
    /// What an Apply does about the video tools.
    public enum Plan: Equatable { case nothing, install, installAfterQuit, cannot, unknown }
    /// What an Apply did about them.
    public enum Outcome: Equatable { case nothingToInstall, installed, failed, skipped }

    public var state: Kind
    public var harnessFound = false
    public var profileExists = false
    public var harnessRunning = false
    public var canInstall = false
    public var canInstallAfterQuit = false
    public var folder = ""
    public var linkedTo = ""
    public var version = ""
    public var reason = ""
}

public struct HarnessInstall: Equatable {
    public var ok: Bool
    public var message: String
    public var log: String
    public init(ok: Bool, message: String, log: String) { self.ok = ok; self.message = message; self.log = log }
}

// MARK: - Krea helper

public struct KreaStatus: Equatable {
    public var signedIn: Bool
    /// Only meaningful when signed in.
    public var until: Date?
    public init(signedIn: Bool, until: Date?) { self.signedIn = signedIn; self.until = until }
}

public enum KreaOutcome: Equatable {
    case signedIn, cancelled, refused, loginRequired, uncertain
    case addressRefused, browserNotOpened, noAddressInTime, notFinishedInTime, notStarted, endedWithoutAddress, failed
}
