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

// MARK: - End

for cleanup in cleanups.reversed() { cleanup() }
print("\(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
