// KitChecks: the checks of DSHProxyKit (KIT.md, "What KitChecks shows").
// `swift run --package-path app-macos KitChecks` prints one line per check and
// exits 0 when all pass, 1 otherwise. Everything runs in temporary folders, with
// stand-in scripts and a stand-in gateway on free loopback ports; nothing here
// touches ~/.dshproxy, a real gateway, the Keychain or the network.
import DSHProxyKit
import Foundation

// MARK: - Harness

struct CheckFailure: Error, CustomStringConvertible { let description: String }

func expect(_ condition: Bool, _ message: @autoclosure () -> String) throws {
    if !condition { throw CheckFailure(description: message()) }
}

func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ what: String) throws {
    if actual != expected { throw CheckFailure(description: "\(what): expected \(expected), got \(actual)") }
}

// API catalog fixtures contain no live provider data.
var passed = 0
var failed = 0
var cleanups: [() -> Void] = []

@MainActor func check(_ name: String, _ body: @MainActor () async throws -> Void) async {
    let started = Date()
    do {
        try await body()
        passed += 1
        print(String(format: "ok    %@ (%.1f s)", name, Date().timeIntervalSince(started)))
    } catch {
        failed += 1
        print("FAIL  \(name): \(error)")
    }
    fflush(stdout)
}

let fm = FileManager.default
let nodePath: String = {
    for folder in (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init) + ["/opt/homebrew/bin", "/usr/local/bin"] {
        let candidate = "\(folder)/node"
        if fm.isExecutableFile(atPath: candidate) { return candidate }
    }
    return "/opt/homebrew/bin/node"
}()

/// A fresh temporary folder, removed when the checks end.
@MainActor func temporaryFolder(_ label: String) throws -> URL {
    let url = fm.temporaryDirectory.appendingPathComponent("kitchecks-\(label)-\(UUID().uuidString)", isDirectory: true)
    try fm.createDirectory(at: url, withIntermediateDirectories: true)
    cleanups.append { try? fm.removeItem(at: url) }
    return url
}

func write(_ text: String, to url: URL, executable: Bool = false) throws {
    try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try text.write(to: url, atomically: true, encoding: .utf8)
    if executable { try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path) }
}

// MARK: - 1. Locations.find

let missingCheckout = "DSHProxy.app does not know where the DSHProxy folder is. Build it again with app-macos/build.sh in that folder."
let missingNode = "Node.js was not found. Install Node.js 22 or later."

func findError(_ body: () throws -> Locations) -> String? {
    do { _ = try body(); return nil } catch { return "\(error)" }
}

await check("API catalog: readiness, custom providers, regions, warnings and search") {
    let statuses = ["ready", "needsKey", "otherRegion", "catalogOnly"]
    let catalog = try APICatalog.parse(["models": statuses.map {
        ["id": "synthetic-\($0)", "provider": "custom-example", "status": $0, "regions": ["eu"]] as [String: Any]
    }, "warnings": ["Synthetic refresh warning"]])
    try expectEqual(catalog.models.map { $0.status.rawValue }, statuses, "exact readiness")
    let routed = try APICatalog.parse(["models": ["openrouter/moonshotai/kimi", "qwen/glm-5.3", "custom/model"].map { ["id": $0, "provider": String($0.split(separator: "/")[0]), "status": "ready", "regions": []] as [String: Any] }, "warnings": []])
    try expect(routed.models[0].matches("Moonshot AI") && routed.models[1].matches("Z.ai"), "search attributed publishers")
    try expectEqual(catalog.warnings, ["Synthetic refresh warning"], "warnings")
    try expect(catalog.models.allSatisfy { $0.matches("CUSTOM") && $0.matches("eu") && !$0.matches("absent") }, "search includes custom providers and regions")
    try expectEqual(catalog.models.last?.status.guidance, "Catalog only — not currently available to route", "catalog-only guidance")
    do {
        _ = try APICatalog.parse(["models": [["id": "x", "provider": "x", "status": "unknown", "regions": []]], "warnings": []])
        throw CheckFailure(description: "Unknown readiness accepted")
    } catch is DecodingError { }
}

await check("Locations: checkout from DSHPROXY_CHECKOUT, then from the recorded path, missing -> the sentence") {
    let base = try temporaryFolder("locations")
    let fromVariable = base.appendingPathComponent("from variable")
    let recorded = base.appendingPathComponent("recorded")
    let empty = base.appendingPathComponent("empty")
    try write("", to: fromVariable.appendingPathComponent("bin/dshproxy.js"))
    try write("", to: recorded.appendingPathComponent("bin/dshproxy.js"))
    try fm.createDirectory(at: empty, withIntermediateDirectories: true)
    let nodeFolder = base.appendingPathComponent("node")
    try write("#!/bin/sh\n", to: nodeFolder.appendingPathComponent("node"), executable: true)
    let home = base.appendingPathComponent("user")

    let a = try Locations.find(environment: ["DSHPROXY_CHECKOUT": fromVariable.path, "PATH": nodeFolder.path], recordedCheckout: recorded.path, nodeFolders: [], homeDirectory: home)
    try expectEqual(a.checkout.path, fromVariable.path, "checkout from the variable")
    let b = try Locations.find(environment: ["PATH": nodeFolder.path], recordedCheckout: recorded.path, nodeFolders: [], homeDirectory: home)
    try expectEqual(b.checkout.path, recorded.path, "checkout from the recorded path")
    let c = findError { try Locations.find(environment: ["DSHPROXY_CHECKOUT": empty.path, "PATH": nodeFolder.path], recordedCheckout: nil, nodeFolders: [], homeDirectory: home) }
    try expectEqual(c, missingCheckout, "folder without bin/dshproxy.js")
    let d = findError { try Locations.find(environment: ["PATH": nodeFolder.path], recordedCheckout: nil, nodeFolders: [], homeDirectory: home) }
    try expectEqual(d, missingCheckout, "nothing recorded")
}

await check("Locations: node from PATH (first executable file), from the Homebrew folders when PATH lacks it, missing -> the sentence") {
    let base = try temporaryFolder("node")
    let checkout = base.appendingPathComponent("checkout")
    try write("", to: checkout.appendingPathComponent("bin/dshproxy.js"))
    let notExecutable = base.appendingPathComponent("plain")
    try write("", to: notExecutable.appendingPathComponent("node"))
    let directory = base.appendingPathComponent("dir")
    try fm.createDirectory(at: directory.appendingPathComponent("node"), withIntermediateDirectories: true)
    let first = base.appendingPathComponent("first")
    let second = base.appendingPathComponent("second")
    let brew = base.appendingPathComponent("brew")
    for folder in [first, second, brew] { try write("#!/bin/sh\n", to: folder.appendingPathComponent("node"), executable: true) }
    let nowhere = base.appendingPathComponent("nowhere")
    let home = base.appendingPathComponent("user")

    let path = [nowhere.path, notExecutable.path, directory.path, first.path, second.path].joined(separator: ":")
    let a = try Locations.find(environment: ["PATH": path], recordedCheckout: checkout.path, nodeFolders: [brew.path], homeDirectory: home)
    try expectEqual(a.node.path, first.appendingPathComponent("node").path, "node from PATH")
    let b = try Locations.find(environment: ["PATH": "\(nowhere.path):\(notExecutable.path)"], recordedCheckout: checkout.path, nodeFolders: [nowhere.path, brew.path], homeDirectory: home)
    try expectEqual(b.node.path, brew.appendingPathComponent("node").path, "node from the Homebrew folders")
    let c = try Locations.find(environment: [:], recordedCheckout: checkout.path, nodeFolders: [brew.path], homeDirectory: home)
    try expectEqual(c.node.path, brew.appendingPathComponent("node").path, "node without PATH")
    let d = findError { try Locations.find(environment: ["PATH": directory.path], recordedCheckout: checkout.path, nodeFolders: [nowhere.path, notExecutable.path], homeDirectory: home) }
    try expectEqual(d, missingNode, "no node anywhere")
    try expectEqual(Locations.defaultNodeFolders, ["/opt/homebrew/bin", "/usr/local/bin"], "default node folders")
}

await check("Locations: home from DSHPROXY_HOME, else ~/.dshproxy") {
    let base = try temporaryFolder("home")
    let checkout = base.appendingPathComponent("checkout")
    try write("", to: checkout.appendingPathComponent("bin/dshproxy.js"))
    let nodeFolder = base.appendingPathComponent("node")
    try write("#!/bin/sh\n", to: nodeFolder.appendingPathComponent("node"), executable: true)
    let user = base.appendingPathComponent("user")
    let data = base.appendingPathComponent("my data")
    let a = try Locations.find(environment: ["PATH": nodeFolder.path, "DSHPROXY_HOME": data.path], recordedCheckout: checkout.path, homeDirectory: user)
    try expectEqual(a.home.path, data.path, "home from DSHPROXY_HOME")
    let b = try Locations.find(environment: ["PATH": nodeFolder.path], recordedCheckout: checkout.path, homeDirectory: user)
    try expectEqual(b.home.path, user.appendingPathComponent(".dshproxy").path, "default home")
}

// MARK: - Stand-ins

