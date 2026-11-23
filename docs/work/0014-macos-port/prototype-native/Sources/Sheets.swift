// Sheets: Add account, limit reset, API key (chat and video), restart wait, video billing
// route, Apply to DeepSeek Harness, command output. Each takes its starting step as a
// parameter so the render mode can draw every step without timers.

import AppKit
import SwiftUI

struct SheetHost: View {
    @ObservedObject var store: AppStore
    let kind: SheetKind

    var body: some View {
        switch kind {
        case .addAccount: AddAccountSheet(store: store)
        case .reset(let id):
            if let a = store.d.accounts.first(where: { $0.id == id }) { ResetSheet(store: store, account: a) }
        case .chatKey(let id): KeySheet(store: store, target: .chat(id))
        case .videoKey(let id): KeySheet(store: store, target: .video(id))
        case .restartWait: RestartWaitSheet(store: store, left: store.inFlight)
        case .route(let id, let enable):
            if let m = store.d.vmodels.first(where: { $0.id == id }) { RouteSheet(store: store, model: m, enableAfter: enable) }
        case .apply: ApplySheet(store: store)
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

// MARK: - Add account

struct AddAccountSheet: View {
    enum Step: Equatable { case choose, asking(String), waiting(String), success(String, String), failure(String) }

    @ObservedObject var store: AppStore
    @State var step: Step = .choose
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            content
        }
        .padding(22)
        .frame(width: 540)
        .onDisappear { if case .waiting(let p) = step { store.addLog("Sign-in to \(SERVICES[p]!.label) cancelled.") } }
    }

    @ViewBuilder private var content: some View {
        switch step {
        case .choose: choose
        case .asking(let p): asking(p)
        case .waiting(let p): waiting(p)
        case .success(let p, let email): success(p, email)
        case .failure(let p): failure(p)
        }
    }

    private var choose: some View {
        Group {
            SheetTitle(title: "Add an account", symbol: "person.crop.circle.badge.plus")
            Text("Pick the subscription to sign in to. Your browser opens to the provider's own sign-in page; DSHProxy never sees your password.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            VStack(spacing: 8) {
                ForEach(SERVICE_ORDER, id: \.self) { id in
                    let s = SERVICES[id]!
                    Button { start(id) } label: {
                        HStack(spacing: 12) {
                            Badge(letters: s.letters, hue: s.hue, size: 30)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(s.tile).font(.headline)
                                Text(s.desc).font(.callout).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 6).padding(.horizontal, 4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("Sign in to \(s.tile)")
                    .accessibilityHint(s.desc)
                }
            }
            HStack { Spacer(); Button("Cancel") { store.sheet = nil }.keyboardShortcut(.cancelAction) }
        }
    }

    private func asking(_ p: String) -> some View {
        Group {
            SheetTitle(title: "Add an account", symbol: "person.crop.circle.badge.plus")
            HStack(spacing: 12) {
                ProgressView().controlSize(.small)
                Text("Asking \(SERVICES[p]!.label) for a sign-in link...")
            }
            .padding(.vertical, 24)
            HStack { Spacer(); Button("Cancel") { step = .choose }.keyboardShortcut(.cancelAction) }
        }
    }

    private func waiting(_ p: String) -> some View {
        let s = SERVICES[p]!
        return Group {
            HStack(spacing: 12) {
                Badge(letters: s.letters, hue: s.hue, size: 40)
                Text("Signing in to \(s.label)").font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
            }
            Label("Your browser opened", systemImage: "safari").foregroundStyle(.green).font(.callout.weight(.semibold))
            if s.device {
                Text("Enter this code on the \(s.label) page that opened:")
                Text("KQ7M-4XPD")
                    .font(.system(size: 30, weight: .semibold, design: .monospaced))
                    .textSelection(.enabled)
                    .accessibilityLabel("Code K Q 7 M dash 4 X P D")
            } else {
                Text("Sign in on the \(s.label) page that opened in your browser and approve access. When it says you are signed in, come back here.")
                    .fixedSize(horizontal: false, vertical: true)
            }
            ProgressView().progressViewStyle(.linear).accessibilityLabel("Waiting for the browser")
            Text("Waiting for you to finish in your browser. This window updates by itself; the sign-in expires after 5 minutes.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Text("Prototype only:").font(.callout).foregroundStyle(.secondary)
                Button("Simulate: finished in browser") { step = .success(p, store.signedIn(p)) }
                Button("Simulate: failed") { step = .failure(p) }
            }
            Divider()
            HStack {
                Button(copied ? "Copied" : (s.device ? "Copy code" : "Copy link")) { copied = true }
                    .help("Prototype: the clipboard is not touched.")
                Spacer()
                Button("Cancel") { store.addLog("Sign-in to \(s.label) cancelled."); step = .choose }
                    .keyboardShortcut(.cancelAction)
                Button("Open page again") { store.say("Prototype: no browser was opened.") }
                    .keyboardShortcut(.defaultAction)
            }
        }
    }

    private func success(_ p: String, _ email: String) -> some View {
        let s = SERVICES[p]!
        return Group {
            HStack(spacing: 12) {
                Badge(letters: s.letters, hue: s.hue, size: 40)
                Label("Signed in to \(s.label)", systemImage: "checkmark.circle.fill")
                    .font(.title3.weight(.semibold)).foregroundStyle(.green)
            }
            Text(email)
            Text("DSHProxy can now use this subscription. Its limits appear on the Accounts tab within a minute.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Add another") { step = .choose }
                Button("Done") { store.sheet = nil }.keyboardShortcut(.defaultAction)
            }
        }
    }

    private func failure(_ p: String) -> some View {
        let s = SERVICES[p]!
        return Group {
            SheetTitle(title: "Sign-in to \(s.label) did not finish", symbol: "xmark.octagon.fill", color: .red)
            Text("\(s.label) said: access was denied in the browser. (Synthetic message.)").foregroundStyle(.secondary)
            HStack {
                Button("Close") { store.sheet = nil }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Back") { step = .choose }
                Button("Try again") { start(p) }.keyboardShortcut(.defaultAction)
            }
        }
    }

    private func start(_ p: String) {
        step = .asking(p)
        after(0.7) { if step == .asking(p) { step = .waiting(p) } }
    }
}

// MARK: - Limit reset (ChatGPT)

struct ResetSheet: View {
    @ObservedObject var store: AppStore
    let account: Account
    @State var typed = ""
    @State private var credit = ""

    var body: some View {
        let n = account.credits.count
        VStack(alignment: .leading, spacing: 12) {
            SheetTitle(title: "Danger zone: use a limit reset", symbol: "exclamationmark.octagon.fill", color: .red)
            VStack(alignment: .leading, spacing: 4) {
                Text("⚠  DANGER ZONE").font(.headline).foregroundStyle(.red)
                Text("Using a reset spends it for good. There is no undo, and it cannot be moved to another account.")
                    .fixedSize(horizontal: false, vertical: true)
                Text("\(n) reset\(n == 1 ? "" : "s") left on this account.").bold()
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.red.opacity(0.10)))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.red.opacity(0.45)))
            .accessibilityElement(children: .combine)

            (Text(account.service.label).bold() + Text(" · \(account.email)"))
            Text("A reset makes your used-up limits full again straight away. ChatGPT keeps it only if you have nothing used up.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 2) {
                ForEach(account.windows.filter { $0.left != nil }) { w in
                    (Text("Now: \(w.title) ") + Text("\(w.left!)% left").foregroundColor(levelColor(w.left!)) + Text(" · \(Fmt.resetText(w.minutes))"))
                        .font(.callout)
                }
            }
            Picker("Resets you have:", selection: $credit) {
                ForEach(account.credits) { c in
                    VStack(alignment: .leading, spacing: 1) {
                        Text(c.title)
                        Text("\(c.description) · expires \(c.expires)").font(.callout).foregroundStyle(.secondary)
                    }
                    .tag(c.id)
                }
            }
            .pickerStyle(.radioGroup)
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
                Button("Use this reset") { store.useReset(account.id, credit: credit) }
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
                    .disabled(typed.trimmingCharacters(in: .whitespacesAndNewlines) != "RESET")
            }
        }
        .padding(22)
        .frame(width: 540)
        .onAppear { if credit.isEmpty { credit = account.credits.first?.id ?? "" } }
    }
}

