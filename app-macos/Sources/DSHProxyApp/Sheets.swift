// Sheets: Add account (sign-in), limit reset, API key (chat and video), restart wait, video billing route,
// Apply to DeepSeek Harness (checklist, progress, wait for DeepSeek Harness to quit, result), command output.

import AppKit
import DSHProxyKit
import SwiftUI

struct SheetHost: View {
    @ObservedObject var store: AppStore
    let kind: SheetKind

    var body: some View {
        switch kind {
        case .addAccount: AddAccountSheet(store: store)
        case .laneEditor(let lanes): LaneEditorSheet(store: store, lanes: lanes)
        case .reset(let account, let credits): ResetSheet(store: store, account: account, credits: credits)
        case .chatKey(let provider): KeySheet(store: store, target: .chat(provider))
        case .videoKey(let provider): KeySheet(store: store, target: .video(provider))
        case .restartWait: RestartWaitSheet(store: store)
        case .route(let model, let enable): RouteSheet(store: store, model: model, enableAfter: enable)
        case .applyChecklist(let setup): ApplyChecklistSheet(store: store, setup: setup)
        case .applyBusy(let text): BusySheet(text: text)
        case .harnessWait: HarnessWaitSheet(store: store)
        case .applyResult(let result): ApplyResultSheet(store: store, result: result)
        case .output(let o): OutputSheet(store: store, spec: o)
        }
    }
}

/// Title row shared by the sheets.
struct SheetTitle: View {
    let title: String
    var symbol: String? = nil
    var color: Color = .accentColor
    var body: some View {
        HStack(spacing: 10) {
            if let s = symbol { Image(systemName: s).font(.title2).foregroundStyle(color).accessibilityHidden(true) }
            Text(title).font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
        }
    }
}

func copyToClipboard(_ text: String) -> Bool {
    NSPasteboard.general.clearContents()
    return NSPasteboard.general.setString(text, forType: .string)
}

// MARK: - Add account (2.1.1)

struct AddAccountSheet: View {
    enum Step: Equatable {
        case choose
        case asking(LoginProvider)
        case waiting(LoginProvider, LoginStart)
        case success(LoginProvider, String)
        case failure(LoginProvider, String, retry: Bool)
    }

