// Video workspace pages: Accounts (Krea), API keys, Lanes (billing route per model), Models, DeepSeek
// Harness. Nothing is generated or charged; every save is a setting (`video settings set`).

import DSHProxyKit
import SwiftUI

struct CompanyCell: View {
    let model: String
    var body: some View {
        let company = VideoSettings.company(model)
        if company.label.isEmpty { Text("\u{2014}").foregroundStyle(.secondary) }
        else { HStack(spacing: 6) { LogoView(name: company.logo, size: 18); Text(company.label) } }
    }
}

struct RouteCell: View {
    let model: VideoModel
    var body: some View {
        if model.hasRoute {
            Text(VideoSettings.routeLabel(model.route)) + Text(" \u{B7} \(model.route)").foregroundColor(.secondary)
        } else {
            Text(model.routeCell).foregroundStyle(model.routeTone.color)
        }
    }
}

struct BilledCell: View {
    let model: VideoModel
    var body: some View {
        if let units = model.billedIn { Text(units) } else { Text("Choose a billing route").foregroundStyle(.orange) }
    }
}

/// The placeholder of the video lists before the settings are read (A:3341-3404).
struct VideoUnread: View {
    @ObservedObject var store: AppStore
    var body: some View {
        if store.videoBusy {
            StatePanel(symbol: "hourglass", title: "Reading...", text: "The video settings are being read from DSHProxy.", spinner: true)
        } else if store.videoError != nil {
            StatePanel(symbol: "exclamationmark.triangle", title: "Not available", text: store.videoStatus.text) {
                Button("Reload video settings") { Task { await store.loadVideoSettings() } }.padding(.top, 4)
            }
        } else {
            StatePanel(symbol: "film", title: "Not read yet", text: "Press \u{201C}Reload video settings\u{201D}.")
        }
    }
}

// MARK: - Accounts

private struct KreaRow: Identifiable { let id = "krea" }

struct VideoAccountsPage: View {
    @ObservedObject var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PageHeader(title: "Video accounts",
                       note: "Video has one signed-in service, a Krea workspace. Sign in to Krea opens Krea's consent page in your browser; DSHProxy's Krea helper keeps the sign-in, and this window sees only whether one is present and until when. The chat accounts are not used for video.") {
                Button("Sign in to Krea\u{2026}") {}
                    .buttonStyle(.borderedProminent)
                    .disabled(true)
                    .help("Comes in a later version of the macOS app.")
                DangerButton("Sign out\u{2026}") { Task { await store.kreaSignOut() } }
                    .disabled(store.krea?.signedIn != true || store.videoBusy)
                    .accessibilityLabel("Sign out of Krea\u{2026}")
            }
            Table([KreaRow()]) {
                TableColumn("Service") { _ in
                    HStack(spacing: 6) { LogoView(name: "krea", size: 18); Text("Krea workspace") + Text(" \u{B7} krea").foregroundColor(.secondary) }
                }
                .width(min: 190, ideal: 210)
                TableColumn("Billed in") { _ in Text("workspace compute units") }.width(min: 175, ideal: 190)
                TableColumn("Sign-in") { _ in Text("In your browser") }.width(min: 90, ideal: 110)
                TableColumn("State") { _ in Text(store.kreaState).foregroundStyle(store.kreaTone.color) }.width(min: 160, ideal: 270)
            }
            .frame(height: tableHeight(1))
            .accessibilityLabel("Video accounts")
            Banner(symbol: "info.circle",
                   text: "Signing in to Krea from this app comes in a later version. Until then, run node bin/dshproxy-krea.js login in Terminal, in the DSHProxy folder; this page shows the result when it opens.",
                   color: .blue)
            Text(store.kreaReadAt.map { "State read from the Krea helper at \(Format.clock($0)); it is read when this page opens, not kept up to date." } ?? "The state is read from the Krea helper when this page opens.")
                .font(.callout).foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .pagePadding()
    }
}

// MARK: - API keys

struct VideoKeysPage: View {
    @ObservedObject var store: AppStore
    @State private var selection: String?

