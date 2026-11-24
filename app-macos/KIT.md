# DSHProxyKit — the app's non-UI part (macOS)

Status: interface written by the lead on 24 Nov 2026 for stage D of `docs/work/0014-macos-port` (`stage-d.md`). The SwiftUI app (`Sources/DSHProxyApp`) uses only what is listed here. Everything the app does to DSHProxy goes through the gateway's status, its control API and the CLI, exactly as the Windows app (`app/DSHProxyApp.cs`) does; `docs/work/0014-macos-port/research/app-inventory.md` sections 1.11, 1.12, 3 and 4 are the reference.

Foundation only (no AppKit, no SwiftUI) so `KitChecks` can test it. macOS 13+. Swift 5.10, Command Line Tools (no Xcode, no XCTest).

## Package layout (`app-macos/`)

```
Package.swift                 targets: DSHProxyKit (library), DSHProxyApp (executable), KitChecks (executable)
Sources/DSHProxyKit/*.swift
Sources/DSHProxyApp/*.swift   the app (SwiftUI + AppKit)
Sources/KitChecks/main.swift  the checks: `swift run KitChecks` exits 0 when all pass, 1 otherwise, one line per check
build.sh                      swift build -c release; makes ../DSHProxy.app (git-ignored), ad-hoc signed
```

## Public API

```swift
public struct KitError: Error, CustomStringConvertible { public let description: String }   // always one sentence

// Where things are.
public struct Locations: Equatable {
    public let checkout: URL      // folder that holds bin/dshproxy.js
    public let node: URL          // an executable `node`
    public let home: URL          // data folder: DSHPROXY_HOME, else ~/.dshproxy
    public static let defaultNodeFolders = ["/opt/homebrew/bin", "/usr/local/bin"]
    /// checkout: env DSHPROXY_CHECKOUT, else `recordedCheckout` (written into the app's Info.plist by build.sh),
    ///           must contain bin/dshproxy.js, else KitError("DSHProxy.app does not know where the DSHProxy folder is. Build it again with app-macos/build.sh in that folder.")
    /// node: each PATH entry, then `nodeFolders`; first executable file named `node`,
    ///           else KitError("Node.js was not found. Install Node.js 22 or later.")
    public static func find(environment: [String: String], recordedCheckout: String?, nodeFolders: [String] = defaultNodeFolders, homeDirectory: URL) throws -> Locations
}

public struct CommandResult: Equatable { public let code: Int32?; public let stdout: String; public let stderr: String; public let timedOut: Bool }

// Runs `node <checkout>/bin/<script> <args>` once. Working directory: checkout. Environment: the app's own,
// unchanged. `input`, when given, is written to standard input and standard input is closed; it never appears in
// the arguments or the environment (keys travel this way). On `timeout` the command and everything it started
// (its own process group) is ended: SIGTERM, then SIGKILL after 2 s; `timedOut` true, `code` nil.
public enum Script: String { case dshproxy = "dshproxy.js", krea = "dshproxy-krea.js" }
public struct CommandRunner {
    public init(locations: Locations)
    public func run(_ script: Script = .dshproxy, _ args: [String], input: String? = nil, timeout: TimeInterval) async -> CommandResult
}

// The token-free status of a gateway, as GET {origin}/dshproxy/status returns it. nil when nothing answers
// with HTTP 200 and a JSON object within `timeout`.
public enum StatusProbe {
    public static func fetch(origin: URL, timeout: TimeInterval = 2) async -> [String: Any]?
}

// The control API: {origin}/dshproxy/control/{route}. Reads {home}/control.token fresh on every call and sends it
// in `x-dshproxy-token`; never sends an `Origin` header; JSON body (or none); timeout per call.
public enum ControlError: Error, Equatable, CustomStringConvertible {
    case notRunning            // "The gateway is not running. Press Start first."      (no token file)
    case noAnswer              // "The gateway did not answer. Is it running?"          (connection failed / timeout)
    case refused(String)       // the gateway's {error} text, or "The gateway refused (HTTP n)."
}
public struct ControlClient {
    public init(origin: URL, home: URL)
    public func call(_ method: String, _ route: String, body: [String: Any]? = nil, query: [String: String] = [:], timeout: TimeInterval = 20) async throws -> [String: Any]
}

// The gateway this app starts and stops (inventory 1.11).
public enum StartOutcome: Equatable { case started(pid: Int32), alreadyRunning, failed(String) }
public final class GatewayProcess {
    public init(locations: Locations)
    /// Lines the gateway prints (stdout and stderr), one at a time, on any thread.
    public var onOutput: (String) -> Void
    /// Called once when this app's gateway process ends (exit code or signal).
    public var onExit: (Int32) -> Void
    public var ownPID: Int32? { get }           // nil when this app has no running gateway
    /// Probes `origin` first: something answering → .alreadyRunning, nothing started.
    /// Otherwise runs `node bin/dshproxy.js start` (cwd checkout, own process group, stdin /dev/null).
    public func start(origin: URL) async -> StartOutcome
    /// Only this app's own gateway: SIGTERM to its process (the gateway stops its backend and exits), wait up to
    /// 10 s, then SIGKILL its process group. Returns false when there was no own gateway.
    public func stop() async -> Bool
}

// `dshproxy stop --when-idle --wait N` (inventory 1.11, restart for a key change).
public enum IdleStopOutcome: Equatable { case stopped, stillBusy(inFlight: Int), failed(String), cancelled }
public final class IdleStop {
    public init(runner: CommandRunner)
    public func run(waitSeconds: Int = 300) async -> IdleStopOutcome       // timeout waitSeconds + 90
    public func cancel()                                                    // ends the command; run returns .cancelled
}
```

