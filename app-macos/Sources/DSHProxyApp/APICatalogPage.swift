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
            Text("API discovery is separate from offered models. Catalog entries do not enable routing.")
                .font(.callout).foregroundStyle(.secondary)
            if loading { ProgressView("Loading API catalog…") }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if !store.isRunning { Text("Start the gateway to load the API catalog.").foregroundStyle(.secondary) }
            if let catalog {
                ForEach(Array(catalog.warnings.enumerated()), id: \.offset) { _, warning in
                    Text("Warning: \(warning)").foregroundStyle(.orange).textSelection(.enabled)
                }
                let rows = catalog.models.filter { $0.matches(search) }
                if rows.isEmpty { Text(search.isEmpty ? "No API models returned." : "No matching API models.") }
                List(Array(rows.enumerated()), id: \.offset) { _, model in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(model.id).font(.headline)
                        Text("Provider: \(model.provider)")
                        Text("\(model.status.rawValue): \(model.status.guidance)")
                            .foregroundStyle(model.status == .ready ? Color.green : Color.secondary)
                        Text("Regions: \(model.regions.isEmpty ? "Not specified" : model.regions.joined(separator: ", "))")
                    }.textSelection(.enabled)
                }
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
