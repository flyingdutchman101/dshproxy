// Small shared views (from the accepted prototype). System controls and colours throughout; the only custom
// drawing is the app mark, the letter badges that stand in for a missing logo, and the ladder chips.

import AppKit
import DSHProxyKit
import SwiftUI

struct Chip: View {
    let text: String
    var color: Color = .secondary
    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Capsule().fill(color.opacity(0.13)))
            .overlay(Capsule().strokeBorder(color.opacity(0.35)))
            .fixedSize()
    }
}

/// Letter badge standing in for a provider or company logo when the logo file is not there.
struct Badge: View {
    let letters: String
    let hue: Double
    var size: CGFloat = 24
    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.26)
            .fill(Color(hue: hue / 360, saturation: 0.5, brightness: 0.88))
            .frame(width: size, height: size)
            .overlay(Text(letters).font(.system(size: size * 0.40, weight: .bold)).foregroundStyle(Color.black.opacity(0.78)))
            .accessibilityHidden(true)
    }
}

/// A provider or company logo (app/logos), or its letter badge; nothing for a name without either.
struct LogoView: View {
    let name: String
    var size: CGFloat = 24
    var body: some View {
        if let image = Logos.image(name) {
            Image(nsImage: image).resizable().interpolation(.high).frame(width: size, height: size).accessibilityHidden(true)
        } else if let (letters, hue) = Logos.letters[name] {
            Badge(letters: letters, hue: hue, size: size)
        } else {
            Badge(letters: String(name.prefix(2)).capitalized, hue: 0, size: size).saturation(0)
        }
    }
}

/// Compass needle, the DSHProxy mark (same idea as the Windows icon: brass needle on a dark sea).
struct NeedleShape: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        let c = CGPoint(x: r.midX, y: r.midY)
        let w = r.width * 0.13
        p.move(to: CGPoint(x: c.x, y: r.minY))
        p.addLine(to: CGPoint(x: c.x + w, y: c.y))
        p.addLine(to: CGPoint(x: c.x, y: r.maxY))
        p.addLine(to: CGPoint(x: c.x - w, y: c.y))
        p.closeSubpath()
        return p
    }
}

struct AppMark: View {
    var size: CGFloat = 44
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.24)
                .fill(LinearGradient(colors: [Color(red: 0.06, green: 0.20, blue: 0.28), Color(red: 0.02, green: 0.09, blue: 0.14)],
                                     startPoint: .top, endPoint: .bottom))
            Circle().strokeBorder(Color(red: 0.89, green: 0.70, blue: 0.42).opacity(0.45), lineWidth: 1)
                .padding(size * 0.14)
            NeedleShape().fill(Color(red: 0.89, green: 0.70, blue: 0.42))
                .padding(size * 0.12)
                .rotationEffect(.degrees(20))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// One limit window: title, bar, "64% left · resets in …". The bar is a native Gauge.
struct LimitRow: View {
    let window: LimitWindow
    let now: Date
    var body: some View {
        GridRow {
            Text(window.title)
                .foregroundStyle(window.reported ? .primary : .secondary)
                .lineLimit(1)
                .frame(minWidth: 96, alignment: .leading)
            if window.reported {
                let left = window.leftPercent
                Gauge(value: max(0, min(100, left)), in: 0...100) { EmptyView() }
                    .gaugeStyle(.linearCapacity)
                    .tint(levelColor(left))
                    .frame(minWidth: 120)
                Text(window.line(now: now))
                    .foregroundColor(levelColor(left))
                    .font(.callout)
                    .lineLimit(1)
                    .frame(width: 330, alignment: .leading)
            } else {
                Gauge(value: 0, in: 0...100) { EmptyView() }
                    .gaugeStyle(.linearCapacity)
                    .opacity(0.35)
                    .frame(minWidth: 120)
                Text("Not reported for this plan").font(.callout).foregroundStyle(.secondary)
                    .frame(width: 330, alignment: .leading)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(window.title) limit")
        .accessibilityValue(window.reported ? window.line(now: now) : "Not reported for this plan")
    }
}

/// Wrapping row layout for the lane ladders (macOS 13 Layout).
struct FlowLayout: Layout {
    var spacing: CGFloat = 4
    var lineSpacing: CGFloat = 5

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxW = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, lineH: CGFloat = 0, widest: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x > 0 && x + sz.width > maxW { y += lineH + lineSpacing; x = 0; lineH = 0 }
            x += sz.width + spacing
            lineH = max(lineH, sz.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + lineH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x: CGFloat = 0, y: CGFloat = 0, lineH: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x > 0 && x + sz.width > bounds.width { y += lineH + lineSpacing; x = 0; lineH = 0 }
            s.place(at: CGPoint(x: bounds.minX + x, y: bounds.minY + y), proposal: ProposedViewSize(sz))
            x += sz.width + spacing
            lineH = max(lineH, sz.height)
        }
    }
}

/// Title, note and the page's buttons. The buttons go under the note when the window is narrow.
struct PageHeader<Actions: View>: View {
    let title: String
    let note: String
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 16) {
                text.frame(minWidth: 420, alignment: .leading)
                Spacer(minLength: 0)
                HStack(spacing: 8) { actions() }.fixedSize()
            }
            VStack(alignment: .leading, spacing: 10) {
                text
                HStack(spacing: 8) { actions() }.fixedSize()
            }
        }
    }

    private var text: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
            Text(note).font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 760, alignment: .leading)
        }
    }
}