JSON is passed as `[String: Any]` from `JSONSerialization`; the app maps it to its own types.

### Added for the app (24 Nov 2026): mapping, pure functions only

`Mapping.swift` (plain value types), `MappingLogic.swift` (chat side) and `VideoMapping.swift` (video, DeepSeek
Harness setup, Krea) turn the JSON the CLI and the gateway print into what the app shows. No I/O, no UI; texts
and rules are the Windows app's (`app/DSHProxyApp.cs`, cited per function). The existing API above is unchanged.

```swift
public enum Tone { case normal, muted, ok, warn, bad, accent }               // the app picks the colours
public enum Format { tokens(_:) until(_:now:) reset(_:now:timeZone:) ago(_:now:timeZone:) clock(_:timeZone:) percent(_:) }

// `status --json` (src/cli.js statusJson)
public struct FullStatus { running origin home inFlight backendName backendVersion lockVersion previousVersion update
                           accountCount modelsOffered loginProviders keyProviders lanes routing models catalogError
                           catalogCheckedAt suggestions profiles
                           static func parse(_ text: String) -> FullStatus?        // nil: not a JSON object
                           var detailLine; func updateText(timeZone:) -> String?; func catalogNote(now:timeZone:) }
public struct LoginProvider { key label; static let defaults; var details }      // sign-in tiles
public struct KeyProvider { key label regions state savedRegion; stateText stateTone regionLabel }
public struct Lane { name rungs; title } ; public struct Rung { model available coolingUntil; state; why(now:) }
public struct Routing { activeName activeLabel presets; note }
public struct ChatModel { …; statusText serviceLabel contextText outputText reasoningText tooltip tone highlighted
                          static func visible(_:showHidden:) }
public struct Suggestion { from to lanes; text } ; public struct HarnessProfile { …; pointing good }

// GET /dshproxy/status (fast check) and requests in flight
public struct FastStatus { inFlight print; static func read(_ object: [String: Any]) -> FastStatus }
public enum InFlight { count(_:) cutQuestion(count:unanswered:quitting:) restartQuestion(count:unanswered:)
                       restartOffer(output:inFlight:) stillBusy(_:) }

// GET limits, GET resets, login/start, login/status
public struct LimitsReport { fetchedAt accounts; static func parse(_:) ; var lowest: LowestLimit? }
public struct AccountLimits { file provider label account plan disabled supported error primary siblings resetsAvailable
                              windows; planText showsPrimaryChip primaryAction note who }
public struct LimitWindow { title reported leftPercent resetsAt; level; line(now:timeZone:) }
public enum LimitLevel { ok, low, critical; init(left:) }                       // below 30 / below 10
public struct ResetCredits { available credits; static func parse(_:); count } ; ResetCredit.line(timeZone:)
public struct LoginStart { id url device userCode; static func parse(_:) -> LoginStart? }
public enum LoginProgress { wait, ok(account:), error(String); static func parse(_:) }
public enum Links { static func signInURL(_:) -> URL? }                          // https only

// video settings / video key / dsh bundle / Krea helper (code, stdout, stderr of a CommandResult)
public enum VideoSettings { noRoute readArguments isName parse(_:) read(code:stdout:stderr:)
                            setArguments(model:route:enabled:) failure(code:stderr:) routeLabel routeName units company }
public struct VideoModel { id enabled route routes; hasRoute routeCell routeTone billedIn }
public enum VideoKeys { listArguments setArguments(_:) removeArguments(_:) parse read refusal(_:)
                        saved(code:stdout:provider:) removed(code:stdout:provider:) without(_:key:) }
public struct VideoKeyProvider { …; stateText stateTone units }
public struct HarnessSetup { state … ; static parse(_:) read(code:stdout:stderr:) unread(_:) statusArguments installArguments
                             planned willInstall rowText rowTone pageLine confirmLines summary(applied:outcome:install:folder:) }
public struct HarnessInstall { ok message log; static func read(code:stdout:stderr:) }
public enum Krea { parseStatus(_:now:) describe(_:timeZone:) consentAddress(_:) ended(exitCode:errors:) message(_:) }
```

