import Darwin
import Foundation

/// A child process started with posix_spawn in a process group of its own, with its standard output and
/// standard error read on a thread of its own.
///
/// Signals: the process (and so its group number) is not reaped while a signalling sequence is in progress,
/// and nothing is signalled once it has been reaped, so a signal never reaches a reused process or group.
final class ChildProcess {
    struct Exit {
        /// Exit code, nil when a signal ended the process.
        let code: Int32?
        /// Signal number, nil when the process exited.
        let signal: Int32?
    }

    let pid: pid_t
    private let state = NSCondition()
    private var leaderGone = false   // the process has ended (it may still be a zombie)
    private var reaped = false       // from here on its number may be reused: no more signals
    private var signalling = 0       // signalling sequences in progress; reaping waits for them
    private var drainDeadline: Date? // set once reaped: output left open by others is read until then
    private var ended: Exit?
    private var endWaiters: [(Exit) -> Void] = []

    /// True once the process has ended (whether or not its output has been read to the end).
    var hasEnded: Bool { state.lock(); defer { state.unlock() }; return leaderGone }

    /// Starts `executable` with `arguments` (argv[1...]) in `directory`, with the app's environment unchanged.
    /// `input`, when given, is written to standard input, which is then closed; otherwise standard input is
    /// /dev/null. `onStdout`/`onStderr` get the bytes as they come, on the reader thread. `onEnd` is called once,
    /// after the process has ended and its output has been read.
    static func spawn(executable: String, arguments: [String], directory: String, input: Data?,
                      onStdout: @escaping (Data) -> Void, onStderr: @escaping (Data) -> Void,
                      onEnd: @escaping (Exit) -> Void) throws -> ChildProcess {
        var outPipe: [Int32] = [-1, -1], errPipe: [Int32] = [-1, -1], inPipe: [Int32] = [-1, -1]
        func closeAll() { for fd in outPipe + errPipe + inPipe where fd >= 0 { close(fd) } }
        guard pipe(&outPipe) == 0, pipe(&errPipe) == 0, input == nil || pipe(&inPipe) == 0 else {
            let message = String(cString: strerror(errno))
            closeAll()
            throw KitError("Node.js could not be started (\(message)).")
        }
        for fd in [outPipe[0], errPipe[0], inPipe[1]] where fd >= 0 { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        if input != nil {
            posix_spawn_file_actions_adddup2(&actions, inPipe[0], 0)
        } else {
            posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        }
        posix_spawn_file_actions_adddup2(&actions, outPipe[1], 1)
        posix_spawn_file_actions_adddup2(&actions, errPipe[1], 2)
        posix_spawn_file_actions_addchdir_np(&actions, directory)

        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        // Own process group (pgid = pid); only fds 0-2 are inherited; signals at their defaults, none blocked.
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))
        posix_spawnattr_setpgroup(&attributes, 0)
        var defaults = sigset_t()
        sigfillset(&defaults)
        sigdelset(&defaults, SIGKILL)
        sigdelset(&defaults, SIGSTOP)
        posix_spawnattr_setsigdefault(&attributes, &defaults)
        var noMask = sigset_t()
        sigemptyset(&noMask)
        posix_spawnattr_setsigmask(&attributes, &noMask)

        let argv: [UnsafeMutablePointer<CChar>?] = ([executable] + arguments).map { strdup($0) } + [nil]
        // The app's own environment, unchanged.
        let envp: [UnsafeMutablePointer<CChar>?] = ProcessInfo.processInfo.environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { for pointer in argv + envp { free(pointer) } }
        var pid: pid_t = 0
        let result = posix_spawn(&pid, executable, &actions, &attributes, argv, envp)
        for fd in [outPipe[1], errPipe[1], inPipe[0]] where fd >= 0 { close(fd) }
        guard result == 0 else {
            for fd in [outPipe[0], errPipe[0], inPipe[1]] where fd >= 0 { close(fd) }
            throw KitError("Node.js could not be started (\(String(cString: strerror(result)))).")
        }