/// bin/dshproxy.js and bin/dshproxy-krea.js of a stand-in checkout. Each run records its script, arguments,
/// environment, working directory and standard input in <checkout>/<script>.json, then behaves as its first
/// argument (and the mode files a check writes into the checkout) ask.
let standInScript = #"""
const fs = require("fs"), path = require("path"), cp = require("child_process");
const root = path.join(__dirname, "..");
const args = process.argv.slice(2);
const mode = (name) => { try { return fs.readFileSync(path.join(root, name), "utf8").trim(); } catch { return ""; } };
let stdin = null;
try { stdin = fs.readFileSync(0, "utf8"); } catch (error) { stdin = "unreadable: " + error.code; }
fs.writeFileSync(path.join(root, path.basename(__filename) + ".json"), JSON.stringify({ script: path.basename(__filename), args, env: process.env, cwd: process.cwd(), stdin }));
const hangWithChild = (stdio) => {
  const child = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio });
  fs.writeFileSync(path.join(root, "pids.json"), JSON.stringify({ parent: process.pid, child: child.pid }));
  setInterval(() => {}, 1000);
};
switch (args[0]) {
  case "record":
    process.stdout.write("out line\n");
    process.stderr.write("err line\n");
    process.exitCode = 3;
    break;
  case "hang":
    process.on("SIGTERM", () => {}); // only SIGKILL ends this one; its child ends on SIGTERM
    hangWithChild("inherit");
    break;
  case "start":
    if (mode("start-mode") === "stubborn") process.on("SIGTERM", () => {});
    else process.on("SIGTERM", () => process.exit(0)); // leaves its child behind: the Kit ends it
    hangWithChild("ignore");
    console.log("Gateway stand-in started.");
    console.error("A line on standard error.");
    break;
  case "stop": {
    const m = mode("stop-mode");
    if (m === "stopped") { console.log(JSON.stringify({ stopped: true })); process.exitCode = 0; }
    else if (m === "busy") { console.log(JSON.stringify({ stopped: false, inFlight: 3 })); process.exitCode = 2; }
    else if (m === "fail") { console.error("The gateway is not running on http://127.0.0.1:1. Nothing was stopped."); console.error("A second line."); process.exitCode = 1; }
    else hangWithChild("inherit");
    break;
  }
  case "login":
    // As the Krea helper: the consent address first, then it waits for the browser.
    console.log("https://www.krea.ai/consent?client=stand-in");
    if (mode("login-mode") === "finish") setTimeout(() => { console.log("second line"); process.exitCode = 0; }, 300);
    else hangWithChild("ignore");
    break;
  default:
    console.error("stand-in: unknown command " + args[0]);
    process.exitCode = 9;
}
"""#

/// The stand-in gateway: serves /dshproxy/status (as `mode` asks) and the control routes on a free loopback
/// port, prints the port as its first line, and appends each request (method, url, headers, body) to `log`.
let standInServer = #"""
const http = require("http"), fs = require("fs");
const [mode, log] = process.argv.slice(2);
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const entry = { method: req.method, url: req.url, headers: req.headers, body };
    fs.appendFileSync(log, JSON.stringify(entry) + "\n");
    const send = (status, value, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(typeof value === "string" ? value : JSON.stringify(value));
    };
    const route = new URL(req.url, "http://stand-in").pathname;
    if (route === "/dshproxy/status") {
      if (mode === "text") return send(200, "<html>not JSON</html>", "text/html");
      if (mode === "array") return send(200, [1, 2]);
      if (mode === "unavailable") return send(503, { version: "stand-in" });
      if (mode === "silent") return undefined;
      return send(200, { version: "stand-in", inFlight: 0, origin: "http://127.0.0.1:" + server.address().port });
    }
    if (route === "/dshproxy/control/echo") return send(200, entry);
    if (route === "/dshproxy/control/refuse") return send(400, { error: "That account is not known." });
    if (route === "/dshproxy/control/teapot") return send(418, "short and stout", "text/plain");
    return send(404, { error: "Unknown control route." });
  });
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
"""#

struct StandIn {
    let checkout: URL
    let home: URL
    let locations: Locations
    func record(_ script: String = "dshproxy.js") throws -> [String: Any] {
        let data = try Data(contentsOf: checkout.appendingPathComponent("\(script).json"))
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }
    func hasRecord(_ script: String = "dshproxy.js") -> Bool { fm.fileExists(atPath: checkout.appendingPathComponent("\(script).json").path) }
    func pids() -> (parent: Int32, child: Int32)? {
        guard let data = try? Data(contentsOf: checkout.appendingPathComponent("pids.json")),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let parent = object["parent"] as? Int, let child = object["child"] as? Int else { return nil }
        return (Int32(parent), Int32(child))
    }
    func setMode(_ file: String, _ value: String) throws { try write(value, to: checkout.appendingPathComponent(file)) }
}

/// A checkout (its name has spaces and shell characters) with both stand-in scripts, and a data folder.
@MainActor func makeStandIn() throws -> StandIn {
    let base = try temporaryFolder("standin")
    let checkout = base.appendingPathComponent("check out; $(echo no) & 'quoted'", isDirectory: true)
    try write(standInScript, to: checkout.appendingPathComponent("bin/dshproxy.js"))
    try write(standInScript, to: checkout.appendingPathComponent("bin/dshproxy-krea.js"))
    let home = base.appendingPathComponent("data", isDirectory: true)
    try fm.createDirectory(at: home, withIntermediateDirectories: true)
    let locations = try Locations.find(environment: ["DSHPROXY_CHECKOUT": checkout.path, "DSHPROXY_HOME": home.path, "PATH": URL(fileURLWithPath: nodePath).deletingLastPathComponent().path],
                                       recordedCheckout: nil, nodeFolders: [], homeDirectory: base)
    return StandIn(checkout: checkout, home: home, locations: locations)
}

struct Server {
    let origin: URL
    let log: URL
    func requests() -> [[String: Any]] {
        guard let text = try? String(contentsOf: log, encoding: .utf8) else { return [] }
        return text.split(separator: "\n").compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
    }
}

/// Starts the stand-in gateway (Foundation's Process) and stops it when the checks end.
@MainActor func startServer(_ mode: String = "json") throws -> Server {
    let folder = try temporaryFolder("server")
    let script = folder.appendingPathComponent("server.js")
    try write(standInServer, to: script)
    let log = folder.appendingPathComponent("requests.log")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: nodePath)
    process.arguments = [script.path, mode, log.path]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardInput = FileHandle.nullDevice
    try process.run()
    cleanups.append { process.terminate(); process.waitUntilExit() }
    var line = Data()
    while !line.contains(0x0A) {
        let chunk = pipe.fileHandleForReading.availableData
        if chunk.isEmpty { throw CheckFailure(description: "the stand-in gateway did not start") }
        line.append(chunk)
    }
    let port = String(decoding: line, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    return Server(origin: URL(string: "http://127.0.0.1:\(port)")!, log: log)
}

/// A loopback port nothing listens on (bound once by the system, then released).
func freePort() -> UInt16 {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    defer { close(fd) }
    var address = sockaddr_in()
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    address.sin_port = 0
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, length) } }
    _ = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }
    return UInt16(bigEndian: address.sin_port)
}

func silentOrigin() -> URL { URL(string: "http://127.0.0.1:\(freePort())")! }

func alive(_ pid: Int32) -> Bool { kill(pid, 0) == 0 }

/// Waits up to `seconds` for `condition`; true when it became true.
func waitUntil(_ seconds: TimeInterval, _ condition: () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 50_000_000)
    }
    return condition()
}

func realPath(_ path: String) -> String { URL(fileURLWithPath: path).resolvingSymlinksInPath().path }

final class Box<T> {
    private let lock = NSLock()
    private var value: T
    init(_ value: T) { self.value = value }
    func get() -> T { lock.lock(); defer { lock.unlock() }; return value }
    func update(_ change: (inout T) -> Void) { lock.lock(); change(&value); lock.unlock() }
}

setenv("KITCHECKS_MARKER", "inherited", 1)

// MARK: - 2. CommandRunner

await check("CommandRunner: arguments as a list, working directory the checkout, environment the app's own, exit code and both streams") {
    let standIn = try makeStandIn()
    let tricky = "a folder/with spaces; $(touch pwned) & `id` 'q' \"dq\" *"
    let result = await CommandRunner(locations: standIn.locations).run(["record", tricky, "--json"], timeout: 20)
    try expectEqual(result.code, 3, "exit code")
    try expectEqual(result.stdout, "out line\n", "standard output")
    try expectEqual(result.stderr, "err line\n", "standard error")
    try expectEqual(result.timedOut, false, "timed out")
    let record = try standIn.record()
    try expectEqual(record["args"] as? [String] ?? [], ["record", tricky, "--json"], "arguments")
    try expectEqual(realPath(record["cwd"] as? String ?? ""), realPath(standIn.checkout.path), "working directory")
    let env = record["env"] as? [String: String] ?? [:]
    try expectEqual(env["KITCHECKS_MARKER"], "inherited", "inherited variable")
    try expectEqual(env["PATH"], ProcessInfo.processInfo.environment["PATH"], "PATH")
    try expectEqual(record["stdin"] as? String, "", "standard input without input")
    try expect(!fm.fileExists(atPath: standIn.checkout.appendingPathComponent("pwned").path), "a shell ran the arguments")
}

await check("CommandRunner: a key given as input is in standard input only, not in the arguments or the environment") {
    let standIn = try makeStandIn()
    let key = "sk-kitchecks-\(UUID().uuidString)"
    let result = await CommandRunner(locations: standIn.locations).run(["record", "openai"], input: key + "\n", timeout: 20)
    try expectEqual(result.code, 3, "exit code")
    let record = try standIn.record()
    try expectEqual(record["stdin"] as? String, key + "\n", "standard input")
    let args = record["args"] as? [String] ?? []
    try expect(!args.contains { $0.contains(key) }, "the key is in the arguments")
    let env = record["env"] as? [String: String] ?? [:]
    try expect(!env.contains { $0.key.contains(key) || $0.value.contains(key) }, "the key is in the environment")
}

await check("CommandRunner: the krea script runs bin/dshproxy-krea.js") {
    let standIn = try makeStandIn()
    let result = await CommandRunner(locations: standIn.locations).run(.krea, ["record", "status"], timeout: 20)
    try expectEqual(result.code, 3, "exit code")
    try expectEqual(try standIn.record("dshproxy-krea.js")["args"] as? [String] ?? [], ["record", "status"], "arguments")
    try expect(!standIn.hasRecord("dshproxy.js"), "bin/dshproxy.js ran")
}

await check("CommandRunner: a command that hangs (ignoring SIGTERM) is ended with its child within timeout + 3 s") {
    let standIn = try makeStandIn()
    let started = Date()
    let result = await CommandRunner(locations: standIn.locations).run(["hang"], timeout: 1.5)
    let elapsed = Date().timeIntervalSince(started)
    try expect(result.timedOut, "not timed out: \(result)")
    try expectEqual(result.code, nil, "exit code")
    try expect(elapsed < 4.5, "took \(elapsed) s")
    guard let pids = standIn.pids() else { throw CheckFailure(description: "the stand-in did not start its child") }
    try expect(await waitUntil(1) { !alive(pids.parent) && !alive(pids.child) }, "still running: command \(alive(pids.parent)), child \(alive(pids.child))")
}

// MARK: - 3. StatusProbe

await check("StatusProbe: a JSON object from the stand-in -> the object") {
    let server = try startServer()
    let status = await StatusProbe.fetch(origin: server.origin)
    try expectEqual(status?["version"] as? String, "stand-in", "version")
    try expectEqual(status?["origin"] as? String, server.origin.absoluteString, "origin")
}

await check("StatusProbe: nothing listening -> nil quickly") {
    let started = Date()
    let status = await StatusProbe.fetch(origin: silentOrigin())
    try expect(status == nil, "got \(String(describing: status))")
    try expect(Date().timeIntervalSince(started) < 1, "took \(Date().timeIntervalSince(started)) s")
}

await check("StatusProbe: not JSON, a JSON array, HTTP 503, no answer within the timeout -> nil") {
    for mode in ["text", "array", "unavailable", "silent"] {
        let server = try startServer(mode)
        let started = Date()
        let status = await StatusProbe.fetch(origin: server.origin, timeout: 0.5)
        try expect(status == nil, "\(mode): got \(String(describing: status))")
        try expect(Date().timeIntervalSince(started) < 2, "\(mode): took \(Date().timeIntervalSince(started)) s")
    }
}

// MARK: - 4. ControlClient

func controlError(_ body: () async throws -> [String: Any]) async -> ControlError? {
    do { _ = try await body(); return nil } catch let error as ControlError { return error } catch { return nil }
}

await check("ControlClient: token from the file (read fresh) in x-dshproxy-token, no Origin, JSON body, query") {
    let server = try startServer()
    let home = try temporaryFolder("control")
    let tokenFile = home.appendingPathComponent("control.token")
    let first = String(repeating: "a1", count: 32), second = String(repeating: "b2", count: 32)
    try write(first + "\n", to: tokenFile)
    let client = ControlClient(origin: server.origin, home: home)
    let echo = try await client.call("POST", "echo", body: ["file": "acct one.json", "disabled": true])
    try expectEqual(echo["method"] as? String, "POST", "method")
    try expectEqual(echo["url"] as? String, "/dshproxy/control/echo", "path")
    let headers = echo["headers"] as? [String: Any] ?? [:]
    try expectEqual(headers["x-dshproxy-token"] as? String, first, "token header")
    try expect(headers["origin"] == nil, "an Origin header was sent")
    try expect((headers["content-type"] as? String ?? "").hasPrefix("application/json"), "content type \(String(describing: headers["content-type"]))")
    let body = try JSONSerialization.jsonObject(with: Data((echo["body"] as? String ?? "").utf8)) as? [String: Any] ?? [:]
    try expectEqual(body["file"] as? String, "acct one.json", "body file")
    try expectEqual(body["disabled"] as? Bool, true, "body disabled")

    try write(second, to: tokenFile)
    let get = try await client.call("GET", "echo", query: ["id": "a b&c=d"])
    try expectEqual(get["method"] as? String, "GET", "method")
    try expectEqual((get["headers"] as? [String: Any])?["x-dshproxy-token"] as? String, second, "token read again")
    let url = URLComponents(string: "http://x" + (get["url"] as? String ?? ""))
    try expectEqual(url?.path, "/dshproxy/control/echo", "path")
    try expectEqual(url?.queryItems?.first { $0.name == "id" }?.value, "a b&c=d", "query id")
    try expectEqual(get["body"] as? String, "", "GET body")
}

await check("ControlClient: no token file -> .notRunning without a request; nothing listening -> .noAnswer") {
    let server = try startServer()
    let home = try temporaryFolder("control")
    let error = await controlError { try await ControlClient(origin: server.origin, home: home).call("POST", "echo", body: [:]) }
    try expectEqual(error, .notRunning, "no token file")
    try expectEqual(error?.description, "The gateway is not running. Press Start first.", "sentence")
    try expectEqual(server.requests().count, 0, "requests made")
    try write(String(repeating: "c3", count: 32), to: home.appendingPathComponent("control.token"))
    let started = Date()
    let silent = await controlError { try await ControlClient(origin: silentOrigin(), home: home).call("GET", "limits", timeout: 3) }
    try expectEqual(silent, .noAnswer, "nothing listening")
    try expectEqual(silent?.description, "The gateway did not answer. Is it running?", "sentence")
    try expect(Date().timeIntervalSince(started) < 2, "took \(Date().timeIntervalSince(started)) s")
}

await check("ControlClient: 4xx {error} -> .refused(error); other refusals -> .refused(\"The gateway refused (HTTP n).\")") {
    let server = try startServer()
    let home = try temporaryFolder("control")
    try write(String(repeating: "d4", count: 32), to: home.appendingPathComponent("control.token"))
    let client = ControlClient(origin: server.origin, home: home)
    let refused = await controlError { try await client.call("POST", "refuse", body: ["file": "x"]) }
    try expectEqual(refused, .refused("That account is not known."), "4xx with error")
    try expectEqual(refused?.description, "That account is not known.", "sentence")
    let teapot = await controlError { try await client.call("GET", "teapot") }
    try expectEqual(teapot, .refused("The gateway refused (HTTP 418)."), "4xx without JSON")
}

// MARK: - 5. GatewayProcess

await check("GatewayProcess: something already answers -> .alreadyRunning, nothing started") {
    let standIn = try makeStandIn()
    let server = try startServer()
    let gateway = GatewayProcess(locations: standIn.locations)
    let outcome = await gateway.start(origin: server.origin)
    try expectEqual(outcome, .alreadyRunning, "outcome")
    try expectEqual(gateway.ownPID, nil, "own pid")
    try? await Task.sleep(nanoseconds: 300_000_000)
    try expect(!standIn.hasRecord(), "the start command ran")
    let stopped = await gateway.stop()
    try expect(!stopped, "stop() without an own gateway returned true")
}

await check("GatewayProcess: anything answering HTTP 200 (not JSON too) counts as running, as in the Windows app; nothing started") {
    let standIn = try makeStandIn()
    let server = try startServer("text")
    let gateway = GatewayProcess(locations: standIn.locations)
    try expectEqual(await gateway.start(origin: server.origin), .alreadyRunning, "outcome")
    try? await Task.sleep(nanoseconds: 300_000_000)
    try expect(!standIn.hasRecord(), "the start command ran")
}

/// Starts the stand-in gateway, checks what start does, stops it and checks what stop does.
@MainActor func startAndStop(stubborn: Bool) async throws {
    let standIn = try makeStandIn()
    if stubborn { try standIn.setMode("start-mode", "stubborn") }
    let gateway = GatewayProcess(locations: standIn.locations)
    let lines = Box<[String]>([])
    let exits = Box<[Int32]>([])
    gateway.onOutput = { line in lines.update { $0.append(line) } }
    gateway.onExit = { code in exits.update { $0.append(code) } }
    let outcome = await gateway.start(origin: silentOrigin())
    guard case .started(let pid) = outcome else { throw CheckFailure(description: "outcome \(outcome)") }
    try expectEqual(gateway.ownPID, pid, "own pid")
    try expect(await waitUntil(5) { standIn.pids() != nil && lines.get().count >= 2 }, "lines \(lines.get())")
    try expect(lines.get().contains("Gateway stand-in started.") && lines.get().contains("A line on standard error."), "lines \(lines.get())")
    let record = try standIn.record()
    try expectEqual(record["args"] as? [String] ?? [], ["start"], "arguments")
    try expectEqual(realPath(record["cwd"] as? String ?? ""), realPath(standIn.checkout.path), "working directory")
    try expectEqual(record["stdin"] as? String, "", "standard input")
    let pids = standIn.pids()!
    try expectEqual(pids.parent, pid, "pid")
    try expect(alive(pids.child), "the child is not running")
    try expect(exits.get().isEmpty, "onExit before stop")

    let started = Date()
    let stopped = await gateway.stop()
    let elapsed = Date().timeIntervalSince(started)
    try expect(stopped, "stop() returned false")
    try expect(elapsed < (stubborn ? 13 : 3), "stop took \(elapsed) s")
    if stubborn { try expect(elapsed > 9, "stop did not wait for the gateway: \(elapsed) s") }
    try expect(await waitUntil(2) { !alive(pids.parent) && !alive(pids.child) }, "still running: gateway \(alive(pids.parent)), child \(alive(pids.child))")
    try expect(await waitUntil(3) { exits.get().count == 1 }, "onExit calls \(exits.get())")
    try? await Task.sleep(nanoseconds: 300_000_000)
    try expectEqual(exits.get().count, 1, "onExit calls")
    try expectEqual(gateway.ownPID, nil, "own pid after stop")
    let again = await gateway.stop()
    try expect(!again, "a second stop() returned true")
}

await check("GatewayProcess: start runs `start` in the checkout, lines reach onOutput; stop ends it and its child, onExit once") {
    try await startAndStop(stubborn: false)
}

await check("GatewayProcess: a gateway that ignores SIGTERM is killed with its group after 10 s") {
    try await startAndStop(stubborn: true)
}

// MARK: - 6. IdleStop

@MainActor func idleStop(_ mode: String, waitSeconds: Int = 300) async throws -> (IdleStopOutcome, StandIn) {
    let standIn = try makeStandIn()
    try standIn.setMode("stop-mode", mode)
    let outcome = await IdleStop(runner: CommandRunner(locations: standIn.locations)).run(waitSeconds: waitSeconds)
    return (outcome, standIn)
}

await check("IdleStop: {\"stopped\":true} exit 0 -> .stopped, arguments `stop --when-idle --wait N`") {
    let (outcome, standIn) = try await idleStop("stopped", waitSeconds: 7)
    try expectEqual(outcome, .stopped, "outcome")
    try expectEqual(try standIn.record()["args"] as? [String] ?? [], ["stop", "--when-idle", "--wait", "7"], "arguments")
}

await check("IdleStop: exit 2 {\"stopped\":false,\"inFlight\":3} -> .stillBusy(3)") {
    let (outcome, _) = try await idleStop("busy")
    try expectEqual(outcome, .stillBusy(inFlight: 3), "outcome")
}

await check("IdleStop: anything else -> .failed(first standard-error line)") {
    let (outcome, _) = try await idleStop("fail")
    try expectEqual(outcome, .failed("The gateway is not running on http://127.0.0.1:1. Nothing was stopped."), "outcome")
}

await check("IdleStop: cancel() -> .cancelled and the command (and its child) is gone") {
    let standIn = try makeStandIn()
    try standIn.setMode("stop-mode", "hang")
    let idle = IdleStop(runner: CommandRunner(locations: standIn.locations))
    let task = Task { await idle.run() }
    try expect(await waitUntil(5) { standIn.pids() != nil }, "the command did not start")
    let pids = standIn.pids()!
    let started = Date()
    idle.cancel()
    let outcome = await task.value
    try expectEqual(outcome, .cancelled, "outcome")
    try expect(Date().timeIntervalSince(started) < 4, "cancel took \(Date().timeIntervalSince(started)) s")
    try expect(await waitUntil(1) { !alive(pids.parent) && !alive(pids.child) }, "still running: command \(alive(pids.parent)), child \(alive(pids.child))")
}

// MARK: - 6b. StreamingCommand (the Krea sign-in: the first line before the end, cancel)

await check("StreamingCommand: each standard-output line arrives as it is printed, before the command ends; then the result") {
    let standIn = try makeStandIn()
    try standIn.setMode("login-mode", "finish")
    let lines = Box<[String]>([])
    let firstBeforeEnd = Box(false)
    let result: CommandResult = await withCheckedContinuation { continuation in
        let command = StreamingCommand(runner: CommandRunner(locations: standIn.locations))
        command.start(.krea, ["login"], timeout: 20, onLine: { line in lines.update { $0.append(line) } },
                      completion: { result in firstBeforeEnd.update { $0 = !lines.get().isEmpty }; continuation.resume(returning: result) })
    }
    try expectEqual(lines.get(), ["https://www.krea.ai/consent?client=stand-in", "second line"], "lines")
    try expect(firstBeforeEnd.get(), "no line before the end")
    try expectEqual(result.code, Int32(0), "exit code")
}

await check("StreamingCommand: cancel() after the first line ends the command and its child; code nil") {
    let standIn = try makeStandIn()
    let command = StreamingCommand(runner: CommandRunner(locations: standIn.locations))
    let gotLine = Box(false)
    let task = Task { () -> CommandResult in
        await withCheckedContinuation { continuation in
            command.start(.krea, ["login"], timeout: 60, onLine: { _ in gotLine.update { $0 = true } }, completion: { continuation.resume(returning: $0) })
        }
    }
    try expect(await waitUntil(5) { gotLine.get() && standIn.pids() != nil }, "no first line")
    let pids = standIn.pids()!
    command.cancel()
    let result = await task.value
    try expectEqual(result.code, nil as Int32?, "code")
    try expectEqual(result.timedOut, false, "timedOut")
    try expect(await waitUntil(3) { !alive(pids.parent) && !alive(pids.child) }, "still running: command \(alive(pids.parent)), child \(alive(pids.child))")
}

await check("StreamingCommand: a command that does not end is ended at its timeout") {
    let standIn = try makeStandIn()
    let started = Date()
    let result: CommandResult = await withCheckedContinuation { continuation in
        StreamingCommand(runner: CommandRunner(locations: standIn.locations))
            .start(.krea, ["login"], timeout: 1, onLine: { _ in }, completion: { continuation.resume(returning: $0) })
    }
    try expect(result.timedOut, "not timed out")
    try expect(Date().timeIntervalSince(started) < 5, "took \(Date().timeIntervalSince(started)) s")
}

// MARK: - 6c. Start at login (a LaunchAgent that opens the app hidden, as the Windows Run key does)

await check("LoginItem: on writes a LaunchAgent that starts this app with --hidden at login; off removes it") {
    let folder = try temporaryFolder("agents").appendingPathComponent("LaunchAgents", isDirectory: true)
    let exe = URL(fileURLWithPath: "/Applications/Some Place/DSHProxy.app/Contents/MacOS/DSHProxy")
    let item = LoginItem(agentsFolder: folder, executable: exe)
    try expect(!item.isOn, "on before anything was written")
    try item.turnOn()
    let file = folder.appendingPathComponent("com.dshproxy.app.plist")
    let plist = try PropertyListSerialization.propertyList(from: Data(contentsOf: file), format: nil) as? [String: Any]
    try expectEqual(plist?["Label"] as? String, "com.dshproxy.app", "label")
    try expectEqual(plist?["ProgramArguments"] as? [String], [exe.path, "--hidden"], "program arguments")
    try expectEqual(plist?["RunAtLoad"] as? Bool, true, "run at load")
    try expect(plist?["KeepAlive"] == nil, "keep alive set: Quit must stay quit")
    try expect(item.isOn, "not on after turnOn")
    // Another copy of the app (another path) does not count as on.
    try expect(!LoginItem(agentsFolder: folder, executable: URL(fileURLWithPath: "/elsewhere/DSHProxy.app/Contents/MacOS/DSHProxy")).isOn, "another copy counts as on")
    try item.turnOff()
    try expect(!fm.fileExists(atPath: file.path), "file still there")
    try expect(!item.isOn, "still on")
    try item.turnOff()   // nothing there: no error
}

// MARK: - 7. Mapping (JSON -> values the app shows)
//
// Sample JSON shaped exactly as the CLI and the gateway print it (src/cli.js statusJson, src/daemon.js,
// src/limits.js, src/login.js, src/video/command.js, src/video/keys.js, src/dsh/bundle.js,
// bin/dshproxy-krea.js). Times are read in Europe/Paris (UTC+1 in November); "now" is fixed.

let paris = TimeZone(identifier: "Europe/Paris")!
let mappingNow = ISO8601DateFormatter().date(from: "2026-11-24T09:00:00Z")!   // 10:00 local, a Tuesday

func jsonObject(_ text: String) throws -> [String: Any] {
    guard let object = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { throw CheckFailure(description: "sample is not a JSON object") }
    return object
}

let sampleStatus = """
{"running":true,"origin":"http://127.0.0.1:8417","startedAt":"2026-11-24T08:00:00.000Z","inFlight":2,
 "backend":{"name":"CLIProxyAPI","version":"6.9.2","port":8418,"running":true,"pid":4242},
 "backendLock":{"version":"6.9.2","publishedAt":"2026-11-01T10:00:00Z","previous":"6.8.0"},
 "update":{"available":true,"current":"6.9.2","latest":"6.10.0","publishedAt":"2026-11-21T13:05:00Z","lock":{"name":"CLIProxyAPI","version":"6.10.0"},"checkedAt":"2026-11-24T06:00:00.000Z","error":null},
 "discovery":{"fetchedAt":"2026-11-24T08:18:00.000Z","catalogError":null,"hasCatalog":true},
 "modelList":[
  {"id":"gpt-6-luna","name":"GPT-6 Luna","account":"codex","api":"openai-responses","contextWindow":272000,"maxTokens":64000,"efforts":["minimal","low"],"isNew":true,"offered":false,"reason":"switched off","created":null},
  {"id":"claude-haiku-5-5","name":"Claude Haiku 5.5","account":"claude","api":"anthropic-messages","contextWindow":200000,"maxTokens":64000,"efforts":[],"isNew":false,"offered":true,"reason":"known","created":null},
  {"id":"gemini-3-flash","name":"gemini-3-flash","account":"antigravity","api":"openai-completions","contextWindow":1000000,"maxTokens":65000,"efforts":[],"isNew":true,"offered":false,"reason":"older generation","created":1700000000},
  {"id":"claude-opus-5-6","name":"Claude Opus 5.6","account":"claude","api":"anthropic-messages","contextWindow":1500000,"maxTokens":128000,"efforts":["low","high"],"isNew":true,"offered":true,"reason":"new","created":1763000000}],
 "suggestions":[{"from":"claude-opus-5-5","to":"claude-opus-5-6","lanes":["main","architect"]}],
 "home":"/Users/someone/.dshproxy",
 "accounts":[{"provider":"claude","label":"Claude","account":"a@example.com","disabled":false,"expired":false},{"provider":"codex","label":"ChatGPT","account":"c@example.com","disabled":false,"expired":false}],
 "loginProviders":[{"key":"codex","label":"ChatGPT (Codex)"},{"key":"claude","label":"Claude"}],
 "providers":[{"key":"deepseek","label":"DeepSeek","regions":[{"key":"international","label":"Default"}]},
              {"key":"zai","label":"GLM (Z.ai)","regions":[{"key":"international","label":"International"},{"key":"china","label":"China"}]},
              {"key":"mistral","label":"Mistral (EU)","regions":[{"key":"eu","label":"EU"},{"key":"global","label":"Global"}]}],
 "apiKeys":{"readable":[{"provider":"zai","region":"china"}],"unreadable":["deepseek"]},
 "lanes":[{"name":"main","ladder":[{"model":"gpt-6-astra","available":true,"coolingUntil":null},{"model":"gpt-6.1-terra","available":true,"coolingUntil":"2026-11-24T09:23:00.000Z"},{"model":"deepseek/deepseek-v4-pro","available":false,"coolingUntil":null}]}],
 "routing":{"active":{"name":"balanced","label":"Balanced"},"presets":[{"name":"performance","label":"Max performance","summary":"The strongest model each lane can reach, whatever it costs. Slowest and most quota-hungry."},{"name":"balanced","label":"Balanced","summary":"Strong models first with cheaper ones as failover. The working default."}]},
 "models":["lane-main","gpt-6-astra","claude-opus-5-6"],
 "deepseekHarness":{"home":"/Users/someone/.dsh","profiles":[
  {"profile":"desktop","routes":[{"key":"dshproxy","baseURL":"http://127.0.0.1:8417/v1","models":12},{"key":"dshproxy-anthropic","baseURL":"http://127.0.0.1:8417","models":7}],"current":true,"error":null},
  {"profile":"work","routes":[],"current":false,"error":null},
  {"profile":"old","routes":[{"key":"dshproxy","baseURL":"http://127.0.0.1:9999/v1","models":3}],"current":false,"error":null},
  {"profile":"broken","routes":[],"current":false,"error":"profile.yaml could not be read"}],"applied":false}}
