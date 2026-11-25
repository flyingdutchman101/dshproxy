// Chat workspace pages: Accounts, API keys, Lanes, Models, DeepSeek Harness, and the shared Log (prototype
// views, filled from the Kit's mapping of `status --json` and `GET limits`).

import DSHProxyKit
import SwiftUI

/// What the gateway-dependent pages show while it is starting or not answering (A:2061-2068).
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
                    Button { store.addAccount() } label: { Label("Add account\u{2026}", systemImage: "plus") }
                        .buttonStyle(.borderedProminent)
                    Button("Refresh limits") { Task { await store.loadLimits(force: true) } }
                        .disabled(!store.isRunning || store.limitsState == .reading)
                    Button("Show credentials in Finder") { store.showInFinder(store.home?.appendingPathComponent("auth")) }
                }
                content
            }
            .padding(20)
        }
    }

    @ViewBuilder private var content: some View {
        if !store.isRunning {
            GatewayStatePanel(store: store, what: "Accounts and limits")
        } else if let limits = store.limits {
            if limits.accounts.isEmpty {
                StatePanel(symbol: "person.crop.circle.badge.plus", title: "No accounts yet",
                           text: "Press \u{201C}Add account\u{2026}\u{201D} to sign in to Claude, ChatGPT, Gemini or Kimi. Your browser opens the provider's own sign-in page; DSHProxy never sees your password.") {
                    Button { store.addAccount() } label: { Label("Add account\u{2026}", systemImage: "plus") }
                        .buttonStyle(.borderedProminent).controlSize(.large).padding(.top, 4)
                }
            } else {
                Text(store.limitsNote).font(.callout).foregroundStyle(.secondary)
                ForEach(limits.accounts) { a in AccountCard(store: store, account: a) }
            }
        } else if case .failed = store.limitsState {
            Text(store.limitsNote).font(.callout).foregroundStyle(.red)
        } else {
            StatePanel(symbol: "hourglass", title: "Reading limits\u{2026}", text: "Accounts and limits are shown when the gateway has answered.", spinner: true)
        }
    }
}

struct AccountCard: View {
    @ObservedObject var store: AppStore
    let account: AccountLimits