    private func provider(_ id: String?) -> VideoKeyProvider? { store.videoKeys?.first { $0.id == id } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PageHeader(title: "Video API keys",
                       note: "Save the key of a pay-per-use video provider here. It is stored encrypted in the DSHProxy data folder, like the Chat API keys, and is used by DSHProxy's video command; a key in the provider's environment variable is used instead when that is set. A saved key is not checked against the provider. Video generation from DeepSeek Harness works on the Krea route only for now.")
            if let keys = store.videoKeys {
                Table(keys, selection: $selection) {
                    TableColumn("Provider") { p in Text(p.label) }.width(min: 100, ideal: 120)
                    TableColumn("Environment variable") { p in Text(p.variable).font(.system(.callout, design: .monospaced)) }
                        .width(min: 150, ideal: 180)
                    TableColumn("Billed in") { p in Text(p.units) }.width(min: 80, ideal: 110)
                    TableColumn("State") { p in Text(p.stateText).foregroundStyle(p.stateTone.color) }
                }
                .contextMenu(forSelectionType: String.self) { ids in
                    if let p = provider(ids.first) { Button("Add or replace key\u{2026}") { store.sheet = .videoKey(p) } }
                } primaryAction: { ids in if let p = provider(ids.first), !store.videoBusy { store.sheet = .videoKey(p) } }
                .frame(height: tableHeight(keys.count))
                .accessibilityLabel("Video API keys")
            } else {
                StatePanel(symbol: "key", title: store.videoBusy ? "Reading..." : "Not read yet", text: store.videoKeysStatus?.text ?? "The keys are read when this page opens.")
            }
            HStack(spacing: 8) {
                Button("Add or replace key\u{2026}") { if let p = provider(selection) { store.sheet = .videoKey(p) } }
                    .buttonStyle(.borderedProminent).disabled(provider(selection) == nil || store.videoBusy)
                DangerButton("Remove key\u{2026}") { if let p = provider(selection) { Task { await store.removeVideoKey(p) } } }
                    .disabled(provider(selection).map { !$0.saved } ?? true || store.videoBusy)
            }
            if let status = store.videoKeysStatus, store.videoKeys != nil {
                Text(status.text).font(.callout).foregroundStyle(status.tone.color)
            }
            HStack(spacing: 4) {
                Text("The Krea workspace route uses a sign-in instead of a key: see")
                Button("Accounts") { store.go(.video, .accounts) }.buttonStyle(.link)
                    .accessibilityLabel("Video accounts")
                Text(".")
            }
            .font(.callout).foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .pagePadding()
    }
}

// MARK: - Lanes

struct VideoLanesPage: View {
    @ObservedObject var store: AppStore
    @State private var selection: String?

    var body: some View {
        let enabled = (store.videoModels ?? []).filter(\.enabled)
        VStack(alignment: .leading, spacing: 12) {
            PageHeader(title: "Video lanes",
                       note: "Each enabled model has exactly one billing route. A paid job is never retried automatically, moved to another provider or passed on to another route. A saved route is a setting: it does not prove a sign-in, a key, availability or a price.") {
                Button("Reload video settings") { Task { await store.loadVideoSettings() } }.disabled(store.videoBusy)
            }
            if store.videoModels == nil {
                VideoUnread(store: store)
            } else if enabled.isEmpty {
                StatePanel(symbol: "film", title: store.videoModels!.isEmpty ? "No video models" : "None enabled", text: "Tick a model on the Models tab; its billing route is chosen here.") {
                    Button("Go to Models") { store.go(.video, .models) }.padding(.top, 4)
                }
            } else {
                Table(enabled, selection: $selection) {
                    TableColumn("Model") { m in Text(m.id) }.width(min: 110, ideal: 140)
                    TableColumn("Company") { m in CompanyCell(model: m.id) }.width(min: 90, ideal: 110)
                    TableColumn("Billing route") { m in RouteCell(model: m) }.width(min: 150, ideal: 210)
                    TableColumn("Billed in") { m in BilledCell(model: m) }.width(min: 170, ideal: 200)
                }
                .contextMenu(forSelectionType: String.self) { ids in
                    if let m = enabled.first(where: { $0.id == ids.first }) { Button("Change billing route\u{2026}") { Task { await store.chooseRoute(m, enable: m.enabled) } } }
                } primaryAction: { ids in if let m = enabled.first(where: { $0.id == ids.first }) { Task { await store.chooseRoute(m, enable: m.enabled) } } }
                .frame(height: tableHeight(enabled.count))
                .accessibilityLabel("Video lanes")
                Button("Change billing route\u{2026}") {
                    let model = enabled.first { $0.id == selection } ?? (enabled.count == 1 ? enabled[0] : nil)
                    if let model { Task { await store.chooseRoute(model, enable: model.enabled) } }
                    else { Task { await store.inform("Video lanes", "Select a model in the list first.") } }
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.videoBusy)
            }
            Text(store.videoStatus.text + " Logos show the company behind each model, not a model mark.")
                .font(.callout).foregroundStyle(store.videoStatus.tone.color)
            Spacer(minLength: 0)
        }
        .pagePadding()
    }
}

// MARK: - Models

