// Lane editor: one lane at a time, through POST lanes/set (name, previousName when renamed, models).
// The gateway refuses an empty ladder, a duplicate model, a name that is not a lane ID, a name already
// used and a model it does not know; its one-sentence error is shown as it came back.

import AppKit
import DSHProxyKit
import SwiftUI

struct LaneEditorSheet: View {
    @ObservedObject var store: AppStore
    /// The lanes as the status had them when the sheet opened; the picker chooses one to edit.
    let lanes: [Lane]

    @State private var selected: String
    @State private var name: String
    @State private var ladder: [String]
    @State private var adding = ""
    @State private var routeError: String?
    @State private var saving = false

    init(store: AppStore, lanes: [Lane]) {
        self.store = store
        self.lanes = lanes
        let first = lanes.first
        _selected = State(initialValue: first?.name ?? "")
        _name = State(initialValue: first?.name ?? "")
        _ladder = State(initialValue: first?.rungs.map(\.model) ?? [])
    }

    private var lane: Lane? { lanes.first { $0.name == selected } }
    private var originalName: String { lane?.name ?? selected }

    /// The same rule as POST lanes/set: ^[a-z][a-z0-9-]{0,31}$.
    private var nameProblem: String? {
        if name.range(of: #"^[a-z][a-z0-9-]{0,31}$"#, options: .regularExpression) == nil {
            return "A lane name is lowercase letters, digits and dashes, starting with a letter, at most 32 characters."
        }
        if name != originalName, lanes.contains(where: { $0.name == name }) {
            return "There is already a lane called \(name)."
        }
        return nil
    }

    private var ladderProblem: String? {
        if ladder.isEmpty { return "A lane needs at least one model." }
        if Set(ladder).count != ladder.count { return "A model cannot appear twice on one lane." }
        return nil
    }

    private var canSave: Bool { lane != nil && nameProblem == nil && ladderProblem == nil && !saving }

    /// Every model the status lists, without the lanes the gateway offers under lane-*.
    private var knownModels: [String] {
        var seen = Set<String>()
        return (store.status?.models ?? []).map(\.id).filter { id in
            !id.isEmpty && !id.hasPrefix("lane-") && seen.insert(id).inserted
        }
    }

