import Foundation

public struct ProviderPickerEntry: Decodable, Identifiable {
    public let id: String
    public let model: String
    public let name: String
    public let enabled: Bool
}

public struct ProviderPickerState: Decodable {
    public let enabled: Bool
    public static func decode(_ text: String) -> ProviderPickerState? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }
}