// MARK: - API key (chat and video)

struct KeySheet: View {
    enum Target { case chat(String), video(String) }

    @ObservedObject var store: AppStore
    let target: Target
    @State var value = ""
    @State var error: String? = nil
    @State private var region = ""
    @State private var show = false

    private var label: String {
        switch target { case .chat(let id): return keyProvider(id).label; case .video(let id): return vkeyProvider(id).label }
    }
    private var regions: [String]? { if case .chat(let id) = target { return keyProvider(id).regions }; return nil }
    private var isVideo: Bool { if case .video = target { return true }; return false }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SheetTitle(title: isVideo ? "Video API key" : "API key", symbol: "key.fill")
            Form {
                if let rs = regions {
                    Picker("Region:", selection: $region) { ForEach(rs, id: \.self) { Text($0).tag($0) } }
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
            Text("Paste the key. It is not shown again\(isVideo ? " and not checked against \(label)" : ""). Prototype: what you type is dropped when you press Save.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let e = error {
                Label(e, systemImage: "exclamationmark.circle.fill").foregroundStyle(.red).font(.callout)
            }
            HStack {
                Spacer()
                Button("Cancel") { store.sheet = nil }.keyboardShortcut(.cancelAction)
                Button("Save") { save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(value.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(22)
        .frame(width: 480)
        .onAppear {
            if case .chat(let id) = target, let rs = keyProvider(id).regions { region = store.d.keys[id]?.region ?? rs[0] }
        }
    }

    private func save() {
        let v = value.trimmingCharacters(in: .whitespaces)
        switch target {
        case .chat(let id):
            value = ""
            store.saveKey(id, region: regions == nil ? nil : region)
        case .video(let id):
            if let e = AppStore.videoKeyError(v) { error = e; return }
            value = ""
            store.saveVideoKey(id)
        }
    }
}

// MARK: - Restart wait

struct RestartWaitSheet: View {
    @ObservedObject var store: AppStore
    @State var left: Int
    @State private var cancelled = false
    var live = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SheetTitle(title: "Restart gateway", symbol: "arrow.clockwise.circle")
            Text(left > 0 ? "Waiting for \(left) request\(left == 1 ? "" : "s") to finish before restarting"
                          : "Nothing is in flight now. Waiting for the gateway to stop before restarting.")
            ProgressView().progressViewStyle(.linear).accessibilityLabel("Waiting")
            Text("The gateway keeps serving until a moment with nothing in flight, for at most 5 minutes. Cancel leaves it running; the key change is then used after the next restart.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel") {
                    cancelled = true
                    store.addLog("Restart cancelled: the gateway keeps running as it was.")
                    store.sheet = nil
                }
                .keyboardShortcut(.cancelAction)
            }
        }
        .padding(22)
        .frame(width: 460)
        .onAppear { if live { tick() } }
    }

    private func tick() {
        after(0.9) {
            guard !cancelled, store.sheet == .restartWait else { return }
            left -= 1
            if left >= 0 { tick() }
            else { store.restartCycle("Restart: the gateway stopped at a moment with nothing in flight. Starting it again.") }
        }
    }
}

// MARK: - Video billing route

struct RouteSheet: View {
    @ObservedObject var store: AppStore
    let model: VModel
    let enableAfter: Bool
    @State private var route: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SheetTitle(title: "Video billing route", symbol: "creditcard")
            Text("Charge \(model.id) to:")
            Picker("Charge \(model.id) to:", selection: $route) {
                if model.route == nil { Text("Choose a route…").tag("") }
                ForEach(model.allowed, id: \.self) { r in
                    Text("\(VROUTES[r]!.label) · \(r) · billed in \(VROUTES[r]!.units)").tag(r)
                }
            }
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .leading)
            Text("One route for each model. A paid job is never retried automatically or moved to another route.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Text("Saving a route does not check a sign-in, a key or a price, and charges nothing.\(model.enabled || enableAfter ? "" : " The model stays switched off.")")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel") { store.sheet = nil }.keyboardShortcut(.cancelAction)
                Button("Save route") { store.saveRoute(model.id, route: route, enable: enableAfter) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(route.isEmpty)
            }
        }
        .padding(22)
        .frame(width: 520)
        .onAppear { route = model.route ?? "" }
    }
}

