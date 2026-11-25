// Menu-bar item (NSStatusItem + NSMenu) and the SwiftUI window in an NSWindow, as in the prototype.
// LSUIElement in Info.plist keeps the app out of the Dock.

import AppKit
import Combine
import DSHProxyKit
import SwiftUI

final class MenuActionBox: NSObject {
    let action: MenuAction
    init(_ a: MenuAction) { action = a }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate {
    let store: AppStore
    private var statusItem: NSStatusItem!
    private var window: NSWindow?
    private var subs = Set<AnyCancellable>()
    private var alertOpen = false
    var startHidden = false
    var updateBusy = false

    init(store: AppStore) {
        self.store = store
        super.init()
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.accessory)
        NSApp.applicationIconImage = appIcon(256)
        buildMainMenu()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = self
        statusItem.menu = menu
        updateIcon()

        store.presentAlert = { [weak self] spec, done in
            guard let self else { done(-1); return }
            self.present(spec, done)
        }
        store.checkAppUpdate = { [weak self] in Task { await self?.checkForUpdate() } }
        store.openWindow = { [weak self] in self?.openWindow() }
        store.$gateway.receive(on: RunLoop.main).sink { [weak self] _ in self?.updateIcon() }.store(in: &subs)
        store.$statusUnavailable.receive(on: RunLoop.main).sink { [weak self] _ in self?.updateIcon() }.store(in: &subs)

        // A second launch asks this one to show its window (single instance).
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(showRequested), name: SingleInstance.showNotification, object: nil)

        store.launch()
        if !startHidden { openWindow() }
        Task { await showUpdateResult() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Quit (menu, ⌘Q, logout): asks as Stop does when requests are in flight, then stops this app's gateway.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if store.readyToQuit { return .terminateNow }
        Task { @MainActor in
            let ok = await store.prepareQuit()
            store.readyToQuit = ok
            NSApp.reply(toApplicationShouldTerminate: ok)
        }
        return .terminateLater
    }

    // MARK: Status item

    private func updateIcon() {
        guard let button = statusItem?.button else { return }
        button.image = StatusIcon.image(for: store.gateway)
        button.toolTip = store.menuStatusText
        button.setAccessibilityLabel(store.menuStatusText)
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        store.readStartAtLogin()
        menu.removeAllItems()
        for e in menuEntries(store) { menu.addItem(makeItem(e)) }
    }

    private func makeItem(_ e: MenuEntry) -> NSMenuItem {
        switch e {
        case .header(let t):
            let i = NSMenuItem(title: t, action: nil, keyEquivalent: "")
            i.isEnabled = false
            return i
        case .separator:
            return .separator()
        case .item(let t, let enabled, let checked, let key, let tooltip, let action):
            let i = NSMenuItem(title: t, action: enabled ? #selector(runMenu(_:)) : nil, keyEquivalent: key)
            i.target = self
            i.isEnabled = enabled
            i.state = checked ? .on : .off
            i.toolTip = tooltip
            i.representedObject = MenuActionBox(action)
            return i
        }
    }

    @objc private func runMenu(_ sender: NSMenuItem) {
        guard let box = sender.representedObject as? MenuActionBox else { return }
        switch box.action {
        case .open: openWindow()
        case .addAccount: store.addAccount()
        case .start: Task { await store.startGateway() }
        case .stop: store.stopRequested()
        case .loginItem: store.setStartAtLogin(!store.startAtLogin)
        case .selfUpdate: Task { await checkForUpdate() }
        case .quit: NSApp.terminate(nil)
        }
    }

    @objc private func showRequested() { openWindow() }

    // MARK: Window

    func openWindow() {
        store.readStartAtLogin()
        if window == nil {
            let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main
            let vis = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            let w = min(1280, vis.width * 0.92), h = min(880, vis.height * 0.92)
            let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: w, height: h),
                               styleMask: [.titled, .closable, .miniaturizable, .resizable],
                               backing: .buffered, defer: false)
            win.title = "DSHProxy"
            win.isReleasedWhenClosed = false     // closing hides; the menu-bar item and the gateway stay
            win.contentMinSize = NSSize(width: min(860, vis.width * 0.92), height: min(600, vis.height * 0.92))
            win.contentView = NSHostingView(rootView: RootView(store: store))
            win.setFrame(NSRect(x: vis.midX - w / 2, y: vis.midY - h / 2, width: w, height: h), display: false)
            win.delegate = self
            window = win
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.deminiaturize(nil)
        window?.makeKeyAndOrderFront(nil)
        store.windowVisible = true
    }

