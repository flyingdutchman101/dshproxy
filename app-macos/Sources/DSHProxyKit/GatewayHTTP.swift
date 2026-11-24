import Foundation

/// One HTTP exchange with the gateway on loopback: no proxy, no cache, no cookies, `timeout` for the whole call.
enum LoopbackHTTP {
    static func send(_ request: URLRequest, timeout: TimeInterval) async throws -> (status: Int, body: Data) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        configuration.connectionProxyDictionary = ["HTTPEnable": false, "HTTPSEnable": false]
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.waitsForConnectivity = false
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        var request = request
        request.timeoutInterval = timeout
        let (data, response) = try await session.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    /// `origin` without a trailing slash, followed by `path` (which starts with a slash).
    static func url(_ origin: URL, _ path: String) -> URL? {
        var base = origin.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        return URL(string: base + path)
    }

    static func object(_ data: Data) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}

/// The token-free status of a gateway, as GET {origin}/dshproxy/status returns it. nil when nothing answers
/// with HTTP 200 and a JSON object within `timeout`.
public enum StatusProbe {
    public static func fetch(origin: URL, timeout: TimeInterval = 2) async -> [String: Any]? {
        guard let url = LoopbackHTTP.url(origin, "/dshproxy/status") else { return nil }
        guard let (status, body) = try? await LoopbackHTTP.send(URLRequest(url: url), timeout: timeout), status == 200 else { return nil }
        return LoopbackHTTP.object(body)
    }
}

public enum ControlError: Error, Equatable, CustomStringConvertible {
    /// No token file: "The gateway is not running. Press Start first."
    case notRunning
    /// Connection failed or timed out: "The gateway did not answer. Is it running?"
    case noAnswer
    /// The gateway's {error} text, or "The gateway refused (HTTP n)."
    case refused(String)

    public var description: String {
        switch self {
        case .notRunning: return "The gateway is not running. Press Start first."
        case .noAnswer: return "The gateway did not answer. Is it running?"
        case .refused(let message): return message
        }
    }
}

/// The control API: {origin}/dshproxy/control/{route}. Reads {home}/control.token fresh on every call and sends
/// it in `x-dshproxy-token`; never sends an `Origin` header; JSON body (or none); timeout per call.
public struct ControlClient {
    let origin: URL
    let home: URL

    public init(origin: URL, home: URL) {
        self.origin = origin
        self.home = home
    }

    public func call(_ method: String, _ route: String, body: [String: Any]? = nil, query: [String: String] = [:], timeout: TimeInterval = 20) async throws -> [String: Any] {
        let tokenFile = home.appendingPathComponent("control.token")
        guard let text = try? String(contentsOf: tokenFile, encoding: .utf8) else { throw ControlError.notRunning }
        let token = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { throw ControlError.notRunning }

        var path = "/dshproxy/control/" + route
        if !query.isEmpty {
            path += "?" + query.sorted { $0.key < $1.key }.map { "\(encode($0.key))=\(encode($0.value))" }.joined(separator: "&")
        }
        guard let url = LoopbackHTTP.url(origin, path) else { throw ControlError.refused("The control address is not valid.") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(token, forHTTPHeaderField: "x-dshproxy-token")
        if let body {
            guard JSONSerialization.isValidJSONObject(body), let data = try? JSONSerialization.data(withJSONObject: body) else {
                throw ControlError.refused("The request could not be written as JSON.")
            }
            request.httpBody = data
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let status: Int, answer: Data
        do {
            (status, answer) = try await LoopbackHTTP.send(request, timeout: timeout)
        } catch {
            throw ControlError.noAnswer
        }
        let object = LoopbackHTTP.object(answer)
        guard (200..<300).contains(status) else {
            if let message = object?["error"] as? String, !message.isEmpty { throw ControlError.refused(message) }
            throw ControlError.refused("The gateway refused (HTTP \(status)).")
        }
        guard let object else { throw ControlError.refused("The gateway's answer was not a JSON object.") }
        return object
    }

    private func encode(_ text: String) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+?#")
        return text.addingPercentEncoding(withAllowedCharacters: allowed) ?? text
    }
}