// MARK: - Apply to DeepSeek Harness

struct ApplySheet: View {
    enum Phase: Equatable { case checklist, busy, result([String]) }
    @ObservedObject var store: AppStore
    @State var phase: Phase = .checklist
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch phase {
            case .checklist, .busy: checklist
            case .result(let lines): result(lines)
            }
        }
        .padding(22)
        .frame(width: 560)
    }

    private var checklist: some View {
        Group {
            SheetTitle(title: "Apply to DeepSeek Harness", symbol: "square.and.arrow.down.on.square")
            Text("What is in place, and what Apply will do").bold()
            VStack(alignment: .leading, spacing: 10) {
                ForEach(store.applyChecklist(), id: \.self) { item in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        mark(item.mark)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.text).fixedSize(horizontal: false, vertical: true)
                            if let s = item.sub { Text(s).font(.callout).foregroundStyle(.secondary) }
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            if phase == .busy {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Writing the routes…") }
            }
            HStack {
                Spacer()
                Button("Cancel") { store.sheet = nil }.keyboardShortcut(.cancelAction).disabled(phase == .busy)
                Button("Apply") {
                    phase = .busy
                    after(1.1) { phase = .result(store.applyNow()) }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(phase == .busy)
            }
        }
    }

    private func mark(_ m: AppStore.CheckItem.Mark) -> some View {
        let (sym, color, label): (String, Color, String) = {
            switch m {
            case .ok: return ("checkmark.circle.fill", .green, "In place")
            case .todo: return ("arrow.right.circle.fill", .accentColor, "To do")
            case .no: return ("xmark.circle.fill", .red, "Cannot")
            case .note: return ("exclamationmark.circle.fill", .orange, "Note")
            }
        }()
        return Image(systemName: sym).foregroundStyle(color).accessibilityLabel(label)
    }

    private func result(_ lines: [String]) -> some View {
        Group {
            SheetTitle(title: "DeepSeek Harness is set up", symbol: "checkmark.circle.fill", color: .green)
            Text("The chat routes were applied. DSHProxy reported:")
            OutputText(text: lines.joined(separator: "\n"))
            Text("Restart DeepSeek Harness to see the routes.").foregroundStyle(.secondary)
            HStack {
                Button(copied ? "Copied" : "Copy folder path") { copied = true }
                    .help("Prototype: the clipboard is not touched.")
                Spacer()
                Button("OK") { store.sheet = nil }.keyboardShortcut(.defaultAction)
            }
        }
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
        .frame(minHeight: 60, maxHeight: 220)
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