    func windowWillClose(_ notification: Notification) { store.windowVisible = false }
    func windowDidMiniaturize(_ notification: Notification) { store.windowVisible = false }
    func windowDidDeminiaturize(_ notification: Notification) { store.windowVisible = true }
    func windowDidChangeOcclusionState(_ notification: Notification) {
        guard let window else { return }
        store.windowVisible = window.isVisible && window.occlusionState.contains(.visible)
    }

    // MARK: Alerts

    private func present(_ spec: AlertSpec, _ done: @escaping (Int) -> Void) {
        guard !alertOpen else { done(-1); return }   // a second Stop/Quit while one is open does nothing
        let alert = makeAlert(spec)
        alertOpen = true
        let finish: (NSApplication.ModalResponse) -> Void = { [weak self] r in
            self?.alertOpen = false
            done(r.rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue)
        }
        if let w = window, w.isVisible, w.attachedSheet == nil {
            alert.beginSheetModal(for: w, completionHandler: finish)
        } else {
            NSApp.activate(ignoringOtherApps: true)
            finish(alert.runModal())
        }
    }

    // MARK: Main menu (keyboard shortcuts work even though an accessory app shows no menu bar)

    private func buildMainMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem(); main.addItem(appItem)
        let app = NSMenu()
        app.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        app.addItem(withTitle: "Quit DSHProxy", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = app

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let goItem = NSMenuItem(); main.addItem(goItem)
        let go = NSMenu(title: "Go")
        for (n, s) in Section.allCases.enumerated() {
            let i = NSMenuItem(title: s.title, action: #selector(goSection(_:)), keyEquivalent: "\(n + 1)")
            i.tag = s.rawValue; i.target = self
            go.addItem(i)
        }
        go.addItem(.separator())
        for (n, ws) in Workspace.allCases.enumerated() {
            let i = NSMenuItem(title: "\(ws.title) workspace", action: #selector(goWorkspace(_:)), keyEquivalent: "\(n + 1)")
            i.keyEquivalentModifierMask = [.command, .option]
            i.tag = n; i.target = self
            go.addItem(i)
        }
        goItem.submenu = go

        NSApp.mainMenu = main
    }

    @objc private func goSection(_ i: NSMenuItem) { store.go(store.workspace, Section(rawValue: i.tag)!) }
    @objc private func goWorkspace(_ i: NSMenuItem) { store.go(Workspace.allCases[i.tag], store.section) }
}

@MainActor
func makeAlert(_ spec: AlertSpec) -> NSAlert {
    let alert = NSAlert()
    alert.messageText = spec.title
    alert.informativeText = spec.message
    alert.alertStyle = spec.style
    for b in spec.buttons {
        let btn = alert.addButton(withTitle: b.label)
        if b.kind == .destructive { btn.hasDestructiveAction = true }
        if b.kind == .safe { btn.keyEquivalent = btn === alert.buttons.first ? "\r" : "\u{1b}" }
    }
    return alert
}

/// The app icon, drawn from the same artwork as the window's mark.
@MainActor
func appIcon(_ size: CGFloat) -> NSImage {
    let view = NSHostingView(rootView: AppMark(size: size * 0.8).frame(width: size, height: size))
    view.frame = NSRect(x: 0, y: 0, width: size, height: size)
    guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return NSImage(size: NSSize(width: size, height: size)) }
    view.cacheDisplay(in: view.bounds, to: rep)
    let image = NSImage(size: NSSize(width: size, height: size))
    image.addRepresentation(rep)
    return image
}