    @ObservedObject var store: AppStore
    @State var step: Step = .choose
    @State private var copied = false
    @State private var poll: Task<Void, Never>?
    /// The attempt an answer belongs to; Cancel, Back and Try again start a new one.
    @State private var attempt = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 14) { content }
            .padding(22)
            .frame(width: 540)
            .onDisappear { cancelSession() }
    }

    @ViewBuilder private var content: some View {
        switch step {
        case .choose: choose
        case .asking(let p): asking(p)
        case .waiting(let p, let start): waiting(p, start)
        case .success(let p, let account): success(p, account)
        case .failure(let p, let message, let retry): failure(p, message, retry)
        }
    }

    private var choose: some View {
        Group {
            SheetTitle(title: "Add an account", symbol: "person.crop.circle.badge.plus")
            Text("Pick the subscription to sign in to. Your browser opens to the provider's own sign-in page; DSHProxy never sees your password.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            VStack(spacing: 8) {
                ForEach(store.loginProviders) { p in
                    Button { begin(p) } label: {
                        HStack(spacing: 12) {
                            LogoView(name: p.key, size: 30)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(p.label).font(.headline)
                                if !p.details.isEmpty { Text(p.details).font(.callout).foregroundStyle(.secondary) }
                            }
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 6).padding(.horizontal, 4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("Sign in to \(p.label)")
                    .accessibilityHint(p.details)
                }
            }
            HStack { Spacer(); Button("Cancel") { store.sheet = nil }.keyboardShortcut(.cancelAction) }
        }
    }

    private func asking(_ p: LoginProvider) -> some View {
        Group {
            HStack(spacing: 12) {
                LogoView(name: p.key, size: 40)
                Text("Signing in to \(p.label)").font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
            }
            HStack(spacing: 12) {
                ProgressView().controlSize(.small)
                Text("Asking the provider for a sign-in link...")
            }
            .padding(.vertical, 24)
            HStack { Spacer(); Button("Cancel") { step = .choose }.keyboardShortcut(.cancelAction) }
        }
    }

    private func waiting(_ p: LoginProvider, _ start: LoginStart) -> some View {
        Group {
            HStack(spacing: 12) {
                LogoView(name: p.key, size: 40)
                Text("Signing in to \(p.label)").font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
            }
            if start.device && !start.userCode.isEmpty {
                Text("Enter this code on the \(p.label) page that opened:")
                HStack(spacing: 14) {
                    Text(start.userCode)
                        .font(.system(size: 30, weight: .semibold, design: .monospaced))
                        .textSelection(.enabled)
                    Button(copied ? "Copied" : "Copy code") { copied = copyToClipboard(start.userCode) }
                }
            } else {
                Text("Sign in on the \(p.label) page that opened and approve access. When it says you are signed in, come back here.")
                    .fixedSize(horizontal: false, vertical: true)
            }
            ProgressView().progressViewStyle(.linear).accessibilityLabel("Waiting for the browser")
            Text("Waiting for you to finish in your browser. This window updates by itself; the sign-in expires after 5 minutes.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Divider()
            HStack {
                if !(start.device && !start.userCode.isEmpty) {
                    Button(copied ? "Copied" : "Copy link") { copied = copyToClipboard(start.url) }
                }
                Spacer()
                Button("Cancel") { cancelSession(); step = .choose }
                    .keyboardShortcut(.cancelAction)
                Button("Open page again") { store.openSignIn(start.url) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(Links.signInURL(start.url) == nil)
            }
        }
    }

    private func success(_ p: LoginProvider, _ account: String) -> some View {
        Group {
            HStack(spacing: 12) {
                LogoView(name: p.key, size: 40)
                Label("Signed in to \(p.label)", systemImage: "checkmark.circle.fill")
                    .font(.title3.weight(.semibold)).foregroundStyle(.green)
            }
            if !account.isEmpty { Text(account) }
            Text("DSHProxy can now use this subscription. Its limits appear on the Accounts tab within a minute.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Add another") { step = .choose }
                Button("Done") { store.sheet = nil }.keyboardShortcut(.defaultAction)
            }
        }
    }

    private func failure(_ p: LoginProvider, _ message: String, _ retry: Bool) -> some View {
        Group {
            SheetTitle(title: "Sign-in to \(p.label) did not finish", symbol: "xmark.octagon.fill", color: .red)
            Text(message).fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("Close") { store.sheet = nil }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Back") { step = .choose }
                if retry { Button("Try again") { begin(p) }.keyboardShortcut(.defaultAction) }
            }
        }
    }

    private func begin(_ p: LoginProvider) {
        copied = false
        attempt += 1
        let mine = attempt
        step = .asking(p)
        Task {
            let started = await store.loginStart(p.key)
            guard attempt == mine, step == .asking(p) else {
                if case .success(let s) = started { store.loginCancel(s.id) }
                return
            }
            switch started {
            case .failure(let message): step = .failure(p, message, retry: true)
            case .success(let start):
                step = .waiting(p, start)
                store.openSignIn(start.url)
                startPolling(p, start, attempt: mine)
            }
        }
    }

    /// `GET login/status` every 1.5 s (A:735-767).
    private func startPolling(_ p: LoginProvider, _ start: LoginStart, attempt mine: Int) {
        poll?.cancel()
        poll = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                guard !Task.isCancelled, case .waiting(_, let current) = step, current.id == start.id else { return }
                let answer = await store.loginStatus(start.id)
                // Cancelled or replaced while the answer was on its way: it is not this attempt's any more.
                guard !Task.isCancelled, attempt == mine, case .waiting(_, let still) = step, still.id == start.id else { return }
                switch answer {
                case .ok(let account)?:
                    step = .success(p, account)
                    store.signedIn(account.isEmpty ? p.label : account)
                    return
                case .error(let message)?:
                    step = .failure(p, message, retry: false)
                    return
                default: continue
                }
            }
        }
    }

    /// Closing the sheet or Cancel cancels an open session (A:571-575).
    private func cancelSession() {
        attempt += 1
        poll?.cancel()
        poll = nil
        if case .waiting(let p, let start) = step {
            store.loginCancel(start.id)
            store.addLog("Sign-in to \(p.label) cancelled.")
        }
    }
}

