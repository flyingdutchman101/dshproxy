import Foundation

/// An error the app shows as it is: always one sentence.
public struct KitError: Error, CustomStringConvertible, Equatable {
    public let description: String
    init(_ description: String) { self.description = description }
}

/// Where things are: the DSHProxy folder, Node.js and the data folder.
public struct Locations: Equatable {
    /// Folder that holds bin/dshproxy.js.
    public let checkout: URL
    /// An executable `node`.
    public let node: URL
    /// Data folder: DSHPROXY_HOME, else ~/.dshproxy.
    public let home: URL

    public static let defaultNodeFolders = ["/opt/homebrew/bin", "/usr/local/bin"]

    init(checkout: URL, node: URL, home: URL) {
        self.checkout = checkout
        self.node = node
        self.home = home
    }

    /// checkout: env DSHPROXY_CHECKOUT, else `recordedCheckout` (written into the app's Info.plist by build.sh);
    /// the first of them that holds bin/dshproxy.js. node: each PATH entry, then `nodeFolders`; the first
    /// executable file named `node`. home: DSHPROXY_HOME, else `homeDirectory`/.dshproxy.
    public static func find(environment: [String: String], recordedCheckout: String?, nodeFolders: [String] = defaultNodeFolders, homeDirectory: URL) throws -> Locations {
        let files = FileManager.default
        let candidates = [environment["DSHPROXY_CHECKOUT"], recordedCheckout].compactMap { $0 }.filter { !$0.isEmpty }
        guard let checkout = candidates.first(where: { isFile(URL(fileURLWithPath: $0).appendingPathComponent("bin/dshproxy.js").path) }) else {
            throw KitError("DSHProxy.app does not know where the DSHProxy folder is. Build it again with app-macos/build.sh in that folder.")
        }
        let pathFolders = (environment["PATH"] ?? "").split(separator: ":").map(String.init).filter { !$0.isEmpty }
        guard let node = (pathFolders + nodeFolders)
            .map({ URL(fileURLWithPath: $0).appendingPathComponent("node").path })
            .first(where: { isFile($0) && files.isExecutableFile(atPath: $0) }) else {
            throw KitError("Node.js was not found. Install Node.js 22 or later.")
        }
        let home: URL
        if let value = environment["DSHPROXY_HOME"], !value.isEmpty {
            home = URL(fileURLWithPath: value, isDirectory: true)
        } else {
            home = homeDirectory.appendingPathComponent(".dshproxy", isDirectory: true)
        }
        return Locations(checkout: URL(fileURLWithPath: checkout, isDirectory: true), node: URL(fileURLWithPath: node), home: home)
    }

    private static func isFile(_ path: String) -> Bool {
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &directory) && !directory.boolValue
    }
}
