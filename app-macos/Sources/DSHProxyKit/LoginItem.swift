import Foundation

/// Start at login (inventory 1.7 and 4.3): what the Windows app's Run key `"<exe>" --hidden` is, on macOS a
/// LaunchAgent in ~/Library/LaunchAgents that starts this app with `--hidden` when the user logs in. Turning it
/// off removes the file; an app that is running is left running, as on Windows. No KeepAlive: Quit stays quit.
public struct LoginItem {
    public static let label = "com.dshproxy.app"
    let agentsFolder: URL
    let executable: URL

    public init(agentsFolder: URL, executable: URL) {
        self.agentsFolder = agentsFolder
        self.executable = executable
    }

    /// ~/Library/LaunchAgents.
    public static func userAgentsFolder(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        home.appendingPathComponent("Library", isDirectory: true).appendingPathComponent("LaunchAgents", isDirectory: true)
    }

    var file: URL { agentsFolder.appendingPathComponent("\(Self.label).plist") }

    /// On when the file is there and starts this very app.
    public var isOn: Bool {
        guard let data = try? Data(contentsOf: file),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let program = plist["ProgramArguments"] as? [String] else { return false }
        return program.first == executable.path
    }

    public func turnOn() throws {
        let plist: [String: Any] = [
            "Label": Self.label,
            "ProgramArguments": [executable.path, "--hidden"],
            "RunAtLoad": true,
            "ProcessType": "Interactive",
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try FileManager.default.createDirectory(at: agentsFolder, withIntermediateDirectories: true)
        do {
            try data.write(to: file, options: .atomic)
        } catch {
            throw KitError("Start at login could not be switched on: \(file.path) could not be written.")
        }
    }

    public func turnOff() throws {
        guard FileManager.default.fileExists(atPath: file.path) else { return }
        do {
            try FileManager.default.removeItem(at: file)
        } catch {
            throw KitError("Start at login could not be switched off: \(file.path) could not be removed.")
        }
    }
}