// MARK: - Limit reset (2.1.2)

struct ResetSheet: View {
    @ObservedObject var store: AppStore
    let account: AccountLimits
    let credits: ResetCredits
    @State var typed = ""
    @State private var credit = ""

    var body: some View {
        let n = credits.count
        VStack(alignment: .leading, spacing: 12) {
            SheetTitle(title: "Danger zone: use a limit reset", symbol: "exclamationmark.octagon.fill", color: .red)
            VStack(alignment: .leading, spacing: 4) {
                Text("\u{26A0}  DANGER ZONE").font(.headline).foregroundStyle(.red)
                Text("Using a reset spends it for good. There is no undo, and it cannot be moved to another account.")
                    .fixedSize(horizontal: false, vertical: true)
                Text("\(n) reset\(n == 1 ? "" : "s") left on this account.").bold()
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.red.opacity(0.10)))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.red.opacity(0.45)))
            .accessibilityElement(children: .combine)

            (Text(account.label).bold() + Text(" \u{B7} \(account.account)"))
            Text("A reset makes your used-up limits full again straight away. ChatGPT keeps it only if you have nothing used up.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 2) {
                ForEach(account.windows.filter(\.reported)) { w in
                    Text("Now: \(w.title) " + w.line(now: store.now)).foregroundColor(levelColor(w.leftPercent)).font(.callout)
                }
            }
            if credits.credits.isEmpty {
                Text("ChatGPT did not name the reset; the next one available would be used.").foregroundStyle(.secondary)
            } else {
                Picker("Resets you have:", selection: $credit) {
                    ForEach(credits.credits) { c in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(c.title).bold()
                            let line = c.line()
                            if !line.isEmpty { Text(line).font(.callout).foregroundStyle(.secondary) }
                        }
                        .tag(c.id)
                    }
                }
                .pickerStyle(.radioGroup)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Type RESET to confirm:")
                TextField("RESET", text: $typed)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 200)
                    .accessibilityLabel("Type RESET to confirm")
                    .accessibilityHint("Capital letters. The button stays off until the word matches.")
                Text("Capital letters. The button stays off until the word matches.").font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Spacer()
                Button("Cancel") { store.sheet = nil }.keyboardShortcut(.cancelAction)
                Button("Use this reset") { Task { await store.consumeReset(file: account.file, creditID: credit.isEmpty ? nil : credit) } }
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
                    .disabled(typed.trimmingCharacters(in: .whitespacesAndNewlines) != "RESET")
            }
        }
        .padding(22)
        .frame(width: 540)
        .onAppear { if credit.isEmpty { credit = credits.credits.first?.id ?? "" } }
    }
}

// MARK: - API key (chat and video)

struct KeySheet: View {
    enum Target { case chat(KeyProvider), video(VideoKeyProvider) }

    @ObservedObject var store: AppStore
    let target: Target
    @State var value = ""
    @State var error: String? = nil
    @State private var region = ""
    @State private var show = false

