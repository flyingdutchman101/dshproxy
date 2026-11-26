import SwiftUI
import DSHProxyKit

/// Opening Research is offline; only confirmed actions invoke the CLI.
struct ResearchPage: View {
    struct Item: Decodable, Identifiable { let label: String; let id: String }
    struct Results: Decodable { let items: [Item] }
    @ObservedObject var store: AppStore
    @State private var query = ""
    @State private var key = ""
    @State private var busy = false
    @State private var items: [Item] = []
    @State private var selection: String?
    @State private var message = "Nothing has been sent."
    private var displayed: [Item] { store.isSample ? [Item(label: "Sample ad — summer campaign", id: "sample-ad"), Item(label: "Sample inspiration board", id: "sample-board")] : items }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Foreplay Research").font(.title2.bold())
                Text("Search ads and browse boards. Opening this tab is offline. Each request requires credit confirmation; no automatic retries.").foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Link("Foreplay website", destination: URL(string: "https://www.foreplay.co")!)
                    Link("Get your Foreplay API key", destination: URL(string: "https://app.foreplay.co/api-overview")!)
                }
                SecureField("Foreplay API key", text: $key)
                Text("Saved locally through standard input only, never command arguments. Saving does not validate the key online.").font(.caption).foregroundStyle(.secondary)
                Button("Save key") { Task { await saveKey() } }
                    .disabled(busy || store.isSample || key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Divider()
                TextField("Search ads", text: $query)
                HStack {
                    Button("Search ads…") { Task { await request(search: true) } }
                        .buttonStyle(.borderedProminent)
                        .disabled(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("List boards…") { Task { await request(search: false) } }
                }.disabled(busy || store.isSample)
                if store.isSample { Text("Sample results only — no network requests.").foregroundStyle(.secondary) }
                Text(message).textSelection(.enabled)
                ForEach(Array(displayed.enumerated()), id: \.offset) { _, item in
                    VStack(alignment: .leading, spacing: 4) {
                        Button { selection = item.id } label: {
                            Label(item.label, systemImage: selection == item.id ? "checkmark.circle.fill" : "circle")
                        }.buttonStyle(.plain)
                        Text(item.id).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    }.padding(.vertical, 4)
                }
            }.padding(24).disabled(busy)
        }
    }

    @MainActor private func saveKey() async {
        guard !busy, !store.isSample else { return }
        let value = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.contains("\n"), !value.contains("\r") else { message = "Enter a single-line API key."; return }
        busy = true
        key = ""
        defer { busy = false }
        let result = await store.cli(["research", "key", "set"], input: value + "\n", timeout: 30)
        // Never echo subprocess output from a credential operation.
        message = result?.code == 0 ? "Foreplay key saved." : "Key could not be saved. Check your local CLI setup."
    }

    @MainActor private func request(search: Bool) async {
        guard !busy, !store.isSample else { return }
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !search || !text.isEmpty else { return }
        busy = true
        defer { busy = false }
        let terms = search ? "Up to 10 ads, at 1 credit per returned ad." : "Up to 10 boards, at 1 credit for a successful nonempty request."
        guard await store.confirm("Use Foreplay credits?", "\(search ? "Search ads for: \(text)" : "List your Foreplay boards")\n\n\(terms) This request will be sent once, with no automatic retries.", yes: "Confirm credits") else { return }
        let args = search ? ["research", "search", "--query", text, "--confirm-credits"] : ["research", "boards", "--confirm-credits"]
        guard let result = await store.cli(args, timeout: 60), result.code == 0,
              let data = result.stdout.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(Results.self, from: data) else {
            message = "Request failed or returned an unreadable response. Check Foreplay usage before trying again."
            return
        }
        items = decoded.items
        selection = nil
        message = items.isEmpty ? "No results found." : "\(items.count) results. Select a result or copy its ID."
    }
}