struct VideoModelsPage: View {
    @ObservedObject var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PageHeader(title: "Video models",
                       note: "Ticked models with a billing route are what the separate DeepSeek Harness video bundle may offer; new models start switched off. A tick is a setting only: it checks no sign-in, key, availability or price, it is not a spending limit, and nothing is generated or charged here. Choose the billing route under Lanes.") {
                Button("Reload video settings") { Task { await store.loadVideoSettings() } }.disabled(store.videoBusy)
            }
            if let models = store.videoModels {
                if models.isEmpty {
                    StatePanel(symbol: "film", title: "No video models", text: "DSHProxy lists no video model.")
                } else {
                    Table(models) {
                        TableColumn("On") { m in
                            Toggle("Enable \(m.id)", isOn: Binding(get: { m.enabled }, set: { on in Task { await store.setVideoEnabled(m, on) } }))
                                .labelsHidden().toggleStyle(.checkbox)
                                .disabled(store.videoBusy)
                                .accessibilityLabel("Enable \(m.id)")
                        }
                        .width(34)
                        TableColumn("Model") { m in Text(m.id) }.width(min: 110, ideal: 130)
                        TableColumn("Company") { m in CompanyCell(model: m.id) }.width(min: 90, ideal: 100)
                        TableColumn("Billing route") { m in RouteCell(model: m) }.width(min: 130, ideal: 180)
                        TableColumn("Billed in") { m in
                            if m.route.isEmpty { Text("\u{2014}").foregroundStyle(.secondary) } else { BilledCell(model: m) }
                        }
                        .width(min: 90, ideal: 170)
                        TableColumn("State") { m in
                            if !m.enabled { Text("Off").foregroundStyle(.secondary) }
                            else if m.hasRoute { Text("Enabled").foregroundStyle(.green) }
                            else { Text("No valid route").foregroundStyle(.orange) }
                        }
                        .width(min: 110, ideal: 120)
                    }
                    .frame(height: tableHeight(models.count))
                    .accessibilityLabel("Video models")
                }
            } else {
                VideoUnread(store: store)
            }
            Text(store.videoStatus.text + " Logos show the company behind each model, not a model mark.")
                .font(.callout).foregroundStyle(store.videoStatus.tone.color)
            Spacer(minLength: 0)
        }
        .pagePadding()
    }
}

// MARK: - DeepSeek Harness

private struct WhatRow: Identifiable { let id: String; let state: String; let color: Color }

struct VideoHarnessPage: View {
    @ObservedObject var store: AppStore

    var body: some View {
        let models = store.videoModels
        let enabled = (models ?? []).filter(\.enabled)
        let good = enabled.filter(\.hasRoute).map(\.id), bad = enabled.filter { !$0.hasRoute }.map(\.id)
        let unread: String? = models != nil ? nil : store.videoError != nil ? "Not available" : "Not read yet"
        let found = store.videoToolsFound
        let rows = [
            WhatRow(id: "Video tools installed in DeepSeek Harness?", state: store.harnessSetup?.rowText ?? "Reading...", color: store.harnessSetup?.rowTone.color ?? .secondary),
            WhatRow(id: "Enabled, with a billing route", state: unread ?? (good.isEmpty ? "None" : good.joined(separator: ", ")), color: unread == nil && !good.isEmpty ? .primary : .secondary),
            WhatRow(id: "Enabled, no valid route (not offered)", state: unread ?? (bad.isEmpty ? "None" : bad.joined(separator: ", ")), color: unread == nil && !bad.isEmpty ? .orange : .secondary),
            WhatRow(id: "Video tools in this DSHProxy folder", state: (found ? "Found: " : "Not found: ") + "integrations/dsh-video", color: found ? .secondary : .orange),
        ]
        VStack(alignment: .leading, spacing: 12) {
            PageHeader(title: "Video in DeepSeek Harness",
                       note: "Video reaches DeepSeek Harness through the video tools, a plugin in integrations/dsh-video of the DSHProxy folder. Apply to DeepSeek Harness, at the top of the window, installs it in the DeepSeek Harness desktop app, together with the Chat routes.")
            Table(rows) {
                TableColumn("What") { r in Text(r.id) }.width(min: 220, ideal: 320)
                TableColumn("State") { r in Text(r.state).foregroundStyle(r.color) }
            }
            .frame(height: tableHeight(rows.count))
            .accessibilityLabel("Video in DeepSeek Harness")
            if let setup = store.harnessSetup, let at = store.harnessReadAt {
                Text("Checked at \(Format.clock(at)). " + setup.pageLine).font(.callout).foregroundStyle(setup.rowTone == .ok ? Color.secondary : setup.rowTone.color)
                    .textSelection(.enabled)
            } else {
                Text("Reading whether the video tools are installed in DeepSeek Harness...").font(.callout).foregroundStyle(.secondary)
            }
            Text("The video tools offer the enabled models above. Their README says what they can do and how far that has been checked.")
                .font(.callout).foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .pagePadding()
    }
}
