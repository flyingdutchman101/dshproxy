// The window: header, backend update bar, Chat/Video switch, section tabs, page, footer (prototype layout).
// While the gateway is stopped the window only says so and points to the menu-bar item (the user's decision).

import DSHProxyKit
import SwiftUI

struct RootView: View {
    @ObservedObject var store: AppStore

    var body: some View {
        Group {
            if store.gateway == .stopped && store.statusUnavailable == nil {
                StoppedView(store: store)
            } else {
                GeometryReader { geo in
                    VStack(spacing: 0) {
                        if store.isSample { SampleBanner() }
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
        .sheet(item: $store.sheet, onDismiss: { if store.decision != nil { store.answer(false) } }) { kind in SheetHost(store: store, kind: kind) }
    }
}

/// Render mode only: says the data is made up.
struct SampleBanner: View {
    var body: some View {
        Text("SAMPLE DATA \u{2014} render mode for review; nothing is running or read")
            .font(.caption.weight(.bold)).foregroundStyle(.white)
            .frame(maxWidth: .infinity).padding(.vertical, 3)
            .background(Color.purple)
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
                    if store.statusUnavailable != nil {
                        Chip(text: "Status unavailable", color: .red)
                    } else {
                        Chip(text: "\u{25CF} " + store.gateway.chipText, color: store.gateway.color)
                            .accessibilityLabel("Gateway \(store.gateway.chipText.lowercased())")
                    }
                    if store.foreign {
                        Chip(text: "Not started by this app")
                            .help("This gateway was started elsewhere. Stop it where it was started.")
                    }
                }
                Text(store.detailLine).font(.callout).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.tail)
                    .help(store.detailLine)
                lowest.font(.callout).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                if store.busy > 0 { ProgressView().controlSize(.small).accessibilityLabel("Working") }
                Button(store.applying ? "Applying\u{2026}" : "Apply to DeepSeek Harness") { store.applyToHarness() }
                    .buttonStyle(.borderedProminent)
                    .disabled(store.applying || store.isSample)
                    .help("Writes the DSHProxy routes into every DeepSeek Harness profile and installs the video tools.")
                    .accessibilityHint("Writes the DSHProxy routes into every DeepSeek Harness profile and installs the video tools.")
                Button("Stop") { store.stopRequested() }
                    .disabled(store.gateway == .stopped)
                    .help(store.foreign ? "This gateway was not started by this app." : "Stop the gateway. Start it again from the menu-bar item.")
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
        if let low = store.lowestLimit {
            Text(low.text).foregroundColor(levelColor(low.left))
        } else {
            Text(" ").accessibilityHidden(true)
        }
    }
}

struct UpdateBar: View {
    @ObservedObject var store: AppStore
    @Environment(\.compact) private var compact

    var body: some View {
        if store.isRunning, let status = store.status, let text = status.updateText() {
            let available = status.update?.available == true
            HStack(spacing: 12) {
                Image(systemName: available ? "arrow.down.circle" : "clock.arrow.circlepath")
                    .foregroundStyle(.secondary).accessibilityHidden(true)
                Text(store.updateBusy ? "Downloading and trying CLIProxyAPI \(status.update?.latest ?? "")... this takes up to a minute." : text)
                    .font(.callout).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if store.updateBusy { ProgressView().controlSize(.small) }
                if available {
                    Button("Update\u{2026}") { Task { await store.applyUpdate() } }
                        .disabled(store.updateBusy)
                        .accessibilityLabel("Update CLIProxyAPI\u{2026}")
                }
                if status.previousVersion != nil {
                    Button("Roll back\u{2026}") { Task { await store.rollback() } }
                        .disabled(store.updateBusy)
                        .accessibilityLabel("Roll back CLIProxyAPI\u{2026}")
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
}

// MARK: - Workspace switch and section tabs

struct NavBar: View {
    @ObservedObject var store: AppStore
    @Environment(\.compact) private var compact

    var body: some View {
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

    var body: some View {
        HStack(spacing: 12) {
            Text(store.footer).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                .help(store.footer)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Toggle("Start at login", isOn: Binding(get: { store.startAtLogin }, set: { store.setStartAtLogin($0) }))
                .toggleStyle(.checkbox)
                .disabled(store.isSample)
                .help("Starts DSHProxy in the menu bar, with its gateway, when you log in.")
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