    private var ladderHeight: CGFloat {
        min(max(CGFloat(max(ladder.count, 1)) * 30 + 10, 48), 240)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                SheetTitle(title: "Edit a lane", symbol: "arrow.up.arrow.down")
                Spacer(minLength: 8)
                lanePicker
            }
            nameRow
            Text("The gateway tries the ladder from the top: the first model that can serve answers. Moving or removing a model changes that order.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            ladderList
            if let problem = ladderProblem {
                Text(problem).font(.caption).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("Ladder problem: \(problem)")
            }
            addRow
            if let message = routeError {
                Label(message, systemImage: "exclamationmark.circle.fill")
                    .font(.callout).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("Error: \(message)")
            }
            Divider()
            HStack(spacing: 8) {
                Spacer()
                Button("Cancel") { store.sheet = nil }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityLabel("Cancel editing the lane")
                Button("Save") { save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSave)
                    .accessibilityLabel("Save the lane")
            }
        }
        .padding(22)
        .frame(width: 620)
        .onChange(of: selected) { _ in loadSelected() }
    }

    private var lanePicker: some View {
        HStack(spacing: 6) {
            Text("Lane:").font(.callout)
            Picker("Lane to edit", selection: $selected) {
                ForEach(lanes) { lane in Text(lane.title).tag(lane.name) }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .fixedSize()
            .accessibilityLabel("Lane to edit")
        }
    }

    private var nameRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("Name:").font(.callout)
                Text("lane-").font(.callout).foregroundStyle(.secondary).accessibilityHidden(true)
                TextField("main", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 220)
                    .onSubmit { if canSave { save() } }
                    .accessibilityLabel("Lane name, without the lane- prefix")
                    .accessibilityHint("Lowercase letters, digits and dashes, starting with a letter, at most 32 characters.")
                if saving { ProgressView().controlSize(.small).accessibilityLabel("Saving the lane") }
                Spacer(minLength: 0)
            }
            if let problem = nameProblem {
                Text(problem).font(.caption).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("Name problem: \(problem)")
            }
        }
    }

    private var ladderList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if ladder.isEmpty {
                    Text("No models on this ladder. Add one below; a lane needs at least one.")
                        .font(.callout).foregroundStyle(.secondary)
                        .padding(10)
                        .accessibilityLabel("No models on this ladder")
                } else {
                    ForEach(Array(ladder.enumerated()), id: \.offset) { index, model in
                        if index > 0 { Divider() }
                        modelRow(index, model)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(height: ladderHeight)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .textBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(nsColor: .separatorColor)))
        .accessibilityLabel("Ladder, first to last")
    }

    private func modelRow(_ index: Int, _ model: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(index + 1).")
                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                .frame(width: 20, alignment: .trailing)
                .accessibilityHidden(true)
            Text(model)
                .font(.system(size: 12, design: .monospaced))
                .fixedSize(horizontal: false, vertical: true)
                .help(model)
            Spacer(minLength: 8)
            Button { move(index, -1) } label: { Image(systemName: "arrow.up") }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .disabled(index == 0)
                .help("Move \(model) up")
                .accessibilityLabel("Move \(model) up")
            Button { move(index, 1) } label: { Image(systemName: "arrow.down") }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .disabled(index == ladder.count - 1)
                .help("Move \(model) down")
                .accessibilityLabel("Move \(model) down")
            Button { remove(index) } label: { Image(systemName: "minus.circle").foregroundStyle(.red) }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .help("Remove \(model)")
                .accessibilityLabel("Remove \(model)")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(index + 1). \(model)")
    }

    private var addRow: some View {
        HStack(spacing: 8) {
            AddModelPicker(models: knownModels, onLadder: Set(ladder), selection: $adding)
                .fixedSize()
                .onChange(of: adding) { id in add(id) }
            if knownModels.isEmpty {
                Text("No models the gateway knows are listed yet.").font(.caption).foregroundStyle(.secondary)
            } else {
                Text("Models already on the ladder are disabled.").font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
    }

    private func add(_ id: String) {
        guard !id.isEmpty else { return }
        adding = ""
        guard !ladder.contains(id) else { return }
        ladder.append(id)
        routeError = nil
    }

    private func move(_ index: Int, _ delta: Int) {
        let target = index + delta
        guard ladder.indices.contains(index), ladder.indices.contains(target) else { return }
        ladder.swapAt(index, target)
        routeError = nil
    }

    private func remove(_ index: Int) {
        guard ladder.indices.contains(index) else { return }
        ladder.remove(at: index)
        routeError = nil
    }

    private func loadSelected() {
        guard let lane else { return }
        name = lane.name
        ladder = lane.rungs.map(\.model)
        adding = ""
        routeError = nil
    }

    private func save() {
        guard canSave, let lane else { return }
        saving = true
        routeError = nil
        let newName = name
        let newLadder = ladder
        let previous = lane.name
        var body: [String: Any] = ["name": newName, "models": newLadder]
        if newName != previous { body["previousName"] = previous }
        Task {
            switch await store.call("POST", "lanes/set", body: body) {
            case .failure(let message):
                routeError = message
                saving = false
            case .success(let answer):
                let savedName = answer["name"] as? String ?? newName
                let savedModels = (answer["models"] as? [String]) ?? newLadder
                let harnessChanged = answer["harnessChanged"] as? Bool == true
                let change = savedName == previous
                    ? "Lane \(savedName)"
                    : "Lane \(previous) renamed to \(savedName)"
                store.addLog(change + ": " + savedModels.joined(separator: " \u{203A} ") + "."
                             + (harnessChanged ? " DeepSeek Harness routes updated. Restart DeepSeek Harness to see them." : ""), .action)
                store.sheet = nil
                store.refreshStatus()
            }
        }
    }
}

/// The Add model menu as a real NSPopUpButton: SwiftUI's menu Picker draws its items enabled
/// whatever `.disabled` says, while here a model already on the ladder truly cannot be chosen.
private struct AddModelPicker: NSViewRepresentable {
    let models: [String]
    let onLadder: Set<String>
    @Binding var selection: String

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSPopUpButton {
        let button = NSPopUpButton(frame: .zero, pullsDown: false)
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        button.target = context.coordinator
        button.action = #selector(Coordinator.picked(_:))
        button.setAccessibilityLabel("Add model")
        button.setAccessibilityHelp("Models already on the ladder are disabled.")
        context.coordinator.rebuild(button)
        return button
    }

    func updateNSView(_ button: NSPopUpButton, context: Context) {
        context.coordinator.parent = self
        context.coordinator.rebuild(button)
    }

    final class Coordinator: NSObject {
        var parent: AddModelPicker
        private var shown: [String] = []

        init(_ parent: AddModelPicker) { self.parent = parent }

        @objc func picked(_ sender: NSPopUpButton) {
            parent.selection = sender.selectedItem?.representedObject as? String ?? ""
        }

        func rebuild(_ button: NSPopUpButton) {
            let signature = parent.models.map { $0 + (parent.onLadder.contains($0) ? "|1" : "|0") }
            if signature != shown {
                shown = signature
                button.removeAllItems()
                button.addItem(withTitle: "Add model\u{2026}")
                button.lastItem?.representedObject = ""
                for model in parent.models {
                    button.addItem(withTitle: model)
                    button.lastItem?.representedObject = model
                    button.lastItem?.isEnabled = !parent.onLadder.contains(model)
                }
                // The menu would otherwise enable every item that has a target.
                button.menu?.autoenablesItems = false
            }
            button.isEnabled = !parent.models.isEmpty
            if let index = button.itemArray.firstIndex(where: { ($0.representedObject as? String) == parent.selection }) {
                button.selectItem(at: index)
            } else {
                button.selectItem(at: 0)
            }
        }
    }
}
