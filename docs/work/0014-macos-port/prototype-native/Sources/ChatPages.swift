// Chat workspace pages: Accounts, API keys, Lanes, Models, DeepSeek Harness, and the shared Log.

import SwiftUI

/// What the gateway-dependent pages show while it is starting or not answering.
struct GatewayStatePanel: View {
    @ObservedObject var store: AppStore
    let what: String
    var body: some View {
        if store.gateway == .starting {
            StatePanel(symbol: "hourglass", title: "The gateway is starting.", text: "\(what) are shown when it answers.", spinner: true)
        } else {
            StatePanel(symbol: "exclamationmark.triangle", title: "The gateway is not answering.",
                       text: "\(what) are shown again when it does. Stop asks before it cuts anything.")
        }
    }
}

func tableHeight(_ rows: Int, row: CGFloat = 26) -> CGFloat { 30 + CGFloat(max(rows, 1)) * row + 10 }

// MARK: - Accounts

struct AccountsPage: View {
    @ObservedObject var store: AppStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                PageHeader(title: "Accounts",
                           note: "Subscription accounts and how much of each limit is left. Bars turn amber below 30% and red below 10%.") {
                    Button { store.addAccount() } label: { Label("Add account…", systemImage: "plus") }
                        .buttonStyle(.borderedProminent)
                    Button("Refresh limits") { store.refreshLimits() }.disabled(!store.running)
                    Button("Show credentials in Finder") { store.showInFinder("~/.dshproxy/auth") }
                }
                content
            }
            .padding(20)
        }
    }

    @ViewBuilder private var content: some View {
        if !store.running {
            GatewayStatePanel(store: store, what: "Accounts and limits")
        } else if store.d.accounts.isEmpty {
            StatePanel(symbol: "person.crop.circle.badge.plus", title: "No accounts yet",
                       text: "Press “Add account…” to sign in to Claude, ChatGPT, Gemini or Kimi. Your browser opens the provider's own sign-in page; DSHProxy never sees your password.") {
                Button { store.addAccount() } label: { Label("Add account…", systemImage: "plus") }
                    .buttonStyle(.borderedProminent).controlSize(.large).padding(.top, 4)
            }
        } else {
            Text(store.limitsNote).font(.callout).foregroundStyle(.secondary)
            ForEach(store.d.accounts) { a in AccountCard(store: store, account: a) }
        }
    }
}

struct AccountCard: View {
    @ObservedObject var store: AppStore
    let account: Account

