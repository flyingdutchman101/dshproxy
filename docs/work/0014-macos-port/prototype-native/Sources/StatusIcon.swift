// Menu-bar icon: a template (monochrome) compass needle in a ring, drawn in code.
// The shape carries the state, because template images take the menu bar's colour:
//   running       solid needle, solid ring
//   starting      solid needle, dashed ring
//   not answering solid needle, solid ring, "!" badge
//   stopped       hollow needle, solid ring, diagonal slash

import AppKit

enum StatusIcon {
    static func image(for state: Gateway, size: CGFloat = 18) -> NSImage {
        let img = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            let s = rect.width / 18
            let ctx = NSGraphicsContext.current!.cgContext
            NSColor.black.set()

            // Ring
            let ring = NSBezierPath(ovalIn: NSRect(x: 2 * s, y: 2 * s, width: 14 * s, height: 14 * s))
            ring.lineWidth = 1.3 * s
            if state == .starting { ring.setLineDash([2.2 * s, 1.6 * s], count: 2, phase: 0) }
            ring.stroke()

            // Needle (tilted)
            let needle = NSBezierPath()
            let c = NSPoint(x: 9 * s, y: 9 * s)
            let pts = [NSPoint(x: 0, y: 7.2), NSPoint(x: 2.1, y: 0), NSPoint(x: 0, y: -7.2), NSPoint(x: -2.1, y: 0)]
            let a = -20.0 * Double.pi / 180
            for (i, p) in pts.enumerated() {
                let q = NSPoint(x: c.x + (p.x * cos(a) - p.y * sin(a)) * s, y: c.y + (p.x * sin(a) + p.y * cos(a)) * s)
                if i == 0 { needle.move(to: q) } else { needle.line(to: q) }
            }
            needle.close()
            if state == .stopped {
                needle.lineWidth = 1.1 * s
                needle.stroke()
                // Slash, with a clear gap around it so it reads at 18 px.
                ctx.setBlendMode(.clear)
                let gap = NSBezierPath(); gap.move(to: NSPoint(x: 2.5 * s, y: 15.5 * s)); gap.line(to: NSPoint(x: 15.5 * s, y: 2.5 * s))
                gap.lineWidth = 3.6 * s; gap.stroke()
                ctx.setBlendMode(.normal)
                let slash = NSBezierPath(); slash.move(to: NSPoint(x: 2.5 * s, y: 15.5 * s)); slash.line(to: NSPoint(x: 15.5 * s, y: 2.5 * s))
                slash.lineWidth = 1.5 * s; slash.lineCapStyle = .round; slash.stroke()
            } else {
                needle.fill()
            }

            if state == .notAnswering {
                let badge = NSRect(x: 10.5 * s, y: 0, width: 7.5 * s, height: 7.5 * s)
                ctx.setBlendMode(.clear)
                NSBezierPath(ovalIn: badge.insetBy(dx: -1.2 * s, dy: -1.2 * s)).fill()
                ctx.setBlendMode(.normal)
                NSBezierPath(ovalIn: badge).fill()
                ctx.setBlendMode(.clear)
                NSBezierPath(rect: NSRect(x: badge.midX - 0.6 * s, y: badge.minY + 2.9 * s, width: 1.2 * s, height: 3.2 * s)).fill()
                NSBezierPath(ovalIn: NSRect(x: badge.midX - 0.65 * s, y: badge.minY + 1.1 * s, width: 1.3 * s, height: 1.3 * s)).fill()
                ctx.setBlendMode(.normal)
            }
            return true
        }
        img.isTemplate = true
        img.accessibilityDescription = state.menuText
        return img
    }
}

/// The status-item menu as data, so the real NSMenu and the render mode's drawing of it
/// come from the same list.
enum MenuEntry {
    case header(String)
    case separator
    case item(String, enabled: Bool, checked: Bool, key: String, action: MenuAction)
    case submenu(String, [MenuEntry])
}

enum MenuAction {
    case open, addAccount, start, stop, loginItem, quit
    case simulate(Gateway), sampleData, emptyData
}

@MainActor
func menuEntries(_ store: AppStore) -> [MenuEntry] {
    let g = store.gateway
    return [
        .header(g.menuText),
        .separator,
        .item("Open DSHProxy", enabled: true, checked: false, key: "o", action: .open),
        .item("Add account…", enabled: true, checked: false, key: "", action: .addAccount),
        .separator,
        .item("Start gateway", enabled: g == .stopped, checked: false, key: "", action: .start),
        .item("Stop gateway", enabled: g != .stopped, checked: false, key: "", action: .stop),
        .separator,
        .item("Start at login", enabled: true, checked: store.loginItem, key: "", action: .loginItem),
        .separator,
        .submenu("Prototype", [
            .header("Not part of the product"),
            .item("Simulate: gateway running", enabled: g != .running, checked: false, key: "", action: .simulate(.running)),
            .item("Simulate: gateway not answering", enabled: g != .notAnswering, checked: false, key: "", action: .simulate(.notAnswering)),
            .item("Simulate: gateway starting (stays)", enabled: g != .starting, checked: false, key: "", action: .simulate(.starting)),
            .separator,
            .item("Load sample data", enabled: true, checked: false, key: "", action: .sampleData),
            .item("Load empty first-run data", enabled: true, checked: false, key: "", action: .emptyData),
        ]),
        .separator,
        .item("Quit DSHProxy", enabled: true, checked: false, key: "q", action: .quit),
    ]
}