KitChecks section 7 checks them with sample JSON shaped as the sources print it (10 checks).

Not in the Kit yet: a command whose first output line is read while it keeps running, and that can be cancelled
(`dshproxy-krea.js login` prints the consent address, then waits up to 4 minutes). `CommandRunner.run` returns only
at the end, so the app does not offer Krea sign-in yet.

## What `KitChecks` shows (red before green)

With a temporary folder as checkout whose `bin/dshproxy.js` and `bin/dshproxy-krea.js` are stand-ins (Node scripts that record their arguments, environment and standard input, and behave as a test asks), and a stand-in gateway (a Node HTTP server on a free loopback port that serves `/dshproxy/status` and the control routes and records each request's headers):

1. `Locations.find`: checkout from the variable, from the recorded path, missing → the sentence; node from PATH, from the Homebrew folders when PATH lacks it, missing → the sentence; home from DSHPROXY_HOME and default.
2. `CommandRunner`: arguments as a list (a folder name with spaces and shell characters arrives unchanged); a key given as `input` is in standard input and in neither the arguments nor the environment; exit code and both streams come back; a command that hangs and starts a child is ended with that child within timeout + 3 s.
3. `StatusProbe`: JSON object from a stand-in → the object; nothing listening → nil quickly; a non-JSON answer → nil.
4. `ControlClient`: token from the file in the header, no `Origin`, body JSON; no token file → `.notRunning` without a request; nothing listening → `.noAnswer`; 4xx `{error}` → `.refused(error)`.
5. `GatewayProcess`: something already answers → `.alreadyRunning`, no process started; otherwise the stand-in `start` runs with cwd = checkout, its lines reach `onOutput`; `stop()` ends it and the child it started, `onExit` is called once; `stop()` with no own gateway → false.
6. `IdleStop`: `{"stopped":true}` exit 0 → `.stopped`; exit 2 `{"stopped":false,"inFlight":3}` → `.stillBusy(3)`; other → `.failed(first stderr line)`; `cancel()` → `.cancelled` and the command is gone.

## Added by the lead, 24 Nov: `StreamingCommand` (the Krea sign-in)

```swift
public final class StreamingCommand {
    public init(runner: CommandRunner)
    /// `onLine`: each standard-output line as it is printed (background thread); `completion` once.
    public func start(_ script: Script, _ args: [String], input: String? = nil, timeout: TimeInterval,
                      onLine: @escaping (String) -> Void, completion: @escaping (CommandResult) -> Void)
    /// Ends the command and its process group (never after it has ended); `completion` reports `code` nil.
    public func cancel()
}
```

Checks (6b in `KitChecks`, red first: "cannot find 'StreamingCommand'", then a run where no line arrived because the object was released): lines arrive before the end; cancel after the first line ends the command and its child; a command that does not end is ended at its timeout.

## Added by the lead, 24 Nov: `LoginItem` (start at login)

```swift
public struct LoginItem {
    public static let label = "com.dshproxy.app"
    public init(agentsFolder: URL, executable: URL)
    public static func userAgentsFolder(home: URL = ...) -> URL     // ~/Library/LaunchAgents
    public var isOn: Bool          // the file is there and starts this very executable
    public func turnOn() throws    // writes com.dshproxy.app.plist: [executable, "--hidden"], RunAtLoad, no KeepAlive
    public func turnOff() throws   // removes it; a running app is left running (as the Windows Run key)
}
```

The macOS counterpart of the Windows Run key `"<exe>" --hidden`. A LaunchAgent rather than `SMAppService.mainApp` because it carries `--hidden` (start in the menu bar without the window) and works the same for an ad-hoc signed app wherever it is; this Mac already runs one (the gateway agent of 23 Nov). Check 6c, red first ("cannot find 'LoginItem'").