    var body: some View {
        let a = account
        VStack(alignment: .leading, spacing: 10) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { identity; chips; Spacer(minLength: 12); buttons }
                VStack(alignment: .leading, spacing: 8) { HStack(spacing: 10) { identity; chips }; buttons }
            }
            if !a.windows.isEmpty && !a.disabled {
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 7) {
                    ForEach(a.windows) { LimitRow(window: $0) }
                }
                .padding(.leading, 38)
            }
            if !a.credits.isEmpty && !a.disabled { resetStrip }
            if a.disabled {
                Text("Paused: DSHProxy does not use this account until you resume it.").font(.callout).foregroundStyle(.secondary).padding(.leading, 38)
            } else if !a.supported {
                Text("\(a.service.label) does not report its limits.").font(.callout).foregroundStyle(.secondary).padding(.leading, 38)
            }
        }
        .card()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(a.service.label) \(a.email)")
    }

    private var identity: some View {
        HStack(spacing: 10) {
            Badge(letters: account.service.letters, hue: account.service.hue, size: 28)
            VStack(alignment: .leading, spacing: 1) {
                Text(account.service.label).font(.headline)
                Text(account.email).font(.callout).foregroundStyle(.secondary)
            }
            .fixedSize()
        }
    }

    private var chips: some View {
        HStack(spacing: 6) {
            Chip(text: account.planText, color: .teal)
            if account.primary && store.siblings(account) > 1 { Chip(text: "Primary", color: .green) }
            if account.disabled { Chip(text: "● Paused") } else { Chip(text: "● Active", color: .green) }
        }
    }

    private var buttons: some View {
        let a = account, sib = store.siblings(a)
        return HStack(spacing: 6) {
            if sib > 1 && a.primary {
                Button("Not primary") { store.notPrimary(a) }
                    .accessibilityLabel("Not primary: let the \(a.service.label) accounts take turns")
            }
            if sib > 1 && !a.primary && !a.disabled {
                Button("Make primary") { store.makePrimary(a) }
                    .accessibilityLabel("Make \(a.service.label) \(a.email) primary")
            }
            Button(a.disabled ? "Resume" : "Pause") { store.togglePause(a) }
                .accessibilityLabel("\(a.disabled ? "Resume" : "Pause") \(a.service.label) \(a.email)")
            DangerButton("Sign out…") { store.presentAlert(store.signOutAlert(a)) }
                .accessibilityLabel("Sign out of \(a.service.label) \(a.email)…")
        }
        .fixedSize()
    }

    private var resetStrip: some View {
        let n = account.credits.count
        return HStack(spacing: 10) {
            Chip(text: n == 1 ? "⚠ 1 limit reset" : "⚠ \(n) limit resets", color: .red)
            Text("Danger zone: spending one cannot be undone.").font(.callout)
            Spacer(minLength: 8)
            Button("Use a reset…") { store.sheet = .reset(account.id) }
                .buttonStyle(.borderedProminent).tint(.red)
                .accessibilityLabel("Use a limit reset on \(account.service.label) \(account.email)…")
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.red.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.red.opacity(0.30)))
        .padding(.leading, 38)
    }
}

// MARK: - API keys

struct KeysPage: View {
    @ObservedObject var store: AppStore
    @State private var selection: String? = "deepseek"

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PageHeader(title: "API keys",
                       note: "Pay-per-use API keys. Keys are stored encrypted in the DSHProxy data folder; the key that unlocks them is kept in your macOS Keychain. Restart the gateway after a change.")
            if !store.running {
                Banner(symbol: "exclamationmark.triangle", text: store.gateway == .starting
                       ? "The gateway is starting. Keys can still be saved; the gateway uses them when it starts."
                       : "The gateway is not answering. Keys can still be saved; the gateway uses them when it starts.")
            }
            Table(KEY_PROVIDERS, selection: $selection) {
                TableColumn("Provider") { p in
                    HStack(spacing: 8) { Badge(letters: p.letters, hue: p.hue, size: 18); Text(p.label) }
                }
                TableColumn("Region") { p in
                    if p.regions != nil { Text(store.d.keys[p.id]?.region ?? p.regions![0]) } else { Text("—").foregroundStyle(.tertiary) }
                }
                TableColumn("State") { p in stateText(store.d.keys[p.id]!.state) }
            }
            .contextMenu(forSelectionType: String.self) { ids in
                if let id = ids.first {
                    Button("Add or replace key…") { store.sheet = .chatKey(id) }
                    if store.d.keys[id]?.state != KeyState.none { Button("Remove…") { store.presentAlert(store.removeKeyAlert(id)) } }
                }
            } primaryAction: { ids in if let id = ids.first { store.sheet = .chatKey(id) } }
            .frame(height: tableHeight(KEY_PROVIDERS.count))
            .accessibilityLabel("API keys")