        let child = ChildProcess(pid: pid)
        if let input {
            let fd = inPipe[1]
            Thread.detachNewThread { writeAll(input, to: fd) }
        }
        let outputDone = DispatchSemaphore(value: 0)
        Thread.detachNewThread {
            child.readOutput(out: outPipe[0], err: errPipe[0], onStdout: onStdout, onStderr: onStderr)
            outputDone.signal()
        }
        Thread.detachNewThread {
            let exit = child.waitForExit()
            outputDone.wait()
            child.finish(exit, onEnd: onEnd)
        }
        return child
    }

    private init(pid: pid_t) { self.pid = pid }

    /// Calls `callback` once the process has ended and its output has been read (at once if that has happened).
    func whenEnded(_ callback: @escaping (Exit) -> Void) {
        state.lock()
        if let ended {
            state.unlock()
            callback(ended)
            return
        }
        endWaiters.append(callback)
        state.unlock()
    }

    /// Ends the process and its group: `first` (SIGTERM) to the group, or to the process alone when
    /// `firstToGroup` is false; waits up to `grace` seconds for the process to end; then SIGKILL to the group.
    /// Blocks the calling thread. Returns nil when the process had already been reaped (nothing was signalled),
    /// else whether the process ended within the grace period.
    /// `beforeSignal` runs (under the lock that reaping takes) only when something is going to be signalled.
    @discardableResult
    func end(firstToGroup: Bool, grace: TimeInterval, beforeSignal: () -> Void = {}) -> Bool? {
        state.lock()
        if reaped {
            state.unlock()
            return nil
        }
        beforeSignal()
        signalling += 1
        // Not reaped, and reaping waits for this sequence: pid and group number are still ours.
        _ = firstToGroup ? kill(-pid, SIGTERM) : kill(pid, SIGTERM)
        let deadline = Date().addingTimeInterval(grace)
        while !leaderGone && state.wait(until: deadline) {}
        let endedInTime = leaderGone
        _ = kill(-pid, SIGKILL)
        signalling -= 1
        state.broadcast()
        state.unlock()
        return endedInTime
    }

    // MARK: - Threads

    private func waitForExit() -> Exit {
        var info = siginfo_t()
        // Wait for the end without reaping, so the number stays reserved while a signalling sequence runs.
        while waitid(P_PID, id_t(pid), &info, WEXITED | WNOWAIT) == -1 && errno == EINTR {}
        state.lock()
        leaderGone = true
        state.broadcast()
        while signalling > 0 { state.wait() }
        reaped = true
        state.unlock()
        var status: Int32 = 0
        while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
        state.lock()
        drainDeadline = Date().addingTimeInterval(2)
        state.unlock()
        let low = status & 0x7f
        return low == 0 ? Exit(code: (status >> 8) & 0xff, signal: nil) : Exit(code: nil, signal: low)
    }

    private func finish(_ exit: Exit, onEnd: (Exit) -> Void) {
        onEnd(exit)
        state.lock()
        ended = exit
        let waiters = endWaiters
        endWaiters = []
        state.broadcast()
        state.unlock()
        for waiter in waiters { waiter(exit) }
    }

    /// Reads both streams until both are closed, or until 2 s after the process was reaped (something it
    /// started may hold them open).
    private func readOutput(out: Int32, err: Int32, onStdout: (Data) -> Void, onStderr: (Data) -> Void) {
        var open: [Int32] = [out, err]
        var buffer = [UInt8](repeating: 0, count: 65536)
        while !open.isEmpty {
            state.lock()
            let deadline = drainDeadline
            state.unlock()
            if let deadline, Date() > deadline { break }
            var polled = open.map { pollfd(fd: $0, events: Int16(POLLIN), revents: 0) }
            let ready = poll(&polled, nfds_t(polled.count), 100)
            if ready <= 0 { continue }
            for entry in polled where entry.revents != 0 {
                let count = read(entry.fd, &buffer, buffer.count)
                if count > 0 {
                    let data = Data(buffer[0..<count])
                    if entry.fd == out { onStdout(data) } else { onStderr(data) }
                } else if count == 0 || (errno != EINTR && errno != EAGAIN) {
                    open.removeAll { $0 == entry.fd }
                }
            }
        }
        close(out)
        close(err)
    }
}

private func writeAll(_ data: Data, to fd: Int32) {
    _ = fcntl(fd, F_SETNOSIGPIPE, 1)
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        var offset = 0
        while offset < raw.count {
            let written = write(fd, raw.baseAddress! + offset, raw.count - offset)
            if written > 0 { offset += written } else if written < 0 && errno == EINTR { continue } else { break }
        }
    }
    close(fd)
}

/// Splits bytes into lines (\n or \r\n), decoding UTF-8.
struct LineSplitter {
    private var pending = Data()
    mutating func feed(_ data: Data) -> [String] {
        pending.append(data)
        var lines: [String] = []
        while let newline = pending.firstIndex(of: 0x0A) {
            lines.append(Self.text(pending[pending.startIndex..<newline]))
            pending = Data(pending[pending.index(after: newline)...])
        }
        return lines
    }
    mutating func finish() -> [String] {
        defer { pending = Data() }
        return pending.isEmpty ? [] : [Self.text(pending)]
    }
    private static func text(_ bytes: Data) -> String {
        var line = String(decoding: bytes, as: UTF8.self)
        if line.hasSuffix("\r") { line.removeLast() }
        return line
    }
}