"""

await check("Mapping: status --json -> header detail line, update bar, footer data, login providers") {
    guard let status = FullStatus.parse(sampleStatus) else { throw CheckFailure(description: "parse gave nil") }
    try expectEqual(status.running, true, "running")
    try expectEqual(status.origin, "http://127.0.0.1:8417", "origin")
    try expectEqual(status.home, "/Users/someone/.dshproxy", "home")
    try expectEqual(status.inFlight, 2, "inFlight")
    try expectEqual(status.detailLine, "http://127.0.0.1:8417  \u{B7}  CLIProxyAPI 6.9.2  \u{B7}  2 accounts  \u{B7}  3 models offered", "detail line")
    try expectEqual(status.updateText(timeZone: paris), "CLIProxyAPI 6.10.0 is available (you run 6.9.2), released 21 Nov 14:05. Updating tries it first and keeps 6.9.2 for rollback.", "update bar")
    try expectEqual(status.previousVersion, "6.8.0", "previous version")
    var noUpdate = status
    noUpdate.update = nil
    try expectEqual(noUpdate.updateText(timeZone: paris), "Running CLIProxyAPI 6.9.2. The previous version 6.8.0 is kept.", "bar with only a previous version")
    noUpdate.previousVersion = nil
    try expectEqual(noUpdate.updateText(timeZone: paris), nil, "no bar")
    try expectEqual(status.loginProviders.map(\.key), ["codex", "claude"], "login providers")
    try expectEqual(LoginProvider.defaults.map(\.label), ["Claude", "ChatGPT (Codex)", "Gemini (Antigravity)", "Kimi"], "default providers")
    try expectEqual(LoginProvider(key: "claude", label: "Claude").details, "Claude Pro or Max. Opens claude.ai.", "tile text")
    try expectEqual(FullStatus.parse("not json"), nil, "not JSON")
    try expectEqual(FullStatus.parse("[1]"), nil, "array")
}

await check("Mapping: status --json -> API keys, lanes, routing, models, suggestions, profiles") {
    guard let status = FullStatus.parse(sampleStatus) else { throw CheckFailure(description: "parse gave nil") }
    try expectEqual(status.keyProviders.map(\.stateText), ["Saved, cannot be read: add it again", "Saved", "Not set"], "key states")
    try expectEqual(status.keyProviders.map(\.stateTone), [.bad, .ok, .muted], "key tones")
    try expectEqual(status.keyProviders.map(\.regionLabel), ["", "China", ""], "key regions")
    try expectEqual(status.keyProviders[1].regions.map(\.key), ["international", "china"], "regions")

    let lane = status.lanes[0]
    try expectEqual(lane.title, "lane-main", "lane title")
    try expectEqual(lane.rungs.map(\.state), [.ok, .cooling, .unavailable], "rung states")
    try expectEqual(lane.rungs.map { $0.why(now: mappingNow) }, ["can serve", "sitting out after running out of quota, back in 23 min", "no account or key"], "rung why")

    try expectEqual(status.routing.activeName, "balanced", "active preset")
    try expectEqual(status.routing.note, "Active: Balanced. Strong models first with cheaper ones as failover. The working default.", "routing note")
    var custom = status.routing
    custom.activeName = "custom"; custom.activeLabel = "Custom"
    try expectEqual(custom.note, "Custom ladders, edited in settings.json. Pick a preset to replace them.", "custom note")

    try expectEqual(ChatModel.visible(status.models, showHidden: false).map(\.id), ["claude-opus-5-6", "claude-haiku-5-5", "gpt-6-luna"], "visible models")
    try expectEqual(ChatModel.visible(status.models, showHidden: true).map(\.id), ["claude-opus-5-6", "gemini-3-flash", "claude-haiku-5-5", "gpt-6-luna"], "with hidden models")
    let byID = Dictionary(uniqueKeysWithValues: status.models.map { ($0.id, $0) })
    try expectEqual(["claude-opus-5-6", "claude-haiku-5-5", "gpt-6-luna", "gemini-3-flash"].map { byID[$0]!.statusText },
                    ["NEW \u{B7} found automatically", "Offered", "Off (you switched it off)", "Hidden: older generation"], "status texts")
    var odd = byID["gemini-3-flash"]!
    odd.reason = "not in the catalog"
    try expectEqual(odd.statusText, "Hidden: no details known", "not in the catalog")
    odd.reason = "switched on"
    try expectEqual(odd.statusText, "Offered (you switched it on)", "switched on")
    try expectEqual(byID["claude-opus-5-6"]!.highlighted, true, "new and offered is highlighted")
    try expectEqual(byID["gpt-6-luna"]!.tone, .muted, "not offered is muted")
    try expectEqual(byID["claude-opus-5-6"]!.contextText, "1.5M", "context")
    try expectEqual(byID["claude-opus-5-6"]!.outputText, "128K", "output")
    try expectEqual(byID["claude-opus-5-6"]!.reasoningText, "low, high", "reasoning")
    try expectEqual(byID["claude-haiku-5-5"]!.reasoningText, "none", "no reasoning")
    try expectEqual(["claude", "codex", "antigravity", "kimi"].map { a -> String in var m = odd; m.account = a; return m.serviceLabel }, ["Claude", "ChatGPT", "Gemini (Google)", "Kimi"], "service labels")
    try expectEqual(byID["claude-opus-5-6"]!.tooltip, "Claude Opus 5.6  \u{B7}  Service: Claude", "tooltip")
    try expectEqual([1_000_000, 1_234_567, 200_000, 999, 0].map(Format.tokens), ["1M", "1.23M", "200K", "999", "0"], "tokens")
    try expectEqual(status.catalogNote(now: mappingNow, timeZone: paris), "Last checked 42 min ago.", "catalog note")
    var unreachable = status
    unreachable.catalogError = "HTTP 503"
    try expectEqual(unreachable.catalogNote(now: mappingNow, timeZone: paris), "Model catalog not reachable: HTTP 503", "catalog error")
    unreachable.catalogError = nil; unreachable.catalogCheckedAt = nil
    try expectEqual(unreachable.catalogNote(now: mappingNow, timeZone: paris), "Not checked yet.", "not checked")

    try expectEqual(status.suggestions.map(\.text), ["Newer model: claude-opus-5-6 could replace claude-opus-5-5 on lane main, architect."], "suggestion")
    try expectEqual(status.profiles.map(\.pointing), ["Yes", "Not applied", "No: apply again", "profile.yaml could not be read"], "pointing")
    try expectEqual(status.profiles.map(\.routeCount), [2, 0, 1, 0], "route counts")
    try expectEqual(status.profiles.map(\.modelCount), [19, 0, 3, 0], "model counts")
    try expectEqual(status.profiles.map(\.good), [true, false, false, false], "good")
}

await check("Mapping: fast check -> in-flight count and the print without it; Stop/Quit/restart questions") {
    let a = FastStatus.read(try jsonObject(#"{"version":"1.2.0","origin":"http://127.0.0.1:8417","inFlight":3,"lanes":[]}"#))
    let b = FastStatus.read(try jsonObject(#"{"lanes":[],"inFlight":0,"origin":"http://127.0.0.1:8417","version":"1.2.0"}"#))
    try expectEqual(a.inFlight, 3, "count")
    try expectEqual(a.print, b.print, "print ignores inFlight and key order")
    try expect(!a.print.contains("inFlight"), "print still has inFlight")
    let counts = try [#"{"inFlight":null}"#, #"{"inFlight":2.7}"#, #"{"inFlight":-1}"#, #"{"inFlight":true}"#, #"{"inFlight":"3"}"#, #"{"inFlight":5000000}"#, "{}"].map { InFlight.count(try jsonObject($0)) }
    try expectEqual(counts, [0, 2, 0, 0, 0, 1_000_000, 0], "counts")

    try expectEqual(InFlight.cutQuestion(count: 1, unanswered: false, quitting: false),
                    "1 model request was in flight when the gateway was last checked, a few seconds ago at most. Stopping the gateway now cuts it.\n\nStop anyway?", "stop, 1")
    try expectEqual(InFlight.cutQuestion(count: 3, unanswered: false, quitting: true),
                    "3 model requests were in flight when the gateway was last checked, a few seconds ago at most. Quitting stops the gateway now and cuts them.\n\nQuit anyway?", "quit, 3")
    try expectEqual(InFlight.cutQuestion(count: 2, unanswered: true, quitting: false),
                    "The gateway did not answer when it was last checked, so requests may be in flight. 2 model requests were in flight when it last answered. Stopping the gateway now cuts any that are.\n\nStop anyway?", "stop, unanswered")
    try expectEqual(InFlight.cutQuestion(count: 0, unanswered: true, quitting: true),
                    "The gateway did not answer when it was last checked, so requests may be in flight. Quitting stops the gateway now and cuts any that are.\n\nQuit anyway?", "quit, unanswered, none")
    try expectEqual(InFlight.restartQuestion(count: 3, unanswered: false),
                    "3 model requests were in flight when the gateway was last checked, a few seconds ago at most. Restarting the gateway now cuts them.\n\nRestart anyway?", "restart question")
    let saved = "Saved the zai key (region china). Restart the gateway, then run `dshproxy dsh apply`."
    try expectEqual(InFlight.restartOffer(output: saved, inFlight: 2),
                    saved + "\n\nRestart the gateway now so it uses the change?\n\n2 requests are in flight: the restart waits for a moment with none, at most 5 minutes, and cuts nothing.", "restart offer, busy")
    try expectEqual(InFlight.restartOffer(output: saved, inFlight: 0), saved + "\n\nRestart the gateway now so it uses the change?", "restart offer, idle")
    try expectEqual(InFlight.stillBusy(1),
                    "1 request is still running after 5 minutes of waiting.\n\nNothing was restarted: the gateway keeps running as it was. The key change is used after the next restart of the gateway.", "still busy")
}

let sampleLimits = """
{"fetchedAt":"2026-11-24T08:59:30.000Z","accounts":[
 {"file":"claude-a@example.com.json","provider":"claude","label":"Claude","account":"a@example.com","plan":"max_20x","disabled":false,"state":"active","stateMessage":null,
  "windows":[{"title":"5-hour","kind":"short","usedPercent":36.4,"leftPercent":63.6,"resetsAt":"2026-11-24T11:12:00.000Z","reported":true},
             {"title":"Weekly","kind":"weekly","usedPercent":92.5,"leftPercent":7.5,"resetsAt":"2026-11-27T14:05:00.000Z","reported":true}],
  "resets":null,"supported":true,"error":null,"primary":true,"siblings":2},
 {"file":"claude-b@example.com.json","provider":"claude","label":"Claude","account":"b@example.com","plan":"pro","disabled":true,"state":"disabled","stateMessage":null,"windows":[],"resets":null,"supported":true,"error":null,"primary":false,"siblings":2},
 {"file":"codex-c@example.com.json","provider":"codex","label":"ChatGPT","account":"c@example.com","plan":"self_serve_business_prolite","disabled":false,"state":"active","stateMessage":null,
  "windows":[{"title":"5-hour","kind":"short","usedPercent":null,"leftPercent":null,"resetsAt":null,"reported":false},
             {"title":"Weekly","kind":"weekly","usedPercent":27.5,"leftPercent":72.5,"resetsAt":"2026-11-24T23:30:00.000Z","reported":true}],
  "resets":{"available":2,"applicable":2},"supported":true,"error":null,"primary":false,"siblings":1},
 {"file":"kimi-d.json","provider":"kimi","label":"Kimi","account":"d@example.com","plan":null,"disabled":false,"state":"active","stateMessage":null,"windows":[],"resets":null,"supported":false,"error":null,"primary":false,"siblings":1},
 {"file":"antigravity-e.json","provider":"antigravity","label":"Gemini","account":"e@example.com","plan":"google_ai_pro","disabled":false,"state":"active","stateMessage":null,"windows":[],"resets":null,"supported":true,"error":"No limits were reported.","primary":false,"siblings":1}]}
