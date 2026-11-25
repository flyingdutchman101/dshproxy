import Foundation

public struct APICatalog: Decodable {
    public let models: [APICatalogModel]
    public let warnings: [String]

    public static func parse(_ object: [String: Any]) throws -> APICatalog {
        try JSONDecoder().decode(APICatalog.self, from: JSONSerialization.data(withJSONObject: object))
    }
}

public struct APICatalogModel: Decodable, Identifiable {
    public let id: String
    public let provider: String
    public let status: Readiness
    public let regions: [String]
    public let contextWindow: Double?
    public let maxTokens: Double?
    public let efforts: [String]?

    public enum Readiness: String, Decodable {
        case ready, needsKey, otherRegion, catalogOnly
        public var guidance: String {
            switch self {
            case .ready: return "Ready — available with the current configuration"
            case .needsKey: return "Needs key — add an API key for this provider in API Keys"
            case .otherRegion: return "Other region — configure this provider for a listed region"
            case .catalogOnly: return "Catalog only — not currently available to route"
            }
        }
    }

    private static let names = ["deepseek": "DeepSeek", "moonshot": "Moonshot AI", "zai": "Z.ai", "qwen": "Qwen Cloud", "gemini": "Google Gemini API", "minimax": "MiniMax", "mistral": "Mistral AI", "openrouter": "OpenRouter", "openai": "OpenAI", "anthropic": "Anthropic", "google": "Google", "alibaba": "Alibaba", "meta-llama": "Meta", "bytedance": "ByteDance"]
    public var via: String { Self.names[provider] ?? provider }
    private var upstreamID: String { id.hasPrefix(provider + "/") ? String(id.dropFirst(provider.count + 1)) : id }
    public var modelName: String {
        if provider == "openrouter", let slash = upstreamID.firstIndex(of: "/") { return String(upstreamID[upstreamID.index(after: slash)...]) }
        return upstreamID
    }
    public var publisher: String? {
        var key = provider
        if provider == "openrouter" {
            guard let namespace = upstreamID.split(separator: "/", maxSplits: 1).first, upstreamID.contains("/") else { return nil }
            key = ["moonshotai": "moonshot", "z-ai": "zai", "mistralai": "mistral", "qwen": "alibaba"][String(namespace)] ?? String(namespace)
            return Self.names[key] ?? key
        }
        if provider == "qwen" {
            if upstreamID.hasPrefix("glm-") { key = "zai" } else if upstreamID.hasPrefix("deepseek-") { key = "deepseek" } else if upstreamID.hasPrefix("qwen") { key = "alibaba" } else { return nil }
        }
        if provider == "gemini" { key = "google" }
        return Self.names[key]
    }

    public func matches(_ search: String) -> Bool {
        search.isEmpty || ([id, provider, via, publisher ?? "", status.rawValue, status.guidance] + regions)
            .contains { $0.localizedCaseInsensitiveContains(search) }
    }
}