extension PageHeader where Actions == EmptyView {
    init(title: String, note: String) { self.init(title: title, note: note, actions: { EmptyView() }) }
}

/// Large centred message used instead of a page's content (gateway starting / not answering,
/// empty lists).
struct StatePanel<Extra: View>: View {
    let symbol: String
    let title: String
    let text: String
    var spinner = false
    @ViewBuilder var extra: () -> Extra

    var body: some View {
        VStack(spacing: 10) {
            if spinner { ProgressView().controlSize(.regular) } else {
                Image(systemName: symbol).font(.system(size: 30)).foregroundStyle(.secondary).accessibilityHidden(true)
            }
            Text(title).font(.title3.weight(.semibold))
            Text(text).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 460)
            extra()
        }
        .padding(28)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 10).fill(.quaternary.opacity(0.5)))
        .accessibilityElement(children: .contain)
    }
}

extension StatePanel where Extra == EmptyView {
    init(symbol: String, title: String, text: String, spinner: Bool = false) {
        self.init(symbol: symbol, title: title, text: text, spinner: spinner, extra: { EmptyView() })
    }
}

/// A one-line coloured note with an SF Symbol (e.g. "gateway not answering").
struct Banner: View {
    let symbol: String
    let text: String
    var color: Color = .orange
    var body: some View {
        Label { Text(text).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: symbol).foregroundStyle(color) }
            .font(.callout)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(color.opacity(0.10)))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(color.opacity(0.30)))
    }
}

/// Rounded "card" background in the system look.
struct CardBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(nsColor: .separatorColor)))
    }
}

extension View {
    func card() -> some View { modifier(CardBackground()) }
}

/// A bordered button with red text for actions that delete or cut something
/// (macOS 13 does not colour `role: .destructive` on bordered buttons by itself).
struct DangerButton: View {
    let title: String
    let action: () -> Void
    @Environment(\.isEnabled) private var enabled
    init(_ title: String, action: @escaping () -> Void) { self.title = title; self.action = action }
    var body: some View {
        Button(role: .destructive, action: action) { Text(title).foregroundColor(enabled ? .red : nil) }
    }
}

/// Compact layout for short windows (the Windows app has the same rule below 760 px).
private struct CompactKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var compact: Bool {
        get { self[CompactKey.self] }
        set { self[CompactKey.self] = newValue }
    }
}

private struct PagePadding: ViewModifier {
    @Environment(\.compact) private var compact
    func body(content: Content) -> some View {
        content.padding(.horizontal, 20).padding(.top, compact ? 12 : 18).padding(.bottom, compact ? 12 : 18)
    }
}

extension View {
    func pagePadding() -> some View { modifier(PagePadding()) }
}

/// The app icon artwork (1024 canvas, macOS icon grid), drawn with shapes only so that
/// ImageRenderer can draw it for the .icns made by build.sh.
struct AppIconArt: View {
    var body: some View {
        AppMark(size: 824)
            .shadow(color: .black.opacity(0.35), radius: 18, y: 10)
            .frame(width: 1024, height: 1024)
    }
}
