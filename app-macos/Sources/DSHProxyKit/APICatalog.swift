import Foundation

public struct APICatalog: Decodable {
    public let models: [APICatalogModel]
    public let warnings: [String]

    public static func parse(_ object: [String: Any]) throws -> APICatalog {
        try JSONDecoder().decode(APICatalog.self, from: JSONSerialization.data(withJSONObject: object))
    }
}

public struct APICatalogModel: Decodable {
    public let id: String
    public let provider: String
    public let status: Readiness
    public let regions: [String]

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

    public func matches(_ search: String) -> Bool {
        search.isEmpty || ([id, provider, status.rawValue, status.guidance] + regions)
            .contains { $0.localizedCaseInsensitiveContains(search) }
    }
}
