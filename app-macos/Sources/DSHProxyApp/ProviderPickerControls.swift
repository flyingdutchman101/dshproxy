import SwiftUI
import DSHProxyKit

/// These CLI commands only read/write local picker preferences; never generate media.
struct ProviderPickerControls: View {
    @ObservedObject var store: AppStore
    let voice: Bool
    @State private var entries: [ProviderPickerEntry] = []
    @State private var foreplay = false
    @State private var tools = false
    @State private var loaded = false
    @State private var busy = false
    @State private var message = ""

    var body: some View {
        GroupBox("DeepSeek Harness picker") {
            VStack(alignment: .leading, spacing: 10) {
                if voice {
                    ForEach(entries) { entry in
                        Toggle(entry.name, isOn: Binding(get: { entry.enabled }, set: { enabled in
                            Task { await update(["voice", entry.id, enabled ? "on" : "off"]) }
                        }))
                    }
                    if loaded && entries.isEmpty { Text("No supported TTS picker entries available.") }
                } else {
                    Toggle("Foreplay picker entry", isOn: Binding(get: { foreplay }, set: { enabled in
                        Task { await update(["foreplay", enabled ? "on" : "off"]) }
                    }))
                    Toggle("Foreplay tools in any chat", isOn: Binding(get: { tools }, set: { enabled in
                        Task { await update(["foreplay-tools", enabled ? "on" : "off"]) }
                    }))
                    Text("Enabling any-chat tools may require a DSH plugin reload.").font(.caption).foregroundStyle(.secondary)
                }
                Text("Switches are local only: no network requests or charges.").font(.caption).foregroundStyle(.secondary)
                if !message.isEmpty { Text(message).font(.callout) }
                HStack {
                    Button("Refresh switches") { Task { await load() } }.disabled(busy || store.isSample)
                    Button("Apply to DeepSeek Harness…") { store.applyToHarness() }.disabled(busy || store.isSample || store.applying)
                }
            }.padding(8)
        }
        .disabled(store.isSample || busy)
        .task { await load() }
    }

    @MainActor private func load() async {
        guard !busy, !store.isSample else { return }
        busy = true
        defer { busy = false }
        await readState()
    }

    @MainActor private func readState() async {
        loaded = false
        if voice {
            guard let result = await store.cli(["provider-picker", "voice", "list"], timeout: 30), result.code == 0,
                  let data = result.stdout.data(using: .utf8), let value = try? JSONDecoder().decode([ProviderPickerEntry].self, from: data) else {
                message = "Could not read picker settings. Refresh to retry."; return
            }
            entries = value
        } else {
            guard let first = await store.cli(["provider-picker", "foreplay", "status"], timeout: 30), first.code == 0,
                  let a = ProviderPickerState.decode(first.stdout),
                  let second = await store.cli(["provider-picker", "foreplay-tools", "status"], timeout: 30), second.code == 0,
                  let b = ProviderPickerState.decode(second.stdout) else {
                message = "Could not read picker settings. Refresh to retry."; return
            }
            foreplay = a.enabled; tools = b.enabled
        }
        loaded = true
    }

    @MainActor private func update(_ arguments: [String]) async {
        guard !busy, loaded, !store.isSample else { return }
        busy = true
        defer { busy = false }
        guard let result = await store.cli(["provider-picker"] + arguments, timeout: 30), result.code == 0 else {
            message = "Could not save the switch. Refresh to check local settings."; await readState(); return
        }
        guard let data = result.stdout.data(using: .utf8) else {
            message = "Switch response was unreadable. Refresh to check local settings."; return
        }
        if voice {
            guard let updated = try? JSONDecoder().decode([ProviderPickerEntry].self, from: data) else {
                message = "Switch response was unreadable. Refresh to check local settings."; return
            }
            entries = updated
        } else {
            guard let updated = ProviderPickerState.decode(result.stdout) else {
                message = "Switch response was unreadable. Refresh to check local settings."; return
            }
            if arguments.first == "foreplay" { foreplay = updated.enabled } else { tools = updated.enabled }
        }
        message = "Saved locally. Apply to DeepSeek Harness to refresh the profile."
    }
}