"""

await check("Mapping: GET limits -> cards (plan, chips, buttons, notes, resets), limit lines and the lowest limit") {
    let report = LimitsReport.parse(try jsonObject(sampleLimits))
    try expectEqual(report.accounts.map(\.file), ["claude-a@example.com.json", "claude-b@example.com.json", "codex-c@example.com.json", "kimi-d.json", "antigravity-e.json"], "files")
    let a = report.accounts[0], b = report.accounts[1], c = report.accounts[2]
    try expectEqual(a.who, "Claude (a@example.com)", "who")
    try expectEqual([a.planText, c.planText, report.accounts[3].planText], ["max 20x", "self serve busi\u{2026}", ""], "plan chips")
    try expectEqual(report.accounts.map(\.showsPrimaryChip), [true, false, false, false, false], "primary chips")
    try expectEqual(report.accounts.map(\.primaryAction), [.clear, .none, .none, .none, .none], "primary buttons")
    var resumed = b
    resumed.disabled = false
    try expectEqual(resumed.primaryAction, .make, "make primary")
    try expectEqual(report.accounts.map(\.note), [nil, AccountNote(text: "Paused: DSHProxy does not use this account until you resume it.", isError: false), nil,
                                                  AccountNote(text: "Kimi does not report its limits.", isError: false), AccountNote(text: "No limits were reported.", isError: true)], "notes")
    try expectEqual(c.resetsAvailable, 2, "resets")
    try expectEqual(c.windows.map(\.reported), [false, true], "reported")
    try expectEqual(a.windows.map { $0.line(now: mappingNow, timeZone: paris) },
                    ["64% left \u{B7} resets in 2 h 12 min (today 12:12)", "8% left \u{B7} resets in 3 d 5 h (Fri 27 Nov 15:05)"], "lines")
    try expectEqual(c.windows[1].line(now: mappingNow, timeZone: paris), "73% left \u{B7} resets in 14 h 30 min (tomorrow 00:30)", "tomorrow")
    try expectEqual(Format.reset(nil, now: mappingNow, timeZone: paris), "reset time not reported", "no reset time")
    try expectEqual(Format.reset(mappingNow.addingTimeInterval(40.2 * 60), now: mappingNow, timeZone: paris), "resets in 41 min (today 10:40)", "minutes round up")
    try expectEqual(Format.reset(mappingNow.addingTimeInterval(-5), now: mappingNow, timeZone: paris), "resets in now (today 09:59)", "past")
    try expectEqual([63.6, 30, 29.9, 10, 9.99].map(LimitLevel.init(left:)), [.ok, .ok, .low, .low, .critical], "levels")
    try expectEqual(report.lowest, LowestLimit(text: "Lowest limit: Claude Weekly, 8% left", left: 7.5), "lowest")
    try expectEqual(LimitsReport.parse(try jsonObject(#"{"fetchedAt":null,"accounts":[]}"#)).lowest, nil, "no accounts, no lowest")
    try expectEqual(Format.ago(mappingNow.addingTimeInterval(-30), now: mappingNow, timeZone: paris), "just now", "ago, seconds")
    try expectEqual(Format.ago(mappingNow.addingTimeInterval(-7 * 60), now: mappingNow, timeZone: paris), "7 min ago", "ago, minutes")
    try expectEqual(Format.ago(mappingNow.addingTimeInterval(-3 * 3600), now: mappingNow, timeZone: paris), "07:00", "ago, hours")
    try expectEqual(Format.clock(mappingNow, timeZone: paris), "10:00:00", "clock")
}

await check("Mapping: GET resets, login/start, login/status; only https sign-in links") {
    let credits = ResetCredits.parse(try jsonObject(#"{"available":2,"credits":[{"id":"cr1","title":"Weekly limit reset","description":"Included with ChatGPT Pro","expiresAt":"2026-12-31T12:00:00.000Z"},{"id":"cr2","title":"Limit reset","description":null,"expiresAt":null}]}"#))
    try expectEqual(credits.count, 2, "count")
    try expectEqual(credits.credits.map(\.id), ["cr1", "cr2"], "ids")
    try expectEqual(credits.credits.map { $0.line(timeZone: paris) }, ["Included with ChatGPT Pro \u{B7} expires 31 Dec 2026", ""], "credit lines")
    try expectEqual(ResetCredits.parse(try jsonObject(#"{"available":3,"credits":[]}"#)).count, 3, "unnamed resets")

    let start = LoginStart.parse(try jsonObject(#"{"id":"st1","provider":"kimi","label":"Kimi","url":"https://www.kimi.com/code?x=1","flow":"device","userCode":"KQ7M-4XPD","expiresIn":300}"#))
    try expectEqual(start, LoginStart(id: "st1", url: "https://www.kimi.com/code?x=1", device: true, userCode: "KQ7M-4XPD"), "device start")
    let browser = LoginStart.parse(try jsonObject(#"{"id":"st2","provider":"claude","label":"Claude","url":"https://claude.ai/oauth?x","flow":"browser","userCode":null,"expiresIn":null}"#))
    try expectEqual(browser?.device, false, "browser flow")
    try expectEqual(LoginStart.parse(try jsonObject(#"{"url":"https://claude.ai"}"#)), nil, "no id")
    try expectEqual(LoginProgress.parse(try jsonObject(#"{"status":"ok","error":null,"account":"a@example.com"}"#)), .ok(account: "a@example.com"), "ok")
    try expectEqual(LoginProgress.parse(try jsonObject(#"{"status":"error","error":"Cancelled.","account":null}"#)), .error("Cancelled."), "error")
    try expectEqual(LoginProgress.parse(try jsonObject(#"{"status":"wait","error":null,"account":null,"note":"busy"}"#)), .wait, "wait")
    try expectEqual(Links.signInURL("https://claude.ai/oauth/authorize?x=1")?.absoluteString, "https://claude.ai/oauth/authorize?x=1", "https")
    try expectEqual(["http://claude.ai/", "javascript:alert(1)", "file:///etc/passwd", "", "https://"].map { Links.signInURL($0) == nil }, [true, true, true, true, true], "refused")
}

let sampleVideoSettings = """
{
  "models": [
    { "model": "wan-3.0", "enabled": true, "route": "krea", "routes": ["videorouter", "videorouter-replicate", "kovapi", "krea"] },
    { "model": "minimax-h3", "enabled": true, "route": null, "routes": ["kovapi", "callirra", "none", "krea"] },
    { "model": "seedance-2.0", "enabled": false, "route": "gone", "routes": ["videorouter"] }
  ]
}
"""

await check("Voice: separate speaker, file and WebSocket arguments, explicit approval") {
    try expectEqual(VoiceRequest.models.count, 8, "all choices")
    try expectEqual(VoiceRequest.arguments(model: "eleven_v4", speaker: "speaker123", input: "/tmp/input.txt", output: "/tmp/output.mp3"), ["voice", "tts", "eleven_v4", "--voice", "speaker123", "--text-file", "/tmp/input.txt", "--output", "/tmp/output.mp3", "--confirm-charge"], "speaker separate from model")
    try expectEqual(VoiceRequest.arguments(model: "scribe_v3", speaker: "", input: "/tmp/input.wav", output: "/tmp/output.json"), ["voice", "transcribe", "scribe_v3", "--input", "/tmp/input.wav", "--output", "/tmp/output.json", "--confirm-charge"], "transcription has no speaker")
    try expectEqual(VoiceRequest.arguments(model: "eleven_v4_turbo", speaker: "speaker123", input: "/in", output: "/out"), ["voice", "tts", "eleven_v4_turbo", "--voice", "speaker123", "--text-file", "/in", "--output", "/out", "--confirm-charge"], "turbo TTS")
    try expectEqual(VoiceRequest.arguments(model: "scribe_v3_live", speaker: "ignored", input: "/in", output: "/out"), ["voice", "live", "scribe_v3_live", "--input", "/in", "--output", "/out", "--confirm-charge"], "live has no speaker")
    for model in ["unknown"] {
        try expectEqual(VoiceRequest.arguments(model: model, speaker: "speaker", input: "/in", output: "/out"), nil, "unsupported")
    }
    try expectEqual(VoiceRequest.arguments(model: "eleven_v4", speaker: "", input: "/in", output: "/out"), nil, "missing speaker")
    try expectEqual(VoiceRequest.arguments(model: "eleven_v4", speaker: "speaker", input: "--option", output: "/out"), nil, "input cannot become an option")
    try expectEqual(VoiceRequest.arguments(model: "eleven_v4", speaker: "speaker", input: "/same", output: "/same"), nil, "cannot overwrite input")
}

await check("Mapping: video settings -> rows, routes, billed in; set arguments; refusals") {
    guard case .success(let models) = VideoSettings.parse(sampleVideoSettings) else { throw CheckFailure(description: "parse failed") }
    try expectEqual(models.map(\.id), ["wan-3.0", "minimax-h3", "seedance-2.0"], "ids")
    try expectEqual(models[1].routes, ["kovapi", "callirra", "krea"], "\"none\" is never a route")
    try expectEqual(models.map(\.hasRoute), [true, false, false], "has route")
    try expectEqual(models.map(\.routeCell), ["Krea workspace \u{B7} krea", "Not configured", "Not allowed: gone"], "route cells")
    try expectEqual(models.map(\.billedIn), ["workspace compute units", nil, nil], "billed in")
    try expectEqual(["callirra", "kovapi", "videorouter-replicate", "odd"].map(VideoSettings.units), ["plan credits", "US dollars", "US dollars", "units not known to this app"], "units")
    try expectEqual(VideoSettings.routeName("videorouter-replicate"), "VideoRouter (Replicate) \u{B7} videorouter-replicate", "route name")
    try expectEqual(VideoSettings.routeLabel("elevenlabs"), "ElevenLabs", "shared voice/video provider")
    try expectEqual(VideoSettings.routeName("odd"), "odd", "unknown route name")
    try expectEqual(VideoSettings.company("seedance-2.0").logo, "bytedance", "company logo")
    try expectEqual(VideoSettings.company("minimax-h3").label, "MiniMax", "company")
    try expectEqual(VideoSettings.company("other").label, "", "unknown company")
    try expectEqual(VideoSettings.setArguments(model: "wan-3.0", route: "krea", enabled: true), ["video", "settings", "set", "wan-3.0", "krea", "enabled"], "set")
    try expectEqual(VideoSettings.setArguments(model: "wan-3.0", route: "none", enabled: false), ["video", "settings", "set", "wan-3.0", "none", "disabled"], "switch off")
    try expectEqual(VideoSettings.setArguments(model: "wan-3.0", route: "none", enabled: true), nil, "enable without route")
    try expectEqual(VideoSettings.setArguments(model: "--evil", route: "krea", enabled: true), nil, "option as model")
    func failure(_ text: String) -> String? { if case .failure(let error) = VideoSettings.parse(text) { return error.description }; return nil }
    try expectEqual(failure("nope"), "DSHProxy did not answer with JSON.", "not JSON")
    try expectEqual(failure(#"{"models":{}}"#), "The answer has no list of video models.", "no list")
    try expectEqual(failure(#"{"models":[{"model":"a"},{"model":"a"}]}"#), "The answer lists a video model without a usable, unique name.", "duplicate")
    guard case .failure(let refused) = VideoSettings.read(code: 1, stdout: "", stderr: "DSHProxy: Unknown video model\nmore") else { throw CheckFailure(description: "read of a failure succeeded") }
    try expectEqual(refused.description, "Unknown video model", "first stderr line")
    try expectEqual(VideoSettings.failure(code: 1, stderr: ""), "The DSHProxy command ended with code 1.", "no stderr")
}

let sampleVideoKeys = """
{
  "providers": [
    { "provider": "videorouter", "label": "VideoRouter", "variable": "VIDEOROUTER_API_KEY", "routes": ["videorouter", "videorouter-replicate"], "saved": true, "readable": true, "inEnvironment": false },
    { "provider": "kovapi", "label": "KovAPI", "variable": "KOVAPI_API_KEY", "routes": ["kovapi"], "saved": true, "readable": false, "inEnvironment": true },
    { "provider": "callirra", "label": "Callirra", "variable": "CALLIRRA_API_KEY", "routes": ["callirra"], "saved": false, "readable": false, "inEnvironment": false }
  ]
}
"""

await check("Mapping: video key list -> states (strict shape); set/remove answers; local key check; masking") {
    guard case .success(let providers) = VideoKeys.parse(sampleVideoKeys) else { throw CheckFailure(description: "parse failed") }
    try expectEqual(providers.map(\.stateText), ["Saved", "Saved, cannot be read: enter it again \u{B7} also set in the environment", "Not saved"], "states")
    try expectEqual(providers.map(\.stateTone), [.normal, .warn, .muted], "tones")
    try expectEqual(providers.map(\.units), ["US dollars", "US dollars", "plan credits"], "units")
    func failure(_ text: String) -> String? { if case .failure(let error) = VideoKeys.parse(text) { return error.description }; return nil }
    try expectEqual(failure(#"{"providers":[{"provider":"kovapi","label":"KovAPI","variable":"KOVAPI_API_KEY","routes":[],"saved":true,"readable":true}]}"#),
                    "The answer does not say whether each video key is saved.", "missing field")
    try expectEqual(failure(#"{"providers":[{"provider":"kovapi","label":" KovAPI","variable":"KOVAPI_API_KEY","routes":[],"saved":true,"readable":true,"inEnvironment":false}]}"#),
                    "The answer names a video key provider or its variable in a form this app does not show.", "odd label")
    try expectEqual(failure(#"{"providers":[]}"#), "The answer lists no video key provider.", "empty")
    try expectEqual(VideoKeys.refusal(""), "No video API key was given. Nothing was saved.", "empty key")
    try expectEqual(VideoKeys.refusal(String(repeating: "k", count: 513)), "A video API key can be at most 512 characters. Nothing was saved.", "long key")
    try expectEqual(VideoKeys.refusal("ab c"), "A video API key cannot contain spaces, line breaks or anything else outside printable ASCII. Nothing was saved.", "space")
    try expectEqual(VideoKeys.refusal("k\u{E9}y"), "A video API key cannot contain spaces, line breaks or anything else outside printable ASCII. Nothing was saved.", "non-ASCII")
    try expectEqual(VideoKeys.refusal(String(repeating: "k", count: 512)), nil, "512 is fine")
    try expectEqual(VideoKeys.saved(code: 0, stdout: "{\n  \"provider\": \"kovapi\",\n  \"saved\": true\n}", provider: "kovapi"), true, "saved")
    try expectEqual(VideoKeys.saved(code: 0, stdout: #"{"provider":"callirra","saved":true}"#, provider: "kovapi"), false, "other provider")
    try expectEqual(VideoKeys.saved(code: 1, stdout: #"{"provider":"kovapi","saved":true}"#, provider: "kovapi"), false, "exit 1")
    try expectEqual(VideoKeys.removed(code: 0, stdout: #"{"provider":"kovapi","saved":false,"removed":true}"#, provider: "kovapi"), true, "removed")
    try expectEqual(VideoKeys.removed(code: 0, stdout: #"{"provider":"kovapi","saved":false,"removed":false}"#, provider: "kovapi"), false, "none saved")
    try expectEqual(VideoKeys.removed(code: 0, stdout: #"{"provider":"kovapi","saved":false}"#, provider: "kovapi"), nil, "not as agreed")
    try expectEqual(VideoKeys.without("refused sk-123 here", key: "sk-123"), "DSHProxy refused, with a message that is not shown here because it repeats what was typed.", "masked")
    try expectEqual(VideoKeys.without("refused", key: "sk-123"), "refused", "kept")
    try expectEqual(VideoKeys.setArguments("kovapi"), ["video", "key", "set", "kovapi"], "set arguments")
    try expectEqual(VideoKeys.removeArguments("--all"), nil, "option as provider")
}

/// One `dsh bundle status --json` line (src/dsh/bundle.js look()): the base fields with `fields` in place of theirs.
func bundleLine(_ fields: String) -> String {
    let base = #"{"harness":"found","harnessRunning":false,"profile":"desktop","profileExists":true,"bundle":"not-installed","folder":"/Users/someone/dshproxy/integrations/dsh-video","linkedTo":null,"version":null,"canInstall":true,"canInstallAfterQuit":false,"reason":""}"#
    var merged = (try! JSONSerialization.jsonObject(with: Data(base.utf8))) as! [String: Any]
    for (key, value) in (try! JSONSerialization.jsonObject(with: Data(("{" + fields + "}").utf8))) as! [String: Any] { merged[key] = value }
    return String(decoding: try! JSONSerialization.data(withJSONObject: merged), as: UTF8.self)
}

await check("Mapping: dsh bundle status --json -> state, plan, page texts and the Apply checklist") {
    let notInstalled = HarnessSetup.parse("Moved the data folder.\n" + bundleLine(#""bundle":"not-installed""#) + "\n")
    try expectEqual(notInstalled.state, .notInstalled, "state")
    try expectEqual(notInstalled.planned, .install, "plan")
    try expectEqual(notInstalled.willInstall, true, "will install")
    try expectEqual(notInstalled.rowText, "No \u{B7} Apply to DeepSeek Harness installs them", "row")
    try expectEqual(notInstalled.pageLine, "The video tools are not installed in DeepSeek Harness. Apply to DeepSeek Harness, at the top of the window, installs them.", "page line")
    try expectEqual(notInstalled.confirmLines, [
        SetupLine(.done, "DeepSeek Harness is installed and has been opened once."),
        SetupLine(.toDo, "The chat routes will be written into every DeepSeek Harness profile.", "Each profile is backed up first.\nNothing else in it is changed."),
        SetupLine(.toDo, "The video tools will be installed in DeepSeek Harness."),
        SetupLine(.toDo, "Restart DeepSeek Harness afterwards. DSHProxy does not do that for you."),
    ], "checklist")

    let installed = HarnessSetup.parse(bundleLine(#""bundle":"installed","version":"0.1.0""#))
    try expectEqual(installed.rowText, "Yes \u{B7} switched on \u{B7} version 0.1.0", "installed row")
    try expectEqual(installed.rowTone, .ok, "installed tone")
    try expectEqual(installed.planned, .nothing, "nothing to do")

    let notFound = HarnessSetup.parse(bundleLine(#""bundle":"not-installed","harness":"not-found","profileExists":false,"canInstall":false,"reason":"DeepSeek Harness was not found on this computer. Install it and open it once, then try again.""#))
    try expectEqual(notFound.state, .notFound, "not found")
    try expectEqual(notFound.rowText, "No \u{B7} DeepSeek Harness was not found", "not found row")

    let open = HarnessSetup.parse(bundleLine(#""bundle":"other-folder","harnessRunning":true,"linkedTo":"/old/dsh-video","canInstall":false,"canInstallAfterQuit":true,"reason":"DeepSeek Harness is running. Quit it completely, then try again.""#))
    try expectEqual(open.planned, .installAfterQuit, "after quit")
    try expectEqual(open.confirmLines[2], SetupLine(.toDo, "The video tools will be pointed at this DSHProxy folder after you quit DeepSeek Harness.",
                                                    "DeepSeek Harness has them from another folder:\n/old/dsh-video\nDeepSeek Harness is open now.\nYou will be asked to quit it, and you can skip that step."), "tools line")
    try expectEqual(open.confirmLines[3].text, "Start DeepSeek Harness again afterwards. DSHProxy does not do that for you.", "last line")

    try expectEqual(HarnessSetup.parse("garbage").reason, "DSHProxy did not answer as expected.", "garbage")
    try expectEqual(HarnessSetup.parse("  \n").reason, "DSHProxy gave no answer.", "nothing")
    let failed = HarnessSetup.read(code: 1, stdout: "", stderr: "DSHProxy: dsh bundle is not available on macOS yet.\n")
    try expectEqual(failed.state, .unreadable, "failed command")
    try expectEqual(failed.pageLine, "Could not read whether the video tools are installed in DeepSeek Harness: dsh bundle is not available on macOS yet.", "failed page line")
    try expectEqual(failed.planned, .unknown, "unknown plan")
}

await check("Mapping: Apply result (summary, shortened output, copy path) and dsh bundle install --json") {
    let setup = HarnessSetup.parse(bundleLine(#""bundle":"not-installed""#))
    let applied = (1...12).map { "line \($0)" }.joined(separator: "\n")
    let done = setup.summary(applied: applied, outcome: .installed, install: HarnessInstall(ok: true, message: "Installed.", log: ""), folder: "/f")
    try expectEqual(done.heading, "DeepSeek Harness is set up", "heading")
    try expectEqual(done.lines[0], SetupLine(.done, "The chat routes were applied. DSHProxy reported:", (1...9).map { "line \($0)" }.joined(separator: "\n") + "\nAnd 3 more lines, on the Log page."), "shortened output")
    try expectEqual(done.lines.dropFirst().map(\.text), ["The video tools are installed in DeepSeek Harness.", "Start DeepSeek Harness again."], "installed lines")
    try expectEqual(done.copyPath, nil, "no copy path")
    let failed = setup.summary(applied: "", outcome: .failed, install: HarnessInstall(ok: false, message: "dsh plugin add failed.", log: "/tmp/install.log"), folder: "/f")
    try expectEqual(failed.heading, "The video tools were not installed", "failed heading")
    try expectEqual(failed.lines[0].text, "The chat routes were applied.", "no output")
    try expectEqual(failed.lines[1], SetupLine(.cannot, "The video tools were not installed.", "dsh plugin add failed.\nMore is in this file:\n/tmp/install.log"), "failure detail")
    try expectEqual(failed.lines.last, SetupLine(.toDo, "To install them by hand, start DeepSeek Harness, open Plugins > Add plugin and choose this folder:", "/f"), "by hand")
    try expectEqual(failed.copyPath, "/f", "copy path")
    let skipped = setup.summary(applied: "x", outcome: .skipped, install: nil, folder: "/f")
    try expectEqual(skipped.lines.map(\.text), ["The chat routes were applied. DSHProxy reported:", "The video tools were not installed, because you skipped that step.",
                                                 "To install them, quit DeepSeek Harness and press Apply to DeepSeek Harness again.", "If anything above was updated, restart DeepSeek Harness so it uses the change."], "skipped")

    try expectEqual(HarnessInstall.read(code: 0, stdout: #"{"ok":true,"bundle":"installed","message":"Installed.","log":null}"#, stderr: ""), HarnessInstall(ok: true, message: "Installed.", log: ""), "installed")
    try expectEqual(HarnessInstall.read(code: 1, stdout: #"{"ok":true,"bundle":"installed","message":"Installed.","log":null}"#, stderr: "").ok, false, "exit 1 is not installed")
    try expectEqual(HarnessInstall.read(code: 1, stdout: "", stderr: "DSHProxy: no\n").message, "no", "failure sentence")
}

await check("Mapping: Krea helper status, consent address checks, how a sign-in ended") {
    let until = mappingNow.addingTimeInterval(89 * 86400)
    let ms = Int64(until.timeIntervalSince1970 * 1000)
    let signedIn = Krea.parseStatus("{\"signedIn\":true,\"expiresAt\":\(ms)}\n", now: mappingNow)
    try expectEqual(signedIn, KreaStatus(signedIn: true, until: until), "signed in")
    try expectEqual(Krea.describe(signedIn!, timeZone: paris), "Signed in \u{B7} until Sun 21 Feb 2027, 10:00", "describe")
    try expectEqual(Krea.parseStatus(#"{"signedIn":false}"#, now: mappingNow), KreaStatus(signedIn: false, until: nil), "not signed in")
    try expectEqual(Krea.describe(KreaStatus(signedIn: false, until: nil)), "Not signed in", "describe not signed in")
    try expectEqual(Krea.parseStatus("{\"signedIn\":true,\"expiresAt\":\(ms - 90 * 86_400_000)}", now: mappingNow), nil, "expired")
    try expectEqual(Krea.parseStatus("garbage", now: mappingNow), nil, "garbage")
    try expectEqual(Krea.parseStatus("{\"signedIn\":false}\n{\"signedIn\":false}", now: mappingNow), nil, "two lines")

    try expectEqual(Krea.consentAddress("https://krea.ai/oauth/authorize?client_id=x&state=y\n"), "https://krea.ai/oauth/authorize?client_id=x&state=y", "krea.ai")
    try expectEqual(Krea.consentAddress("https://www.krea.ai"), "https://www.krea.ai", "bare host")
    let refused = ["https://evil.com/krea.ai", "https://krea.ai@evil.com/", "https://krea.ai:444/", "http://krea.ai/", "https://api.krea.ai/x y", "https://krea.ai.evil.com/", "https://KREA.ai/"]
    try expectEqual(refused.map { Krea.consentAddress($0) }, refused.map { _ in nil }, "refused addresses")

    try expectEqual(Krea.ended(exitCode: 0, errors: ""), .signedIn, "exit 0")
    try expectEqual(Krea.ended(exitCode: 1, errors: "KREA_REFUSED\n"), .refused, "refused")
    try expectEqual(Krea.ended(exitCode: 1, errors: "KREA_LOGIN_REQUIRED"), .loginRequired, "login required")
    try expectEqual(Krea.ended(exitCode: 1, errors: "boom"), .failed, "unnamed")
    try expectEqual(Krea.ended(exitCode: nil, errors: ""), .failed, "no exit code")
    try expectEqual(Krea.message(.signedIn), "Signed in to Krea.", "message")
    try expectEqual(Krea.message(.refused), "Krea sign-in did not complete (KREA_REFUSED): it was refused or closed in the browser, took longer than three minutes, or Krea could not be reached.", "refused message")
}

// MARK: - End

for cleanup in cleanups.reversed() { cleanup() }
print("\(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