            HStack(spacing: 8) {
                Button("Add or replace key…") { if let s = selection { store.sheet = .chatKey(s) } }
                    .buttonStyle(.borderedProminent)
                    .disabled(selection == nil)
                DangerButton("Remove…") { if let s = selection { store.presentAlert(store.removeKeyAlert(s)) } }
                    .disabled(selection == nil || store.d.keys[selection ?? ""]?.state == KeyState.none)
                Text(selection.map { "Selected: \(keyProvider($0).label). Double-click a row to add or replace its key." } ?? "Select a provider.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .pagePadding()
    }

    @ViewBuilder private func stateText(_ s: KeyState) -> some View {
        switch s {
        case .saved: Text("Saved").foregroundStyle(.green)
        case .unreadable: Text("Saved, cannot be read: add it again").foregroundStyle(.red)
        case .none: Text("Not set").foregroundStyle(.secondary)
        }
    }
}

// MARK: - Lanes

struct LanesPage: View {
    @ObservedObject var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PageHeader(title: "Lanes",
                       note: "A lane tries each model in order until one answers. Green: can serve. Amber: sitting out after running out of quota. Red: no account or key.") {
                Button("Edit lanes (settings.json)…") { store.presentAlert(store.editLanesAlert()) }
            }
            if !store.running {
                GatewayStatePanel(store: store, what: "Lanes and their models")
                Spacer(minLength: 0)
            } else {
                presetBox
                legend
                List {
                    ForEach(LANES, id: \.self) { lane in LaneRow(store: store, lane: lane) }
                }
                .listStyle(.inset(alternatesRowBackgrounds: true))
                .accessibilityLabel("Lanes")
            }
        }
        .pagePadding()
    }

    private var presetBox: some View {
        let p = store.d.preset
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Text("Routing:").bold()
                Picker("Routing preset", selection: Binding(get: { p }, set: { store.choosePreset($0) })) {
                    ForEach(PRESETS) { Text($0.label).tag($0.id) }
                    if p == "custom" { Text("Custom").tag("custom") }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .accessibilityLabel("Routing preset")
            }
            Text(p == "custom" ? "Custom ladders, edited in settings.json. Pick a preset to replace them."
                               : "Active: \(presetNamed(p)!.label). \(presetNamed(p)!.summary)")
                .font(.callout).foregroundStyle(.secondary)
        }
        .card()
    }

    private var legend: some View {
        HStack(spacing: 14) {
            LadderChip(model: "can serve", state: .ok, why: "")
            LadderChip(model: "sitting out", state: .cool, why: "")
            LadderChip(model: "no account or key", state: .bad, why: "")
        }
        .font(.callout)
        .accessibilityHidden(true)
    }
}

struct LaneRow: View {
    @ObservedObject var store: AppStore
    let lane: String

