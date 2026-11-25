import SwiftUI
import DSHProxyKit

struct APICatalogPage: View {
    @ObservedObject var store: AppStore
    @State private var catalog: APICatalog?
    @State private var search = ""
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                TextField("Search models, providers, status or regions", text: $search)
                Button("API Keys") { store.go(.chat, .apiKeys) }
                Button("Refresh catalog") { Task { await load(refresh: true) } }
                    .disabled(loading || !store.isRunning)
            }

            if loading { ProgressView("Loading API catalog…") }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if !store.isRunning { Text("Start the gateway to load the API catalog.").foregroundStyle(.secondary) }
            if let catalog {
                ForEach(Array(catalog.warnings.filter { !$0.hasPrefix("Discovery supports public OpenRouter chat metadata only;") }.enumerated()), id: \.offset) { _, warning in
                    Text("Warning: \(warning)").foregroundStyle(.orange).textSelection(.enabled)
                }
                let rows = catalog.models.filter { $0.matches(search) }
                if rows.isEmpty { Text(search.isEmpty ? "No API models returned." : "No matching API models.") }
                Table(rows) {
                    TableColumn("Model") { model in
                        Text(model.modelName).fontWeight(.medium).lineLimit(1).help(model.id)
                            .contextMenu { Button("Copy route ID") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(model.id, forType: .string) } }
                    }.width(min: 120, ideal: 220)
                    TableColumn("Publisher") { model in Text(model.publisher ?? "Unknown").lineLimit(1) }.width(min: 65, ideal: 94)
                    TableColumn("Via (API)") { model in
                        ModelServiceCell(logo: ["deepseek", "moonshot", "zai", "qwen", "gemini", "minimax", "mistral", "openrouter"].contains(model.provider) ? model.provider : nil, label: model.via)
                            .help("Via \(model.via) · \(model.id)")
                    }.width(min: 72, ideal: 100)
                    TableColumn("Context") { model in Text(model.contextWindow.map(Format.tokens) ?? "—").monospacedDigit().frame(maxWidth: .infinity, alignment: .trailing) }.width(min: 46, ideal: 52)
                    TableColumn("Output") { model in Text(model.maxTokens.map(Format.tokens) ?? "—").monospacedDigit().frame(maxWidth: .infinity, alignment: .trailing) }.width(min: 46, ideal: 52)
                    TableColumn("Reasoning") { model in Text(model.efforts.map { $0.isEmpty ? "none" : $0.joined(separator: ", ") } ?? "—").foregroundStyle(.secondary).lineLimit(1) }.width(min: 70, ideal: 100)
                    TableColumn("Status") { model in
                        Text(model.status.guidance.components(separatedBy: " — ")[0]).lineLimit(1)
                            .foregroundStyle(model.status == .ready ? Color.primary : Color.secondary).help(model.status.guidance)
                    }.width(min: 75, ideal: 90)
                    TableColumn("Regions") { model in
                        let regions = model.regions.joined(separator: ", ")
                        Text(regions.isEmpty ? "—" : regions).lineLimit(1).foregroundStyle(.secondary).help(regions)
                    }.width(min: 55, ideal: 120)
                }.accessibilityLabel("API catalog models")
            }
        }
        .task(id: store.isRunning) { if store.isRunning { await load(refresh: false) } }
    }

    private func load(refresh: Bool) async {
        guard !loading else { return }
        loading = true
        error = nil
        defer { loading = false }
        switch await store.call(refresh ? "POST" : "GET", refresh ? "models/api-catalog/refresh" : "models/api-catalog") {
        case .success(let object):
            do { catalog = try APICatalog.parse(object) }
            catch { self.error = "Invalid API catalog response. Try refreshing. Previously loaded entries may be stale." }
        case .failure(let message):
            error = "\(message) Try refreshing. Previously loaded entries may be stale."
        }
    }
}
