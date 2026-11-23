// Menu-bar item (NSStatusItem + NSMenu, as DroidProxy does) and the SwiftUI window in an
// NSWindow. LSUIElement in Info.plist keeps the app out of the Dock.

import AppKit
import Combine
import SwiftUI

final class MenuActionBox: NSObject {
    let action: MenuAction
    init(_ a: MenuAction) { action = a }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate {
    let store = AppStore()
    private var statusItem: NSStatusItem!
    private var window: NSWindow?
    private var subs = Set<AnyCancellable>()
    private var alertOpen = false
    var startHidden = false

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.accessory)
        buildMainMenu()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        updateIcon(store.gateway)

        store.presentAlert = { [weak self] spec in self?.present(spec) }
        store.openWindow = { [weak self] in self?.openWindow() }
        store.terminate = { NSApp.terminate(nil) }
        store.$gateway.receive(on: RunLoop.main).sink { [weak self] g in self?.updateIcon(g) }.store(in: &subs)
        store.startLive()

        if !startHidden { openWindow() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // MARK: Status item

    private func updateIcon(_ g: Gateway) {
        guard let button = statusItem?.button else { return }
        button.image = StatusIcon.image(for: g)
        button.toolTip = g.menuText
        button.setAccessibilityLabel(g.menuText)
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
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
        case .item(let t, let enabled, let checked, let key, let action):
            let i = NSMenuItem(title: t, action: enabled ? #selector(runMenu(_:)) : nil, keyEquivalent: key)
            i.target = self
            i.isEnabled = enabled
            i.state = checked ? .on : .off
            i.representedObject = MenuActionBox(action)
            return i
        case .submenu(let t, let entries):
            let i = NSMenuItem(title: t, action: nil, keyEquivalent: "")
            let sub = NSMenu(title: t)
            sub.autoenablesItems = false
            for x in entries { sub.addItem(makeItem(x)) }
            i.submenu = sub
            return i
        }
    }

    @objc private func runMenu(_ sender: NSMenuItem) {
        guard let box = sender.representedObject as? MenuActionBox else { return }
        perform(box.action)
    }

    private func perform(_ a: MenuAction) {
        switch a {
        case .open: openWindow()
        case .addAccount: store.addAccount()
        case .start: store.startGateway()
        case .stop: store.stopGateway()
        case .loginItem: store.setLoginItem(!store.loginItem)
        case .quit: store.quit()
        case .simulate(let g): store.simulate(g)
        case .sampleData: store.loadData(empty: false)
        case .emptyData: store.loadData(empty: true)
        }
    }

    // MARK: Window

    func openWindow() {
        if window == nil {
            let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main
            let vis = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            let w = min(1280, vis.width * 0.92), h = min(880, vis.height * 0.92)
            let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: w, height: h),
                               styleMask: [.titled, .closable, .miniaturizable, .resizable],
                               backing: .buffered, defer: false)
            win.title = "DSHProxy"
            win.isReleasedWhenClosed = false     // closing hides; the menu-bar item stays
            win.contentMinSize = NSSize(width: min(860, vis.width * 0.92), height: min(600, vis.height * 0.92))
            win.contentView = NSHostingView(rootView: RootView(store: store))
            win.setFrame(NSRect(x: vis.midX - w / 2, y: vis.midY - h / 2, width: w, height: h), display: false)
            win.delegate = self
            window = win
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    // MARK: Alerts

    private func present(_ spec: AlertSpec) {
        guard !alertOpen else { return }        // a second Stop/Quit while one is open does nothing
        let alert = makeAlert(spec)
        alertOpen = true
        let done: (NSApplication.ModalResponse) -> Void = { [weak self] r in
            self?.alertOpen = false
            let i = r.rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
            if i >= 0 && i < spec.buttons.count { spec.buttons[i].action() }
        }
        if let w = window, w.isVisible, w.attachedSheet == nil {
            alert.beginSheetModal(for: w, completionHandler: done)
        } else {
            NSApp.activate(ignoringOtherApps: true)
            done(alert.runModal())
        }
    }

    // MARK: Main menu (keyboard shortcuts work even though an accessory app shows no menu bar)

    private func buildMainMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem(); main.addItem(appItem)
        let app = NSMenu()
        app.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let q = NSMenuItem(title: "Quit DSHProxy", action: #selector(quitFromMenu), keyEquivalent: "q"); q.target = self
        app.addItem(q)
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

    @objc private func quitFromMenu() { store.quit() }
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
        if b.label == "Cancel" || b.label == "Later" { btn.keyEquivalent = btn === alert.buttons.first ? "\r" : "\u{1b}" }
    }
    return alert
}