    private var label: String {
        switch target { case .chat(let p): return p.label; case .video(let p): return p.label }
    }
    private var regions: [KeyRegion] { if case .chat(let p) = target { return p.regions }; return [] }
    private var isVideo: Bool { if case .video = target { return true }; return false }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SheetTitle(title: isVideo ? "Video API key" : "API key", symbol: "key.fill")
            Form {
                if regions.count > 1 {
                    Picker("Region:", selection: $region) { ForEach(regions) { Text($0.label).tag($0.key) } }
                        .fixedSize()
                }
                Group {
                    if show { TextField("API key for \(label):", text: $value) }
                    else { SecureField("API key for \(label):", text: $value) }
                }
                .frame(width: 300)
                .onChange(of: value) { _ in error = nil }
                Toggle("Show key", isOn: $show).toggleStyle(.checkbox)
            }
            Text("Paste the key. It is not shown again\(isVideo ? " and not checked against \(label)" : ""). It goes to DSHProxy on standard input only.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let e = error {
                Label(e, systemImage: "exclamationmark.circle.fill").foregroundStyle(.red).font(.callout)
            }
            HStack {
                Spacer()
                Button("Cancel") { value = ""; store.sheet = nil }.keyboardShortcut(.cancelAction)
                Button("Save") { save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(value.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(22)
        .frame(width: 480)
        .onAppear {
            if case .chat(let p) = target { region = p.savedRegion ?? p.regions.first?.key ?? "" }
        }
    }

    private func save() {
        let key = value.trimmingCharacters(in: .whitespacesAndNewlines)
        switch target {
        case .chat(let p):
            value = ""
            Task { await store.saveKey(p, region: region.isEmpty ? nil : region, key: key) }
        case .video(let p):
            if let refusal = VideoKeys.refusal(key) { error = refusal; return }
            value = ""
            Task { await store.saveVideoKey(p, key: key) }
        }
    }
}

// MARK: - Restart wait (A:5983-6073)

struct RestartWaitSheet: View {
    @ObservedObject var store: AppStore

    var body: some View {
        let left = store.inFlight
        VStack(alignment: .leading, spacing: 12) {
            SheetTitle(title: "Restart gateway", symbol: "arrow.clockwise.circle")
            Text(store.restartCancelling ? "Cancelling the restart..."
                 : left > 0 ? "Waiting for \(left) request\(left == 1 ? "" : "s") to finish before restarting"
                 : "Nothing is in flight now. Waiting for the gateway to stop before restarting.")
            ProgressView().progressViewStyle(.linear).accessibilityLabel("Waiting")
            Text("The gateway keeps serving until a moment with nothing in flight, for at most 5 minutes. Cancel leaves it running; the key change is then used after the next restart.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel") { store.cancelRestart() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(store.restartCancelling)
            }
        }
        .padding(22)
        .frame(width: 460)
        .interactiveDismissDisabled()
    }
}

// MARK: - Video billing route (A:6426-6469)

struct RouteSheet: View {
    @ObservedObject var store: AppStore
    let model: VideoModel
    let enableAfter: Bool
    @State private var route: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SheetTitle(title: "Video billing route", symbol: "creditcard")
            Text("Charge \(model.id) to:")
            Picker("Charge \(model.id) to:", selection: $route) {
                if !model.hasRoute { Text("Choose a route\u{2026}").tag("") }
                ForEach(model.routes, id: \.self) { r in
                    Text("\(VideoSettings.routeName(r)) \u{B7} billed in \(VideoSettings.units(r))").tag(r)
                }
            }
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .leading)
            Text("One route for each model. A paid job is never retried automatically or moved to another route.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Text("Saving a route does not check a sign-in, a key or a price, and charges nothing. Unpriced ElevenLabs routes are setup only: no quote or generation is available.\(enableAfter ? "" : " The model stays switched off.")")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel") { store.sheet = nil }.keyboardShortcut(.cancelAction)
                Button("Save route") { Task { await store.saveVideoModel(model, route: route, enabled: enableAfter) } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(route.isEmpty)
            }
        }
        .padding(22)
        .frame(width: 520)
        .onAppear { route = model.hasRoute ? model.route : "" }
    }
}

// MARK: - Apply to DeepSeek Harness (2.5.1)

