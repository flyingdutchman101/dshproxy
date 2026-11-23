// Video workspace pages: Accounts (Krea), API keys, Lanes (billing route per model), Models,
// DeepSeek Harness. Nothing is generated or charged; every save is a fake setting.

import SwiftUI

struct CompanyCell: View {
    let id: String
    var body: some View {
        let c = COMPANIES[id]!
        HStack(spacing: 6) { Badge(letters: c.letters, hue: c.hue, size: 18); Text(c.label) }
    }
}

struct RouteCell: View {
    let model: VModel
    var body: some View {
        if let r = model.route {
            if model.allowed.contains(r) {
                Text(VROUTES[r]!.label) + Text(" · \(r)").foregroundColor(.secondary)
            } else {
                Text("Not allowed: \(r)").foregroundStyle(.red)
            }
        } else {
            Text("Not configured").foregroundStyle(.orange)
        }
    }
}

struct BilledCell: View {
    let model: VModel
    var body: some View {
        if model.validRoute, let r = model.route { Text(VROUTES[r]!.units) }
        else { Text("Choose a billing route").foregroundStyle(.orange) }
    }
}

// MARK: - Accounts

private struct KreaRow: Identifiable { let id = "krea" }

struct VideoAccountsPage: View {
    @ObservedObject var store: AppStore

    var body: some View {
        let k = store.d.krea
        VStack(alignment: .leading, spacing: 12) {
            PageHeader(title: "Video accounts",
                       note: "Video has one signed-in service, a Krea workspace. Sign in to Krea opens Krea's consent page in your browser; DSHProxy's Krea helper keeps the sign-in, and this window sees only whether one is present and until when. The chat accounts are not used for video.") {
                Button("Sign in to Krea…") { store.kreaSignIn() }
                    .buttonStyle(.borderedProminent)
                    .disabled(k == .signing)
                Button("Cancel") { store.kreaCancel() }
                    .disabled(k != .signing)
                    .accessibilityLabel("Cancel Krea sign-in")
                DangerButton("Sign out…") { store.presentAlert(store.kreaSignOutAlert()) }
                    .disabled({ if case .signedIn = k { return false }; return true }())
                    .accessibilityLabel("Sign out of Krea…")
            }
            Table([KreaRow()]) {
                TableColumn("Service") { _ in
                    HStack(spacing: 6) { Badge(letters: "Kr", hue: 300, size: 18); Text("Krea workspace") + Text(" · krea").foregroundColor(.secondary) }
                }
                .width(min: 190, ideal: 210)
                TableColumn("Billed in") { _ in Text("workspace compute units") }.width(min: 175, ideal: 190)
                TableColumn("Sign-in") { _ in Text("In your browser") }.width(min: 90, ideal: 110)
                TableColumn("State") { _ in stateText(k) }.width(min: 160, ideal: 270)
            }
            .frame(height: tableHeight(1))
            .accessibilityLabel("Video accounts")

            if k == .signing {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Your browser opened Krea's consent page.").bold()
                    Text("Approve access there. This page updates by itself; the helper gives up after 4 minutes.").foregroundStyle(.secondary)
                    ProgressView().progressViewStyle(.linear).accessibilityLabel("Waiting for Krea")
                    HStack(spacing: 8) {
                        Text("Prototype only:").font(.callout).foregroundStyle(.secondary)
                        Button("Simulate: approved in browser") { store.kreaFinish(true) }
                        Button("Simulate: refused") { store.kreaFinish(false) }
                    }
                }
                .card()
            }
            Text("State read from the Krea helper at \(Fmt.hms(store.d.vRead)); it is read when this page opens, not kept up to date.")
                .font(.callout).foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .pagePadding()
    }

    @ViewBuilder private func stateText(_ k: KreaState) -> some View {
        switch k {
        case .signedIn(let until): Text("Signed in · until \(Fmt.until(until))").foregroundStyle(.green)
        case .signing: Text("Signing in...").foregroundStyle(.orange)
        case .none: Text("Not signed in").foregroundStyle(.secondary)
        }
    }
}

// MARK: - API keys

struct VideoKeysPage: View {
    @ObservedObject var store: AppStore
    @State private var selection: String? = "videorouter"

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PageHeader(title: "Video API keys",
                       note: "Save the key of a pay-per-use video provider here. It is stored encrypted in the DSHProxy data folder, like the Chat API keys; a key in the provider's environment variable is used instead when that is set. A saved key is not checked against the provider.")
            Table(VKEY_PROVIDERS, selection: $selection) {
                TableColumn("Provider") { p in HStack(spacing: 6) { Badge(letters: p.letters, hue: p.hue, size: 18); Text(p.label) } }
                    .width(min: 100, ideal: 120)
                TableColumn("Environment variable") { p in Text(p.variable).font(.system(.callout, design: .monospaced)) }
                    .width(min: 150, ideal: 180)
                TableColumn("Billed in") { p in Text(VROUTES[p.id]!.units) }.width(min: 80, ideal: 110)
                TableColumn("State") { p in stateText(store.d.vkeys[p.id]!) }
            }
            .contextMenu(forSelectionType: String.self) { ids in
                if let id = ids.first { Button("Add or replace key…") { store.sheet = .videoKey(id) } }
            } primaryAction: { ids in if let id = ids.first { store.sheet = .videoKey(id) } }
            .frame(height: tableHeight(VKEY_PROVIDERS.count))
            .accessibilityLabel("Video API keys")

