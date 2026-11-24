import Darwin
import Foundation

public enum StartOutcome: Equatable { case started(pid: Int32), alreadyRunning, failed(String) }

/// The gateway this app starts and stops (inventory 1.11).
public final class GatewayProcess {
    private let locations: Locations
    private let lock = NSLock()
    private var child: ChildProcess?
    private var starting = false

    /// Lines the gateway prints (stdout and stderr), one at a time, on any thread.
    public var onOutput: (String) -> Void = { _ in }
    /// Called once when this app's gateway process ends: its exit code, or 128 + the signal that ended it.
    public var onExit: (Int32) -> Void = { _ in }

    public init(locations: Locations) { self.locations = locations }

    /// nil when this app has no running gateway.
    public var ownPID: Int32? {
        lock.lock()
        defer { lock.unlock() }
        guard let child, !child.hasEnded else { return nil }
        return child.pid
    }

    /// Probes `origin` first: something answering → .alreadyRunning, nothing started (also when this app's own
    /// gateway is still running). Otherwise runs `node bin/dshproxy.js start` (cwd checkout, own process group,
    /// stdin /dev/null).
    public func start(origin: URL) async -> StartOutcome {
        let busy: Bool = locked {
            let busy = starting || (child.map { !$0.hasEnded } ?? false)
            if !busy { starting = true }
            return busy
        }
        if busy { return .alreadyRunning }
        defer { locked { starting = false } }

        if await StatusProbe.fetch(origin: origin, timeout: 1.5) != nil { return .alreadyRunning }

        var outLines = LineSplitter(), errLines = LineSplitter()
        do {
            let child = try ChildProcess.spawn(
                executable: locations.node.path,
                arguments: [locations.checkout.appendingPathComponent("bin/dshproxy.js").path, "start"],
                directory: locations.checkout.path,
                input: nil,
                onStdout: { [weak self] data in for line in outLines.feed(data) { self?.onOutput(line) } },
                onStderr: { [weak self] data in for line in errLines.feed(data) { self?.onOutput(line) } },
                onEnd: { [weak self] exit in
                    for line in outLines.finish() + errLines.finish() { self?.onOutput(line) }
                    self?.ended(exit)
                })
            locked { self.child = child }
            return .started(pid: child.pid)
        } catch {
            return .failed("\(error)")
        }
    }

    /// Only this app's own gateway: SIGTERM to its process (the gateway stops its backend and exits), wait up to
    /// 10 s, then SIGKILL its process group. Returns false when there was no own gateway. When the gateway had to
    /// be killed it could not remove {home}/control.token, so this does (as the Windows app does after Stop).
    public func stop() async -> Bool {
        guard let child = locked({ self.child }), !child.hasEnded else { return false }
        let endedInTime: Bool? = await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(returning: child.end(firstToGroup: false, grace: 10))
            }
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            child.whenEnded { _ in continuation.resume() }
        }
        if endedInTime == false {
            try? FileManager.default.removeItem(at: locations.home.appendingPathComponent("control.token"))
        }
        return endedInTime != nil
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    private func ended(_ exit: ChildProcess.Exit) {
        onExit(exit.code ?? 128 + (exit.signal ?? 0))
    }
}

public enum IdleStopOutcome: Equatable { case stopped, stillBusy(inFlight: Int), failed(String), cancelled }

/// `dshproxy stop --when-idle --wait N` (inventory 1.11, restart for a key change). One run per IdleStop.
public final class IdleStop {
    private let runner: CommandRunner
    private let lock = NSLock()
    private var running: RunningCommand?
    private var cancelled = false

    public init(runner: CommandRunner) { self.runner = runner }

    /// Timeout waitSeconds + 90.
    public func run(waitSeconds: Int = 300) async -> IdleStopOutcome {
        if isCancelled { return .cancelled }
        let timeout = waitSeconds + 90
        let result: CommandResult = await withCheckedContinuation { continuation in
            let command = runner.start(.dshproxy, ["stop", "--when-idle", "--wait", String(waitSeconds)], input: nil,
                                       timeout: TimeInterval(timeout)) { continuation.resume(returning: $0) }
            let cancelNow: Bool = locked {
                running = command
                return cancelled
            }
            if cancelNow { command?.cancel() }
        }
        locked { running = nil }
        if isCancelled { return .cancelled }
        if result.timedOut { return .failed("The stop command did not finish within \(timeout) seconds.") }

        let answer = result.stdout.split(whereSeparator: \.isNewline).reversed()
            .lazy.compactMap { LoopbackHTTP.object(Data($0.utf8)) }.first
        if result.code == 0, answer?["stopped"] as? Bool == true { return .stopped }
        if result.code == 2, answer?["stopped"] as? Bool == false, let inFlight = answer?["inFlight"] as? Int { return .stillBusy(inFlight: inFlight) }
        if let line = result.stderr.split(whereSeparator: \.isNewline)
            .map({ $0.trimmingCharacters(in: .whitespaces) }).first(where: { !$0.isEmpty }) {
            return .failed(line)
        }
        if let code = result.code { return .failed("The stop command ended with exit code \(code) and no answer.") }
        return .failed("The stop command ended without an answer.")
    }

    /// Ends the command; run returns .cancelled.
    public func cancel() {
        lock.lock()
        cancelled = true
        let command = running
        lock.unlock()
        command?.cancel()
    }

    private var isCancelled: Bool { locked { cancelled } }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}
