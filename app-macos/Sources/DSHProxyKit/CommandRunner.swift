import Darwin
import Foundation

public struct CommandResult: Equatable {
    /// Exit code; nil when the command timed out, was cancelled, was ended by a signal or could not start.
    public let code: Int32?
    public let stdout: String
    /// Standard error; when the command could not start, the one sentence that says why.
    public let stderr: String
    public let timedOut: Bool
}

public enum Script: String { case dshproxy = "dshproxy.js", krea = "dshproxy-krea.js" }

/// Runs `node <checkout>/bin/<script> <args>` once. Working directory: checkout. Environment: the app's own,
/// unchanged. `input`, when given, is written to standard input and standard input is closed (otherwise it is
/// /dev/null); it never appears in the arguments or the environment (keys travel this way). On `timeout` the
/// command and everything it started (its own process group) is ended: SIGTERM, then SIGKILL after 2 s (sooner
/// once the command itself has ended); `timedOut` true, `code` nil.
public struct CommandRunner {
    let locations: Locations

    public init(locations: Locations) { self.locations = locations }

    public func run(_ script: Script = .dshproxy, _ args: [String], input: String? = nil, timeout: TimeInterval) async -> CommandResult {
        await withCheckedContinuation { continuation in
            start(script, args, input: input, timeout: timeout) { continuation.resume(returning: $0) }
        }
    }

    /// `run(.dshproxy, args, ...)`: Swift cannot leave out a leading unlabelled argument that has a default
    /// when an unlabelled one follows, so this is how `run(["status", "--json"], timeout: 20)` is written.
    public func run(_ args: [String], input: String? = nil, timeout: TimeInterval) async -> CommandResult {
        await run(.dshproxy, args, input: input, timeout: timeout)
    }

    /// Starts the command; `completion` is called once with its result. Returns nil (after calling
    /// `completion`) when it could not start.
    @discardableResult
    func start(_ script: Script, _ args: [String], input: String?, timeout: TimeInterval,
               completion: @escaping (CommandResult) -> Void) -> RunningCommand? {
        let command = RunningCommand()
        do {
            let child = try ChildProcess.spawn(
                executable: locations.node.path,
                arguments: [locations.checkout.appendingPathComponent("bin").appendingPathComponent(script.rawValue).path] + args,
                directory: locations.checkout.path,
                input: input.map { Data($0.utf8) },
                onStdout: { command.append(stdout: $0) },
                onStderr: { command.append(stderr: $0) },
                onEnd: { exit in completion(command.result(exit)) })
            command.attach(child)
            DispatchQueue.global().asyncAfter(deadline: .now() + max(0, timeout)) { command.end(timedOut: true) }
            return command
        } catch {
            completion(CommandResult(code: nil, stdout: "", stderr: "\(error)", timedOut: false))
            return nil
        }
    }
}

/// A command started by `CommandRunner.start`.
final class RunningCommand {
    private let lock = NSLock()
    private var child: ChildProcess?
    private var stdout = Data()
    private var stderr = Data()
    private var timedOut = false
    private var interrupted = false

    fileprivate init() {}

    fileprivate func attach(_ child: ChildProcess) { lock.lock(); self.child = child; lock.unlock() }
    fileprivate func append(stdout data: Data) { lock.lock(); stdout.append(data); lock.unlock() }
    fileprivate func append(stderr data: Data) { lock.lock(); stderr.append(data); lock.unlock() }

    /// Ends the command and its group (SIGTERM, SIGKILL after 2 s), on a background thread.
    func cancel() { end(timedOut: false) }

    fileprivate func end(timedOut: Bool) {
        lock.lock()
        let child = self.child
        lock.unlock()
        guard let child, !child.hasEnded else { return }
        DispatchQueue.global().async {
            // Marked before signalling and before reaping, so the result (made after reaping) sees it.
            child.end(firstToGroup: true, grace: 2) {
                self.lock.lock()
                if timedOut { self.timedOut = true }
                self.interrupted = true
                self.lock.unlock()
            }
        }
    }

    fileprivate func result(_ exit: ChildProcess.Exit) -> CommandResult {
        lock.lock()
        defer { lock.unlock() }
        return CommandResult(code: interrupted ? nil : exit.code,
                             stdout: String(decoding: stdout, as: UTF8.self),
                             stderr: String(decoding: stderr, as: UTF8.self),
                             timedOut: timedOut)
    }
}
