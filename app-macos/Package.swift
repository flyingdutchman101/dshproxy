// swift-tools-version:5.9
// DSHProxy for macOS: the app (DSHProxyApp), its non-UI part (DSHProxyKit) and
// the checks of that part (KitChecks). See KIT.md. No third-party packages.
import PackageDescription

let package = Package(
    name: "DSHProxy",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "DSHProxyKit", targets: ["DSHProxyKit"]),
        .executable(name: "DSHProxyApp", targets: ["DSHProxyApp"]),
        .executable(name: "KitChecks", targets: ["KitChecks"]),
    ],
    targets: [
        .target(name: "DSHProxyKit"),
        .executableTarget(name: "DSHProxyApp", dependencies: ["DSHProxyKit"]),
        .executableTarget(name: "KitChecks", dependencies: ["DSHProxyKit"]),
    ]
)
