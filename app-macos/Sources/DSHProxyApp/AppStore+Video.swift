// Video actions (inventory 2.7-2.11): `video settings`, `video key`, the Krea helper's status and logout.
// Video commands never run two at a time (A:3446-3450); each has 20 s.

import AppKit
import DSHProxyKit
import SwiftUI

extension AppStore {
    private func videoCommand(_ args: [String], script: Script = .dshproxy, input: String? = nil) async -> CommandResult? {
        videoBusy = true
        defer { videoBusy = false }
        return await cli(args, script: script, input: input, timeout: 20)
    }

    // MARK: Settings (2.9, 2.10)

    /// `notSaved`: this read follows a save that failed; the line keeps saying what went wrong.
    func loadVideoSettings(notSaved: String? = nil) async {
        guard !videoBusy, kit != nil else { return }
        videoStatus = (notSaved == nil ? "Reading video settings..." : notSaved! + " Reading what is saved...", notSaved == nil ? .muted : .bad)
        guard let result = await videoCommand(VideoSettings.readArguments) else { return }
        switch VideoSettings.read(code: result.code, stdout: result.stdout, stderr: result.stderr) {
        case .failure(let error):
            videoModels = nil
            videoError = error.description
            videoStatus = ((notSaved.map { $0 + " " } ?? "") + "Could not read the video settings: " + error.description, .bad)
            addLog("Video: could not read the video settings: " + error.description, .warn)
        case .success(let models):
            videoModels = models
            videoError = nil
            let read = Format.clock(Date())
            videoStatus = notSaved == nil ? ("Video settings read from DSHProxy at \(read).", .muted) : (notSaved! + " The lists show what is saved (read again at \(read)).", .bad)
        }
    }

    /// A tick on Video › Models (A:3534-3571).
    func setVideoEnabled(_ model: VideoModel, _ on: Bool) async {
        guard on != model.enabled, !videoBusy else { return }
        if model.hasRoute { await saveVideoModel(model, route: model.route, enabled: on); return }
        if !on { await saveVideoModel(model, route: VideoSettings.noRoute, enabled: false); return }
        await chooseRoute(model, enable: true)
    }

    func chooseRoute(_ model: VideoModel, enable: Bool) async {
        guard !videoBusy else { return }
        if model.routes.isEmpty {
            await inform("Video", "DSHProxy lists no allowed billing route for \(model.id), so nothing can be saved for it.", style: .warning)
            return
        }
        sheet = .route(model, enable: enable)
    }

    /// Saves one model; the lists then show what the command line reports back (A:3607-3669).
    func saveVideoModel(_ model: VideoModel, route: String, enabled: Bool) async {
        sheet = nil
        let clearing = route == VideoSettings.noRoute
        guard !videoBusy, let models = videoModels, models.contains(where: { $0.id == model.id }),
              clearing ? !enabled : model.routes.contains(route),
              let args = VideoSettings.setArguments(model: model.id, route: route, enabled: enabled) else { return }
        if model.hasRoute && route == model.route && enabled == model.enabled { return }
        let what = clearing ? "\(model.id) switched off, no billing route" : "\(model.id) \(enabled ? "enabled" : "switched off"), billing route \(route)"
        let expected = clearing ? "" : route
        videoStatus = ("Saving: \(what)...", .muted)
        guard let result = await videoCommand(args) else { return }
        guard result.code == 0 else {
            let refused = VideoSettings.failure(code: result.code, stderr: result.stderr)
            addLog("Video: not saved (\(what)): \(refused)", .warn)
            Task { await loadVideoSettings(notSaved: "Not saved: " + refused) }
            await inform("Video", "The video setting was not saved.\n\n\(refused)\n\nThe lists are being read again, so they show what is saved.", style: .critical)
            return
        }
        switch VideoSettings.read(code: result.code, stdout: result.stdout, stderr: result.stderr) {
        case .failure(let error):
            addLog("Video: saved (\(what)), but the answer could not be read: \(error.description)", .warn)
            await loadVideoSettings()
        case .success(let models):
            videoModels = models
            videoError = nil
            if let saved = models.first(where: { $0.id == model.id }), saved.enabled == enabled, saved.route == expected {
                videoStatus = ("Saved: \(what). This is a setting only; nothing was checked or charged.", .ok)
                addLog("Video: \(what).")
            } else {
                videoStatus = ("DSHProxy answered, but \(model.id) does not read as asked. The lists show what is saved.", .warn)
                addLog("Video: asked for \(what), but the saved setting reads differently.", .warn)
            }
        }
    }