    var body: some View {
        let a = account
        VStack(alignment: .leading, spacing: 10) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { identity; chips; Spacer(minLength: 12); buttons }
                VStack(alignment: .leading, spacing: 8) { HStack(spacing: 10) { identity; chips }; buttons }
            }
            if !a.windows.isEmpty {
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 7) {
                    ForEach(a.windows) { LimitRow(window: $0, now: store.now) }
                }
                .padding(.leading, 38)
            }
            if a.resetsAvailable > 0 && !a.disabled { resetStrip }
            if let note = a.note {
                Text(note.text).font(.callout).foregroundStyle(note.isError ? .red : .secondary).padding(.leading, 38)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .card()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(a.label) \(a.account)")
    }

    private var identity: some View {
        HStack(spacing: 10) {
            LogoView(name: account.provider, size: 28)
            VStack(alignment: .leading, spacing: 1) {
                Text(account.label).font(.headline)
                Text(account.account).font(.callout).foregroundStyle(.secondary)
            }
            .fixedSize()
        }
    }

    private var chips: some View {
        HStack(spacing: 6) {
            if !account.planText.isEmpty { Chip(text: account.planText, color: .teal).help(account.plan) }
            if account.showsPrimaryChip { Chip(text: "Primary", color: .green) }
            if account.disabled { Chip(text: "\u{25CF} Paused") } else { Chip(text: "\u{25CF} Active", color: .green) }
        }
    }

    private var buttons: some View {
        let a = account
        return HStack(spacing: 6) {
            switch a.primaryAction {
            case .clear:
                Button("Not primary") { Task { await store.clearPrimary(a) } }
                    .accessibilityLabel("Not primary: let the \(a.label) accounts take turns")
            case .make:
                Button("Make primary") { Task { await store.makePrimary(a) } }
                    .accessibilityLabel("Make \(a.label) \(a.account) primary")
            case .none:
                EmptyView()
            }
            Button(a.disabled ? "Resume" : "Pause") { Task { await store.setPaused(a, !a.disabled) } }
                .accessibilityLabel("\(a.disabled ? "Resume" : "Pause") \(a.label) \(a.account)")
            DangerButton("Sign out\u{2026}") { Task { await store.signOut(a) } }
                .accessibilityLabel("Sign out of \(a.label) \(a.account)\u{2026}")
        }
        .fixedSize()
    }

    private var resetStrip: some View {
        let n = account.resetsAvailable
        return HStack(spacing: 10) {
            Chip(text: n == 1 ? "\u{26A0} 1 limit reset" : "\u{26A0} \(n) limit resets", color: .red)
            Text("Danger zone: spending one cannot be undone.").font(.callout)
            Spacer(minLength: 8)
            Button("Use a reset\u{2026}") { Task { await store.useReset(account) } }
                .buttonStyle(.borderedProminent).tint(.red)
                .accessibilityLabel("Use a limit reset on \(account.label) \(account.account)\u{2026}")
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
    @State private var selection: String?

    private var providers: [KeyProvider] { store.status?.keyProviders ?? [] }
    private func provider(_ id: String?) -> KeyProvider? { providers.first { $0.key == id } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PageHeader(title: "API keys",
                       note: "Pay-per-use API keys. Keys are stored encrypted in the DSHProxy data folder; the key that unlocks them is kept in your macOS Keychain. Restart the gateway after a change.")
            if !store.isRunning {
                Banner(symbol: "exclamationmark.triangle", text: store.gateway == .starting
                       ? "The gateway is starting. Keys can still be saved; the gateway uses them when it starts."
                       : "The gateway is not answering. Keys can still be saved; the gateway uses them when it starts.")
            }
            if providers.isEmpty {
                StatePanel(symbol: "key", title: "Not read yet", text: "The providers are listed once DSHProxy's status has been read.")
                Spacer(minLength: 0)
            } else {
                Table(providers, selection: $selection) {
                    TableColumn("Provider") { p in
                        HStack(spacing: 8) { LogoView(name: p.key, size: 18); Text(p.label) }
                    }
                    TableColumn("Region") { p in
                        if p.regionLabel.isEmpty { Text("\u{2014}").foregroundStyle(.tertiary) } else { Text(p.regionLabel) }
                    }
                    TableColumn("State") { p in Text(p.stateText).foregroundStyle(p.stateTone.color) }
                }
                .contextMenu(forSelectionType: String.self) { ids in
                    if let p = provider(ids.first) {
                        Button("Add or replace key\u{2026}") { store.sheet = .chatKey(p) }
                        if p.state != .notSet { Button("Remove\u{2026}") { Task { await store.removeKey(p) } } }
                    }
                } primaryAction: { ids in if let p = provider(ids.first) { store.sheet = .chatKey(p) } }
                .frame(height: tableHeight(providers.count))
                .accessibilityLabel("API keys")

                HStack(spacing: 8) {
                    Button("Add or replace key\u{2026}") { if let p = provider(selection) { store.sheet = .chatKey(p) } }
                        .buttonStyle(.borderedProminent)
                        .disabled(provider(selection) == nil || store.isSample)
                    DangerButton("Remove\u{2026}") { if let p = provider(selection) { Task { await store.removeKey(p) } } }
                        .disabled(provider(selection).map { $0.state == .notSet } ?? true)
                    Text(provider(selection).map { "Selected: \($0.label). Double-click a row to add or replace its key." } ?? "Select a provider.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
        }
        .pagePadding()
    }
}

// MARK: - Lanes

struct LanesPage: View {
    @ObservedObject var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PageHeader(title: "Lanes",
                       note: "A lane tries each model in order until one answers. Green: can serve. Amber: sitting out after running out of quota. Red: no account or key.") {
                Button("Edit lanes\u{2026}") {
                    if let lanes = store.status?.lanes { store.sheet = .laneEditor(lanes) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!store.isRunning || (store.status?.lanes.isEmpty ?? true))
                .accessibilityLabel("Edit lanes\u{2026}")
                Button("Open settings.json\u{2026}") { Task { await store.editLanes() } }
                    .accessibilityLabel("Open settings.json in TextEdit")
            }
            if !store.isRunning || store.status == nil {
                GatewayStatePanel(store: store, what: "Lanes and their models")
                Spacer(minLength: 0)
            } else if let status = store.status {
                presetBox(status.routing)
                legend
                laneTable(status.lanes)
            }
        }
        .pagePadding()
    }

    private func presetBox(_ routing: Routing) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Text("Routing:").bold()
                Picker("Routing preset", selection: Binding(get: { routing.activeName }, set: { name in
                    if let preset = routing.presets.first(where: { $0.name == name }) { Task { await store.choosePreset(preset) } }
                })) {
                    ForEach(routing.presets) { Text($0.label).tag($0.name).help($0.summary) }
                    if routing.activeName == "custom" { Text("Custom").tag("custom") }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .accessibilityLabel("Routing preset")
            }
            Text(routing.note).font(.callout).foregroundStyle(.secondary)
        }
        .card()
    }

    @ViewBuilder private func laneTable(_ lanes: [Lane]) -> some View {
        if lanes.isEmpty {
            Text("No lanes are defined yet. Open settings.json to add one.")
                .font(.callout).foregroundStyle(.secondary)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lanes.enumerated()), id: \.element.id) { index, lane in
                        if index > 0 { Divider() }
                        LaneRow(lane: lane, now: store.now)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityLabel("Lanes")
        }
    }

    private var legend: some View {
        HStack(spacing: 14) {
            LadderChip(model: "can serve", state: .ok, why: "")
            LadderChip(model: "sitting out", state: .cooling, why: "")
            LadderChip(model: "no account or key", state: .unavailable, why: "")
        }
        .font(.callout)
        .accessibilityHidden(true)
    }
}