    var body: some View {
        let ladder = store.d.lanes[lane] ?? []
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("lane-\(lane)").bold().frame(width: 104, alignment: .leading)
            FlowLayout(spacing: 4, lineSpacing: 5) {
                ForEach(Array(ladder.enumerated()), id: \.offset) { i, m in
                    HStack(spacing: 4) {
                        if i > 0 { Text("›").foregroundStyle(.secondary).accessibilityHidden(true) }
                        LadderChip(model: m, state: store.laneState(m), why: why(m))
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("lane-\(lane), first to last")
    }

    private func why(_ m: String) -> String {
        switch store.laneState(m) {
        case .ok: return "can serve"
        case .cool: return "sitting out after running out of quota, back in \(store.d.cooling[m] ?? 0) min"
        case .bad: return "no account or key"
        }
    }
}

struct LadderChip: View {
    let model: String
    let state: AppStore.LaneState
    let why: String

    var body: some View {
        let (sym, color): (String, Color) = {
            switch state {
            case .ok: return ("✓", .green)
            case .cool: return ("⏸", .orange)
            case .bad: return ("✗", .red)
            }
        }()
        HStack(spacing: 4) {
            Text(sym).bold().foregroundStyle(color)
            Text(model).foregroundStyle(state == .bad ? .secondary : .primary)
        }
        .font(.callout)
        .padding(.horizontal, 7).padding(.vertical, 2)
        .background(Capsule().fill(color.opacity(0.10)))
        .overlay(Capsule().strokeBorder(color.opacity(0.40)))
        .fixedSize()
        .help(why.isEmpty ? model : "\(model): \(why)")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(why.isEmpty ? model : "\(model): \(why)")
    }
}

// MARK: - Models

struct ModelsPage: View {
    @ObservedObject var store: AppStore

    private var rows: [ModelRow] {
        store.d.models
            .filter { $0.offered || store.d.showHidden || $0.reason == "user-off" }
            .sorted { a, b in
                let an = a.reason == "new", bn = b.reason == "new"
                if an != bn { return an }
                if a.service != b.service { return a.service < b.service }
                return a.id < b.id
            }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PageHeader(title: "Models",
                       note: "Ticked models are offered to DeepSeek Harness. New models are found automatically every 3 hours; when the list changes, the DSHProxy routes in DeepSeek Harness are updated (restart DeepSeek Harness to see them).") {
                Toggle("Show hidden models", isOn: $store.d.showHidden).toggleStyle(.checkbox)
                Button(store.checkingModels ? "Checking for new models..." : "Check for new models") { store.checkModels() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!store.running || store.checkingModels)
            }
            if !store.running {
                GatewayStatePanel(store: store, what: "Models")
                Spacer(minLength: 0)
            } else {
                if let s = store.d.suggestion, !store.suggestionLanes().isEmpty { suggestion(s) }
                Text(checkedText).font(.callout).foregroundStyle(.secondary)
                if rows.isEmpty {
                    StatePanel(symbol: "cube", title: "No models yet",
                               text: "Sign in to an account or add an API key; its models appear here. Press “Check for new models” to look now.")
                    Spacer(minLength: 0)
                } else {
                    table
                }
            }
        }
        .pagePadding()
    }

    private var checkedText: String {
        guard let m = store.d.modelsChecked else { return "Not checked yet." }
        return m == 0 ? "Last checked just now." : "Last checked \(m) min ago."
    }

    private func suggestion(_ s: Suggestion) -> some View {
        HStack(spacing: 10) {
            Chip(text: "Newer version", color: .teal)
            (Text(s.to).bold() + Text(" could replace \(s.from) on lane \(store.suggestionLanes().joined(separator: ", ")).")).font(.callout)
            Spacer(minLength: 8)
            Button("Use \(s.to)") { if let a = store.suggestionAlert() { store.presentAlert(a) } }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.teal.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.teal.opacity(0.35)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Newer model suggestion")
    }

    private var table: some View {
        Table(rows) {
            TableColumn("Offer") { m in
                Toggle("Offer \(m.id)", isOn: Binding(get: { m.offered }, set: { store.setOffered(m.id, $0) }))
                    .labelsHidden()
                    .toggleStyle(.checkbox)
                    .accessibilityLabel("Offer \(m.id)")
            }
            .width(44)
            TableColumn("Model") { m in
                Text(m.id).fontWeight(m.reason == "new" ? .bold : .regular).foregroundStyle(color(m))
                    .help("\(m.id)  ·  Service: \(serviceLabel(m.service))")
            }
            .width(min: 140, ideal: 160)
            TableColumn("Service") { m in Text(serviceLabel(m.service)).foregroundStyle(.secondary) }
                .width(min: 54, ideal: 64)
            TableColumn("Context") { m in Text(Fmt.tokens(m.ctx)).monospacedDigit().frame(maxWidth: .infinity, alignment: .trailing) }
                .width(min: 46, ideal: 52)
            TableColumn("Output") { m in Text(Fmt.tokens(m.out)).monospacedDigit().frame(maxWidth: .infinity, alignment: .trailing) }
                .width(min: 46, ideal: 52)
            TableColumn("Reasoning") { m in Text(m.reasoning).foregroundStyle(.secondary) }
                .width(min: 70, ideal: 100)
            TableColumn("Status") { m in Text(REASON_TEXT[m.reason] ?? m.reason).foregroundStyle(color(m)) }
                .width(min: 205, ideal: 215)
        }
        .accessibilityLabel("Models")
    }

    private func color(_ m: ModelRow) -> Color {
        if m.reason == "new" && m.offered { return .accentColor }
        return m.offered ? .primary : .secondary
    }
}

// MARK: - DeepSeek Harness

struct HarnessPage: View {
    @ObservedObject var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PageHeader(title: "DeepSeek Harness",
                       note: "Apply to DeepSeek Harness, at the top of the window, writes the DSHProxy routes into every DeepSeek Harness profile and keeps everything else. Preview shows what it would change. Verify checks the profiles back: routes, models, default model and credential. Restart DeepSeek Harness after a change.") {
                Button("Preview changes…") { store.sheet = .output(store.previewSpec()) }
                Button("Verify") { store.verify() }
                DangerButton("Remove from DeepSeek Harness…") { store.presentAlert(store.removeHarnessAlert()) }
                    .disabled(!store.d.profiles.contains { $0.points != "none" })
            }
            if !store.running {
                Banner(symbol: "exclamationmark.triangle",
                       text: "The gateway is \(store.gateway == .starting ? "starting" : "not answering"). Profiles can be read, but they point at a gateway that is not answering until it does.")
            }
            if store.d.profiles.isEmpty {
                StatePanel(symbol: "rectangle.stack.badge.person.crop", title: "No DeepSeek Harness profile found",
                           text: "Open DeepSeek Harness once so it creates its profile, then press Apply to DeepSeek Harness at the top.")
            } else {
                Table(store.d.profiles) {
                    TableColumn("Profile") { p in Text(p.name) }.width(min: 120, ideal: 200)
                    TableColumn("Routes") { p in Text(p.points == "none" ? "—" : "\(p.routes)").monospacedDigit().frame(maxWidth: .infinity, alignment: .trailing) }.width(70)
                    TableColumn("Models") { p in Text(p.points == "none" ? "—" : "\(p.models)").monospacedDigit().frame(maxWidth: .infinity, alignment: .trailing) }.width(70)
                    TableColumn("Points at this gateway") { p in
                        switch p.points {
                        case "yes": Text("Yes").foregroundStyle(.green)
                        case "stale": Text("No: apply again").foregroundStyle(.orange)
                        default: Text("Not applied").foregroundStyle(.secondary)
                        }
                    }
                }
                .frame(height: tableHeight(store.d.profiles.count))
                .accessibilityLabel("DeepSeek Harness profiles")
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { pluginTitle; pluginState; pluginNote; Spacer(minLength: 8); pluginButton }
                VStack(alignment: .leading, spacing: 6) { HStack(spacing: 12) { pluginTitle; pluginState }; pluginNote; pluginButton }
            }
            .card()
            Spacer(minLength: 0)
        }
        .pagePadding()
    }

    private var pluginTitle: some View { Text("Video tools (plugin)").bold() }
    private var pluginState: some View { Text(store.d.videoTools.text).foregroundStyle(store.d.videoTools.color) }
    private var pluginNote: some View {
        Text("Installed by Apply, together with the chat routes. Details on Video › DeepSeek Harness.")
            .font(.callout).foregroundStyle(.secondary).fixedSize()
    }
    private var pluginButton: some View {
        Button("Open Video › DeepSeek Harness") { store.go(.video, .harness) }
    }
}

// MARK: - Log (shared by both workspaces)

struct LogPage: View {
    @ObservedObject var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PageHeader(title: "Log", note: "Gateway output and what this window did. The gateway also writes dshproxy.log in the data folder.") {
                Button("Show data folder in Finder") { store.showInFinder("~/.dshproxy") }
            }
            ScrollViewReader { proxy in
                ScrollView([.vertical, .horizontal]) {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(store.log) { l in
                            Text("\(l.time)  \(l.text)")
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(color(l.kind))
                                .lineLimit(1)
                                .fixedSize()
                                .id(l.id)
                        }
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                }
                .background(Color(nsColor: .textBackgroundColor))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: .separatorColor)))
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .onAppear { if let last = store.log.last { proxy.scrollTo(last.id, anchor: .bottomLeading) } }
                .onChange(of: store.log.count) { _ in if let last = store.log.last { proxy.scrollTo(last.id, anchor: .bottomLeading) } }
                .accessibilityLabel("Log")
            }
        }
        .pagePadding()
    }

    private func color(_ k: LogLine.Kind) -> Color {
        switch k {
        case .plain: return .primary
        case .action: return .accentColor
        case .warn: return .orange
        case .error: return .red
        }
    }
}