    // MARK: Keys (2.8)

    func readVideoKeys(after: (text: String, tone: Tone)? = nil) async {
        guard !videoBusy, kit != nil else { return }
        if after == nil { videoKeysStatus = ("Reading the video keys...", .muted) }
        guard let result = await videoCommand(VideoKeys.listArguments) else { return }
        switch VideoKeys.read(code: result.code, stdout: result.stdout, stderr: result.stderr) {
        case .failure(let error):
            videoKeys = nil
            videoKeysStatus = ("Could not read the video keys: " + error.description, .bad)
        case .success(let providers):
            videoKeys = providers
            videoKeysStatus = after ?? ("Read from DSHProxy at \(Format.clock(Date())).", .muted)
        }
    }

    /// The key goes to `video key set P` on standard input and nowhere else (A:3811-3856).
    func saveVideoKey(_ provider: VideoKeyProvider, key: String) async {
        sheet = nil
        guard let args = VideoKeys.setArguments(provider.id), !videoBusy else { return }
        guard let result = await videoCommand(args, input: key + "\n") else { return }
        if VideoKeys.saved(code: result.code, stdout: result.stdout, provider: provider.id) {
            let text = "Saved the \(provider.label) key. It was not checked against \(provider.label)."
            addLog("Video: " + text)
            await readVideoKeys(after: (text, .ok))
        } else {
            let why = VideoKeys.without(VideoSettings.failure(code: result.code, stderr: result.stderr), key: key)
            addLog("Video: the \(provider.label) key was not saved: " + why, .warn)
            await readVideoKeys(after: ("Not saved: " + why, .bad))
            await inform("Video API key", "The \(provider.label) key was not saved.\n\n" + why, style: .critical)
        }
    }

    func removeVideoKey(_ provider: VideoKeyProvider) async {
        guard await confirm("Video API key", "Remove the saved \(provider.label) video key?\n\nDSHProxy's video command can then use \(provider.label) only with a key in \(provider.variable).", yes: "Remove"),
              let args = VideoKeys.removeArguments(provider.id), !videoBusy else { return }
        guard let result = await videoCommand(args) else { return }
        switch VideoKeys.removed(code: result.code, stdout: result.stdout, provider: provider.id) {
        case .some(true):
            addLog("Video: removed the \(provider.label) key.")
            await readVideoKeys(after: ("Removed the \(provider.label) key.", .ok))
        case .some(false):
            await readVideoKeys(after: ("No \(provider.label) key was saved.", .muted))
        case .none:
            let why = result.code == 0 ? "DSHProxy did not answer as expected." : VideoSettings.failure(code: result.code, stderr: result.stderr)
            addLog("Video: the \(provider.label) key was not removed: " + why, .warn)
            await readVideoKeys(after: ("Not removed: " + why, .bad))
        }
    }

    // MARK: Krea (2.7)

    /// Read only when the page opens: `dshproxy-krea.js status` (A:3938-3965).
    func readKrea() async {
        guard !videoBusy, kit != nil else { return }
        kreaState = "Reading..."
        kreaTone = .muted
        guard let result = await videoCommand(["status"], script: .krea) else { return }
        kreaReadAt = Date()
        if result.code == 0, let parsed = Krea.parseStatus(result.stdout, now: Date()) {
            krea = parsed
            kreaState = Krea.describe(parsed)
            kreaTone = parsed.signedIn ? .ok : .muted
        } else {
            krea = nil
            kreaState = "Not known"
            kreaTone = .warn
        }
    }