struct SetupLineView: View {
    let line: SetupLine
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            mark
            VStack(alignment: .leading, spacing: 2) {
                Text(line.text).fixedSize(horizontal: false, vertical: true)
                if !line.detail.isEmpty {
                    Text(line.detail).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var mark: some View {
        let (sym, color, label): (String, Color, String) = {
            switch line.mark {
            case .done: return ("checkmark.circle.fill", .green, "In place")
            case .toDo: return ("arrow.right.circle.fill", .accentColor, "To do")
            case .cannot: return ("xmark.circle.fill", .red, "Cannot")
            case .note: return ("exclamationmark.circle.fill", .orange, "Note")
            }
        }()
        return Image(systemName: sym).foregroundStyle(color).accessibilityLabel(label)
    }
}

struct ApplyChecklistSheet: View {
    @ObservedObject var store: AppStore
    let setup: HarnessSetup

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SheetTitle(title: "Apply to DeepSeek Harness", symbol: "square.and.arrow.down.on.square")
            Text("What is in place, and what Apply will do").bold()
            VStack(alignment: .leading, spacing: 10) {
                ForEach(setup.confirmLines, id: \.self) { SetupLineView(line: $0) }
            }
            HStack {
                Spacer()
                Button("Cancel") { store.answer(false) }.keyboardShortcut(.cancelAction)
                Button("Apply") { store.answer(true) }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(22)
        .frame(width: 560)
    }
}

struct BusySheet: View {
    let text: String
    var body: some View {
        HStack(spacing: 10) { ProgressView().controlSize(.small); Text(text) }
            .padding(28)
            .frame(width: 360)
            .interactiveDismissDisabled()
    }
}

/// Waits for DeepSeek Harness to quit; checks every second (A:6271-6373). Only looks: never closes it.
struct HarnessWaitSheet: View {
    @ObservedObject var store: AppStore
    @State private var watch: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SheetTitle(title: "Quit DeepSeek Harness to install the video tools", symbol: "hourglass")
            Text("The chat routes are written. The video tools can only be installed while DeepSeek Harness is closed.")
                .fixedSize(horizontal: false, vertical: true)
            Text("Closing its window may not be enough: DeepSeek Harness can stay in the menu bar. Quit it there too (DeepSeek Harness \u{203A} Quit).")
                .fixedSize(horizontal: false, vertical: true)
            Text("This window closes by itself when DeepSeek Harness has quit, and the video tools are installed then. DSHProxy does not close DeepSeek Harness for you.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            ProgressView().progressViewStyle(.linear)
            HStack {
                Spacer()
                Button("Skip the video tools") { watch?.cancel(); store.answer(false) }.keyboardShortcut(.cancelAction)
            }
        }
        .padding(22)
        .frame(width: 520)
        .onAppear {
            watch = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    if !AppStore.deepSeekHarnessRunning() { store.answer(true); return }
                }
            }
        }
        .onDisappear { watch?.cancel() }
    }
}

struct ApplyResultSheet: View {
    @ObservedObject var store: AppStore
    let result: SetupResult
    @State private var copied: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SheetTitle(title: result.heading, symbol: result.heading == "DeepSeek Harness is set up" ? "checkmark.circle.fill" : "exclamationmark.triangle.fill",
                       color: result.heading == "DeepSeek Harness is set up" ? .green : .orange)
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(result.lines.enumerated()), id: \.offset) { SetupLineView(line: $0.element) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 360)
            .fixedSize(horizontal: false, vertical: true)
            HStack {
                if let path = result.copyPath {
                    Button(copied ?? "Copy folder path") { copied = copyToClipboard(path) ? "Copied" : "Could not copy" }
                }
                Spacer()
                Button("OK") { store.sheet = nil }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(22)
        .frame(width: 600)
    }
}

struct OutputText: View {
    let text: String
    var body: some View {
        ScrollView {
            Text(text)
                .font(.system(size: 12, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
        }
        .frame(minHeight: 60, maxHeight: 320)
        .fixedSize(horizontal: false, vertical: true)
        .background(Color(nsColor: .textBackgroundColor))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: .separatorColor)))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

struct OutputSheet: View {
    @ObservedObject var store: AppStore
    let spec: OutputSpec
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SheetTitle(title: spec.title, symbol: spec.good ? "info.circle.fill" : "exclamationmark.triangle.fill",
                       color: spec.good ? .accentColor : .orange)
            if let i = spec.intro { Text(i).foregroundStyle(.secondary) }
            OutputText(text: spec.text)
            if let f = spec.footnote { Text(f).foregroundStyle(.secondary) }
            HStack { Spacer(); Button("OK") { store.sheet = nil }.keyboardShortcut(.defaultAction) }
        }
        .padding(22)
        .frame(width: 600)
    }
}