struct LaneRow: View {
    let lane: Lane
    let now: Date

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(lane.title)
                .font(.caption.weight(.semibold))
                .lineLimit(2)
                .truncationMode(.middle)
                .frame(width: 78, alignment: .leading)
                .help(lane.title)
            FlowLayout(spacing: 3, lineSpacing: 2) {
                ForEach(Array(lane.rungs.enumerated()), id: \.offset) { i, rung in
                    HStack(spacing: 3) {
                        if i > 0 { Text("\u{203A}").font(.caption2).foregroundStyle(.secondary).accessibilityHidden(true) }
                        LadderChip(model: rung.model, state: rung.state, why: rung.why(now: now))
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(lane.title), first to last")
    }
}

struct LadderChip: View {
    let model: String
    let state: RungState
    let why: String

    var body: some View {
        let (sym, color): (String, Color) = {
            switch state {
            case .ok: return ("\u{2713}", .green)
            case .cooling: return ("\u{23F8}", .orange)
            case .unavailable: return ("\u{2717}", .red)
            }
        }()
        HStack(spacing: 3) {
            Text(sym).bold().foregroundStyle(color)
            Text(model).foregroundStyle(state == .unavailable ? .secondary : .primary)
        }
        .font(.caption)
        .padding(.horizontal, 5).padding(.vertical, 1)
        .background(Capsule().fill(color.opacity(0.10)))
        .overlay(Capsule().strokeBorder(color.opacity(0.40)))
        .fixedSize()
        .help(why.isEmpty ? model : "\(model): \(why)")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(why.isEmpty ? model : "\(model): \(why)")
    }
}

// MARK: - Models

struct ModelServiceCell: View {
    let logo: String?
    let label: String
    var body: some View {
        HStack(spacing: 4) {
            if let logo { LogoView(name: logo, size: 14).accessibilityHidden(true) }
            else { Image(systemName: "network").frame(width: 14).accessibilityHidden(true) }
            Text(label).foregroundStyle(.secondary).lineLimit(1)
        }
    }
}

struct ModelsPage: View {
    @ObservedObject var store: AppStore
    @State private var apiCatalog = false

    private var rows: [ChatModel] { ChatModel.visible(store.status?.models ?? [], showHidden: store.showHidden) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PageHeader(title: "Models",
                       note: apiCatalog ? "Browse models by publisher and API service. Refresh checks OpenRouter’s public catalog; other services use local configuration. Browsing does not enable a route." : "Ticked models are offered to DeepSeek Harness. New models are found automatically every 3 hours; when the list changes, the DSHProxy routes in DeepSeek Harness are updated (restart DeepSeek Harness to see them).") {
                if !apiCatalog {
                Toggle("Show hidden models", isOn: $store.showHidden).toggleStyle(.checkbox)
                Button(store.checkingModels ? "Checking for new models..." : "Check for new models") { Task { await store.checkForModels() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(!store.isRunning || store.checkingModels)
                }
            }
            Picker("Model view", selection: $apiCatalog) {
                Text("Offered models").tag(false)
                Text("API catalog").tag(true)
            }.pickerStyle(.segmented)
            if apiCatalog {
                APICatalogPage(store: store)
            } else if !store.isRunning || store.status == nil {
                GatewayStatePanel(store: store, what: "Models")
                Spacer(minLength: 0)
            } else if let status = store.status {
                ForEach(status.suggestions) { suggestion($0) }
                Text(store.checkingModels ? "Checking for new models..." : status.catalogNote(now: store.now)).font(.callout)
                    .foregroundStyle(status.catalogError == nil ? Color.secondary : Color.red)
                if rows.isEmpty {
                    StatePanel(symbol: "cube", title: "No models yet",
                               text: "Sign in to an account or add an API key; its models appear here. Press \u{201C}Check for new models\u{201D} to look now.")
                    Spacer(minLength: 0)
                } else {
                    table
                }
            }
        }
        .pagePadding()
    }

    private func suggestion(_ s: Suggestion) -> some View {
        HStack(spacing: 10) {
            Chip(text: "Newer version", color: .teal)
            Text(s.text).font(.callout)
            Spacer(minLength: 8)
            Button("Use \(s.to)") { Task { await store.replaceOnLanes(s) } }
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
                Toggle("Offer \(m.id)", isOn: Binding(get: { store.offered(m) }, set: { on in Task { await store.setOffered(m, on) } }))
                    .labelsHidden()
                    .toggleStyle(.checkbox)
                    .accessibilityLabel("Offer \(m.id)")
            }
            .width(44)
            TableColumn("Model") { m in
                Text(m.id).fontWeight(m.highlighted ? .bold : .regular).foregroundStyle(m.tone.color)
                    .help(m.tooltip)
            }
            .width(min: 140, ideal: 160)
            TableColumn("Service") { m in
                ModelServiceCell(logo: m.account, label: m.serviceLabel)
            }
            .width(min: 54, ideal: 90)
            TableColumn("Context") { m in Text(m.contextText).monospacedDigit().frame(maxWidth: .infinity, alignment: .trailing) }
                .width(min: 46, ideal: 52)
            TableColumn("Output") { m in Text(m.outputText).monospacedDigit().frame(maxWidth: .infinity, alignment: .trailing) }
                .width(min: 46, ideal: 52)
            TableColumn("Reasoning") { m in Text(m.reasoningText).foregroundStyle(.secondary) }
                .width(min: 70, ideal: 100)
            TableColumn("Status") { m in Text(m.statusText).foregroundStyle(m.tone.color) }
                .width(min: 205, ideal: 215)
        }
        .accessibilityLabel("Models")
    }
}

// MARK: - DeepSeek Harness

struct HarnessPage: View {
    @ObservedObject var store: AppStore

    var body: some View {
        let profiles = store.status?.profiles ?? []
        VStack(alignment: .leading, spacing: 12) {
            PageHeader(title: "DeepSeek Harness",
                       note: "Apply to DeepSeek Harness, at the top of the window, writes the DSHProxy routes into every DeepSeek Harness profile and keeps everything else. Preview shows what it would change. Verify checks the profiles back: routes, models, default model and credential. Restart DeepSeek Harness after a change.") {
                Button("Preview changes\u{2026}") { Task { await store.previewHarness() } }
                Button("Verify") { Task { await store.verifyHarness() } }
                DangerButton("Remove from DeepSeek Harness\u{2026}") { Task { await store.removeFromHarness() } }
                    .disabled(!profiles.contains { $0.routeCount > 0 })
            }
            .disabled(store.isSample)
            if store.status == nil {
                StatePanel(symbol: "hourglass", title: "Not read yet", text: "The profiles are listed once DSHProxy's status has been read.")
            } else if profiles.isEmpty {
                StatePanel(symbol: "rectangle.stack.badge.person.crop", title: "No DeepSeek Harness profile found",
                           text: "Open DeepSeek Harness once so it creates its profile, then press Apply to DeepSeek Harness at the top.")
            } else {
                Table(profiles) {
                    TableColumn("Profile") { p in Text(p.profile) }.width(min: 120, ideal: 200)
                    TableColumn("Routes") { p in Text("\(p.routeCount)").monospacedDigit().frame(maxWidth: .infinity, alignment: .trailing) }.width(70)
                    TableColumn("Models") { p in Text("\(p.modelCount)").monospacedDigit().frame(maxWidth: .infinity, alignment: .trailing) }.width(70)
                    TableColumn("Points at this gateway") { p in
                        Text(p.pointing).foregroundStyle(p.good ? Color.green : p.error != nil ? Color.red : p.routeCount > 0 ? Color.orange : Color.secondary)
                    }
                }
                .frame(height: tableHeight(profiles.count))
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
    @ViewBuilder private var pluginState: some View {
        if let setup = store.harnessSetup { Text(setup.rowText).foregroundStyle(setup.rowTone.color) } else { Text("Not read yet").foregroundStyle(.secondary) }
    }
    private var pluginNote: some View {
        Text("Installed by Apply, together with the chat routes. Details on Video \u{203A} DeepSeek Harness.")
            .font(.callout).foregroundStyle(.secondary).fixedSize()
    }
    private var pluginButton: some View {
        Button("Open Video \u{203A} DeepSeek Harness") { store.go(.video, .harness) }
    }
}

// MARK: - Log (shared by both workspaces)

struct LogPage: View {
    @ObservedObject var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PageHeader(title: "Log", note: "Gateway output and what this app did. The gateway also writes dshproxy.log in the data folder.") {
                Button("Show data folder in Finder") { store.showInFinder(store.home) }
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