            HStack(spacing: 8) {
                Button("Add or replace key…") { if let s = selection { store.sheet = .videoKey(s) } }
                    .buttonStyle(.borderedProminent).disabled(selection == nil)
                DangerButton("Remove key…") { if let s = selection { store.presentAlert(store.removeVideoKeyAlert(s)) } }
                    .disabled(selection == nil || store.d.vkeys[selection ?? ""]?.state == KeyState.none)
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

    private func stateText(_ k: VKey) -> some View {
        let base: Text
        switch k.state {
        case .saved: base = Text("Saved")
        case .unreadable: base = Text("Saved, cannot be read: enter it again").foregroundColor(.orange)
        case .none: base = Text("Not saved").foregroundColor(.secondary)
        }
        return k.env ? base + Text(" · also set in the environment").foregroundColor(.secondary) : base
    }
}

// MARK: - Lanes

struct VideoLanesPage: View {
    @ObservedObject var store: AppStore
    @State private var selection: String? = "minimax-h3"

    var body: some View {
        let enabled = store.d.vmodels.filter(\.enabled)
        VStack(alignment: .leading, spacing: 12) {
            PageHeader(title: "Video lanes",
                       note: "Each enabled model has exactly one billing route. A paid job is never retried automatically, moved to another provider or passed on to another route. A saved route is a setting: it does not prove a sign-in, a key, availability or a price.") {
                Button("Reload video settings") { store.reloadVideo() }
            }
            if enabled.isEmpty {
                StatePanel(symbol: "film", title: "None enabled", text: "Tick a model on the Models tab; its billing route is chosen here.") {
                    Button("Go to Models") { store.go(.video, .models) }.padding(.top, 4)
                }
            } else {
                Table(enabled, selection: $selection) {
                    TableColumn("Model") { m in Text(m.id) }.width(min: 110, ideal: 140)
                    TableColumn("Company") { m in CompanyCell(id: m.company) }.width(min: 90, ideal: 110)
                    TableColumn("Billing route") { m in RouteCell(model: m) }.width(min: 150, ideal: 210)
                    TableColumn("Billed in") { m in BilledCell(model: m) }.width(min: 170, ideal: 200)
                }
                .contextMenu(forSelectionType: String.self) { ids in
                    if let id = ids.first { Button("Change billing route…") { store.sheet = .route(id, enableAfter: false) } }
                } primaryAction: { ids in if let id = ids.first { store.sheet = .route(id, enableAfter: false) } }
                .frame(height: tableHeight(enabled.count))
                .accessibilityLabel("Video lanes")
                Button("Change billing route…") { if let s = selection { store.sheet = .route(s, enableAfter: false) } }
                    .buttonStyle(.borderedProminent)
                    .disabled(selection == nil || !enabled.contains { $0.id == selection })
            }
            Text("\(store.videoStatusLine) Letter badges show the company behind each model, not a model mark.")
                .font(.callout).foregroundStyle(.secondary)
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
                       note: "Ticked models with a billing route are what the DeepSeek Harness video tools may offer; new models start switched off. A tick is a setting only: it checks no sign-in, key, availability or price, it is not a spending limit, and nothing is generated or charged here.") {
                Button("Reload video settings") { store.reloadVideo() }
            }
            Table(store.d.vmodels) {
                TableColumn("On") { m in
                    Toggle("Enable \(m.id)", isOn: Binding(get: { m.enabled }, set: { store.setVideoEnabled(m.id, $0) }))
                        .labelsHidden().toggleStyle(.checkbox)
                        .accessibilityLabel("Enable \(m.id)")
                }
                .width(34)
                TableColumn("Model") { m in Text(m.id) }.width(min: 110, ideal: 130)
                TableColumn("Company") { m in CompanyCell(id: m.company) }.width(min: 90, ideal: 100)
                TableColumn("Billing route") { m in RouteCell(model: m) }.width(min: 130, ideal: 180)
                TableColumn("Billed in") { m in
                    if m.route == nil { Text("—").foregroundStyle(.secondary) } else { BilledCell(model: m) }
                }
                .width(min: 90, ideal: 150)
                TableColumn("State") { m in
                    if !m.enabled { Text("Off").foregroundStyle(.secondary) }
                    else if m.validRoute { Text("Enabled").foregroundStyle(.green) }
                    else { Text("No valid route").foregroundStyle(.orange) }
                }
                .width(min: 110, ideal: 120)
            }
            .frame(height: tableHeight(store.d.vmodels.count))
            .accessibilityLabel("Video models")
            Text("\(store.videoStatusLine) Choose the billing route under Lanes.")
                .font(.callout).foregroundStyle(.secondary)
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
        let en = store.d.vmodels.filter(\.enabled)
        let good = en.filter(\.validRoute).map(\.id), bad = en.filter { !$0.validRoute }.map(\.id)
        let rows = [
            WhatRow(id: "Video tools installed in DeepSeek Harness?", state: store.d.videoTools.text, color: store.d.videoTools.color),
            WhatRow(id: "Enabled, with a billing route", state: good.isEmpty ? "None" : good.joined(separator: ", "), color: good.isEmpty ? .secondary : .primary),
            WhatRow(id: "Enabled, no valid route (not offered)", state: bad.isEmpty ? "None" : bad.joined(separator: ", "), color: bad.isEmpty ? .secondary : .orange),
            WhatRow(id: "Video tools in this DSHProxy folder", state: "Found: integrations/dsh-video", color: .green),
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
            Text("Checked at \(Fmt.hms(store.harnessChecked)). The video tools offer the enabled models above. Their README says what they can do and how far that has been checked.")
                .font(.callout).foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .pagePadding()
    }
}