    /// `dshproxy-krea.js login` (inventory 2.7): its first line must be an https address on a Krea host, which is
    /// opened in the browser; at most 60 s for that line and 240 s more for the end. Cancel ends the helper.
    func kreaSignInStart() {
        guard let kit, kreaSignIn == nil else { return }
        let command = StreamingCommand(runner: kit.runner)
        kreaSignIn = command
        kreaState = "Signing in..."
        kreaTone = .warn
        addLog("Krea: sign-in started.")
        let gotAddress = SignInFlag()
        let ending = SignInFlag()   // an outcome decided here before the helper ended
        command.start(.krea, ["login"], timeout: 60 + 240, onLine: { [weak self] line in
            guard gotAddress.setOnce() else { return }
            guard let address = Krea.consentAddress(line), let url = URL(string: address) else {
                ending.outcome = .addressRefused
                command.cancel()
                return
            }
            DispatchQueue.main.async {
                if !NSWorkspace.shared.open(url) {
                    ending.outcome = .browserNotOpened
                    command.cancel()
                } else {
                    self?.say("Krea's consent page is open in your browser. Sign in there; this page waits.")
                }
            }
        }, completion: { [weak self] result in
            let outcome: KreaOutcome
            if let decided = ending.outcome { outcome = decided }
            else if result.timedOut { outcome = gotAddress.isSet ? .notFinishedInTime : .noAddressInTime }
            else if result.code == nil && !gotAddress.isSet && !result.stderr.isEmpty { outcome = .notStarted }
            else if result.code == nil { outcome = .cancelled }
            else if result.code == 0 && !gotAddress.isSet { outcome = .endedWithoutAddress }
            else { outcome = Krea.ended(exitCode: result.code, errors: result.stderr) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.kreaSignIn = nil
                let text = Krea.message(outcome)
                self.addLog("Krea: " + text, outcome == .signedIn ? .plain : .warn)
                self.say(text)
                Task { await self.readKrea() }
            }
        })
        // No address within a minute: the helper is stopped.
        DispatchQueue.global().asyncAfter(deadline: .now() + 60) {
            if !gotAddress.isSet && ending.outcome == nil { ending.outcome = .noAddressInTime; command.cancel() }
        }
    }

    func kreaSignInCancel() {
        kreaSignIn?.cancel()
    }

    func kreaSignOut() async {
        guard await confirm("Krea", "Sign out of Krea?\n\nThe Krea sign-in stored on this computer is removed. Video on the Krea workspace route then needs a new sign-in.", yes: "Sign out"),
              !videoBusy else { return }
        guard let result = await videoCommand(["logout"], script: .krea) else { return }
        if result.code == 0 {
            addLog("Signed out of Krea.")
            say("Signed out of Krea.")
        } else {
            let why = VideoSettings.failure(code: result.code, stderr: result.stderr)
            addLog("Krea: sign-out failed: " + why, .warn)
            await inform("Krea", "The Krea sign-in was not removed.\n\n" + why, style: .critical)
        }
        await readKrea()
    }
}

/// A flag and an outcome shared between the sign-in's callbacks, which arrive on other threads.
final class SignInFlag {
    private let lock = NSLock()
    private var set = false
    private var decided: KreaOutcome?
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return set }
    /// True only for the first caller.
    func setOnce() -> Bool { lock.lock(); defer { lock.unlock() }; if set { return false }; set = true; return true }
    var outcome: KreaOutcome? {
        get { lock.lock(); defer { lock.unlock() }; return decided }
        set { lock.lock(); if decided == nil { decided = newValue }; lock.unlock() }
    }
}
