// The window: header, backend update bar, Chat/Video switch, section tabs, page, footer.
// While the gateway is stopped the window only says so and points to the menu-bar item
// (the user's decision: Start lives in the menu-bar item only).

import SwiftUI

struct RootView: View {
    @ObservedObject var store: AppStore

    var body: some View {
        Group {
            if store.gateway == .stopped {
                StoppedView(store: store)
            } else {
                GeometryReader { geo in
                    VStack(spacing: 0) {
                        HeaderView(store: store)
                        UpdateBar(store: store)
                        NavBar(store: store)
                        Divider()
                        PageView(store: store)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        Divider()
                        FooterView(store: store)
                    }
                    .environment(\.compact, geo.size.height < 700)
                }
            }
        }
        .frame(minWidth: 860, minHeight: 540)
        .overlay(alignment: .bottom) { NoticeView(text: store.notice).padding(.bottom, 44) }
        .sheet(item: $store.sheet) { kind in SheetHost(store: store, kind: kind) }
    }
}

struct PageView: View {
    @ObservedObject var store: AppStore
    var body: some View {
        switch (store.workspace, store.section) {
        case (_, .log): LogPage(store: store)
        case (.chat, .accounts): AccountsPage(store: store)
        case (.chat, .apiKeys): KeysPage(store: store)
        case (.chat, .lanes): LanesPage(store: store)
        case (.chat, .models): ModelsPage(store: store)
        case (.chat, .harness): HarnessPage(store: store)
        case (.video, .accounts): VideoAccountsPage(store: store)
        case (.video, .apiKeys): VideoKeysPage(store: store)
        case (.video, .lanes): VideoLanesPage(store: store)
        case (.video, .models): VideoModelsPage(store: store)
        case (.video, .harness): VideoHarnessPage(store: store)
        }
    }
}

// MARK: - Header

struct HeaderView: View {
    @ObservedObject var store: AppStore
    @Environment(\.compact) private var compact

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            AppMark(size: compact ? 34 : 44)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 10) {
                    Text("DSHProxy").font(.system(size: compact ? 17 : 20, weight: .light))
                        .accessibilityAddTraits(.isHeader)
                    Chip(text: "● " + store.gateway.chipText, color: store.gateway.color)
                        .accessibilityLabel("Gateway \(store.gateway.chipText.lowercased())")
                }
                Text(store.detailLine).font(.callout).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.tail)
                    .help(store.detailLine)
                lowest.font(.callout).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                Button("Apply to DeepSeek Harness") { store.sheet = .apply }
                    .buttonStyle(.borderedProminent)
                    .help("Writes the DSHProxy routes into every DeepSeek Harness profile and installs the video tools.")
                    .accessibilityHint("Writes the DSHProxy routes into every DeepSeek Harness profile and installs the video tools.")
                Button("Stop") { store.stopGateway() }
                    .help("Stop the gateway. Start it again from the menu-bar item.")
                    .accessibilityLabel("Stop gateway")
            }
            .controlSize(compact ? .regular : .large)
            .fixedSize()
        }
        .padding(.horizontal, 20)
        .padding(.top, compact ? 8 : 14)
        .padding(.bottom, compact ? 6 : 10)
    }

    @ViewBuilder private var lowest: some View {
        if let (a, w) = store.lowestLimit, let left = w.left {
            (Text("Lowest limit: ").foregroundColor(.secondary)
             + Text("\(a.service.label) (\(a.email)) \(w.title), \(left)% left").foregroundColor(levelColor(left)))
        } else {
            Text(" ").accessibilityHidden(true)
        }
    }
}

struct UpdateBar: View {
    @ObservedObject var store: AppStore
    @Environment(\.compact) private var compact

    var body: some View {
        let b = store.backend
        if store.running && (b.latest != nil || b.previous != nil) {
            HStack(spacing: 12) {
                Image(systemName: b.latest != nil ? "arrow.down.circle" : "clock.arrow.circlepath")
                    .foregroundStyle(.secondary).accessibilityHidden(true)
                Text(text(b)).font(.callout).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if b.busy { ProgressView().controlSize(.small) }
                if b.latest != nil {
                    Button("Update…") { if let a = store.updateAlert() { store.presentAlert(a) } }
                        .disabled(b.busy)
                        .accessibilityLabel("Update CLIProxyAPI…")
                }
                if b.previous != nil {
                    Button("Roll back…") { if let a = store.rollbackAlert() { store.presentAlert(a) } }
                        .disabled(b.busy)
                        .accessibilityLabel("Roll back CLIProxyAPI…")
                }
            }
            .padding(.horizontal, 12).padding(.vertical, compact ? 4 : 7)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.accentColor.opacity(0.08)))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.accentColor.opacity(0.25)))
            .padding(.horizontal, 20)
            .padding(.bottom, compact ? 6 : 10)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Backend update")
        }
    }

    private func text(_ b: Backend) -> String {
        if b.busy, let l = b.latest { return "Downloading and trying CLIProxyAPI \(l)... this takes up to a minute." }
        if let l = b.latest {
            return "CLIProxyAPI \(l) is available (you run \(b.current)), released \(b.released). Updating tries it first and keeps \(b.current) for rollback."
        }
        return "Running CLIProxyAPI \(b.current). The previous version \(b.previous ?? "") is kept."
    }
}

