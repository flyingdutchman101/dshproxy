# Implementation plan

1. CLI candidate check (`src/self-update/{candidate,command}.js`, `src/cli.js`): assert only official, passing main push SHAs newer than the installed revision are offered. Verify: `node --test test/self-update-{candidate,command}.test.js`.
2. Stage, build and switch (`src/self-update/{install,install-worker,desktop-host,desktop-worker,result}.js`): exact-SHA recheck, idle gate, relaunch acknowledgement and recovery without resetting dirty state. Verify: `node --test test/self-update*.test.js` using temporary Git repositories.
3. macOS and Windows native footer and tray actions (`app-macos/Sources/DSHProxyApp`, `app/DSHProxyApp.cs`): explicit confirmation and session-scoped gateway startup. Verify: `swift build --package-path app-macos`, `swift run --package-path app-macos KitChecks`, Windows Framework compiler where available.
4. Integration review, full Node suite and syntax checks. No deployment or signing as part of development.