// MARK: - Workspace switch and section tabs

struct NavBar: View {
    @ObservedObject var store: AppStore
    @Environment(\.compact) private var compact

    var body: some View {
        // One row when the window is wide enough; otherwise the workspace switch and hint
        // on one row and the section tabs below, as in the Windows app.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 14) { workspacePicker; sectionPicker; hint }
            VStack(alignment: .leading, spacing: compact ? 6 : 8) {
                HStack(spacing: 14) { workspacePicker; hint }
                sectionPicker
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.bottom, compact ? 6 : 10)
    }

    private var workspacePicker: some View {
        Picker("Workspace", selection: Binding(get: { store.workspace }, set: { store.go($0, store.section) })) {
            ForEach(Workspace.allCases) { Text($0.title).tag($0) }
        }
        .pickerStyle(.segmented)
        .fixedSize()
        .accessibilityLabel("Workspace")
    }

    private var sectionPicker: some View {
        Picker("Section", selection: Binding(get: { store.section }, set: { store.go(store.workspace, $0) })) {
            ForEach(Section.allCases) { Text($0.title).tag($0) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
        .accessibilityLabel("\(store.workspace.title) sections")
    }

    private var hint: some View {
        Text(store.section == .log ? "The log is shared by the Chat and Video workspaces." : store.workspace.hint)
            .font(.callout).foregroundStyle(.secondary).lineLimit(1).fixedSize()
    }
}

// MARK: - Footer

struct FooterView: View {
    @ObservedObject var store: AppStore
    private let paths = "Data: ~/.dshproxy    Program: /Applications/DSHProxy.app    Build: 2026-11-23 23:00 prototype"

    var body: some View {
        HStack(spacing: 12) {
            Text(paths).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                .help(paths)
                .frame(maxWidth: .infinity, alignment: .leading)
            Toggle("Start at login", isOn: Binding(get: { store.loginItem }, set: { store.setLoginItem($0) }))
                .toggleStyle(.checkbox)
                .help("Prototype: only flips a flag. No login item is registered.")
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
    }
}

// MARK: - Stopped

struct StoppedView: View {
    @ObservedObject var store: AppStore

    var body: some View {
        VStack(spacing: 14) {
            ZStack(alignment: .bottomTrailing) {
                AppMark(size: 64).saturation(0.2).opacity(0.75)
                Image(systemName: "stop.circle.fill").font(.system(size: 22)).foregroundStyle(.white, .red)
                    .offset(x: 6, y: 6).accessibilityHidden(true)
            }
            Text("The gateway is stopped").font(.title2.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
            Text("DSHProxy serves nothing while it is stopped, so there is nothing to show here. Start it from the DSHProxy item in the menu bar, at the top right of the screen: choose Start gateway.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 460)
            MenuBarHint()
                .padding(.top, 6)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// A small drawing of where to look: the menu-bar item with its menu's Start entry.
struct MenuBarHint: View {
    var body: some View {
        HStack(spacing: 8) {
            Image(nsImage: StatusIcon.image(for: .stopped, size: 18))
                .renderingMode(.template)
                .foregroundStyle(.primary)
            Image(systemName: "arrow.right").foregroundStyle(.secondary)
            Text("Start gateway").padding(.horizontal, 8).padding(.vertical, 3)
                .background(RoundedRectangle(cornerRadius: 5).fill(Color.accentColor))
                .foregroundStyle(.white)
        }
        .font(.callout)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 8).fill(.quaternary.opacity(0.6)))
        .accessibilityHidden(true)
    }
}

struct NoticeView: View {
    let text: String?
    var body: some View {
        if let t = text {
            Text(t)
                .font(.callout)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(Color(nsColor: .separatorColor)))
                .shadow(radius: 6, y: 2)
                .accessibilityAddTraits(.updatesFrequently)
        }
    }
}
