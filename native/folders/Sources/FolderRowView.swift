import AppKit

final class FolderRowView: NSView {
    enum Kind {
        case current
        case folder
        case jump
    }

    private let title: String
    private let folderImage: NSImage
    private let kind: Kind
    private let hoverEnabled: Bool
    private var lastHighlighted = false

    var onGrok: (() -> Void)?
    var onTerminal: (() -> Void)?
    var onGoInto: (() -> Void)?
    var onNameHover: (() -> Void)?
    var onHoverCancel: (() -> Void)?

    init(
        title: String,
        folderImage: NSImage,
        width: CGFloat,
        kind: Kind,
        hoverEnabled: Bool
    ) {
        self.title = title
        self.folderImage = folderImage
        self.kind = kind
        self.hoverEnabled = hoverEnabled
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: Metrics.height))
        folderImage.size = NSSize(width: Metrics.folder, height: Metrics.folder)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override var isFlipped: Bool { true }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        updateTrackingAreas()
    }

    override func mouseDown(with event: NSEvent) {}

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach { removeTrackingArea($0) }
        addTrackingArea(
            NSTrackingArea(
                rect: bounds,
                options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
                owner: self,
                userInfo: nil
            )
        )
    }

    override func draw(_ dirtyRect: NSRect) {
        let highlighted = enclosingMenuItem?.isHighlighted == true
        lastHighlighted = highlighted

        if highlighted {
            NSColor.selectedContentBackgroundColor.setFill()
            bounds.fill()
        }

        let iconTint = highlighted ? NSColor.selectedMenuItemTextColor : NSColor.secondaryLabelColor
        let textColor = highlighted ? NSColor.selectedMenuItemTextColor : NSColor.labelColor
        let grokTint = highlighted ? NSColor.selectedMenuItemTextColor : NSColor.systemBlue

        folderImage.draw(in: folderRect, from: .zero, operation: .sourceOver, fraction: 1)

        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.menuFont(ofSize: 13),
            .foregroundColor: textColor,
        ]
        let titleSize = (title as NSString).size(withAttributes: attrs)
        var drawRect = titleRect()
        drawRect.origin.y = ((bounds.height - titleSize.height) / 2).rounded(.down)
        drawRect.size.height = titleSize.height
        (title as NSString).draw(with: drawRect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attrs)

        if kind != .current {
            let chevron = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: "Go into")
            chevron?.withSymbolConfiguration(.init(pointSize: 11, weight: .semibold))?
                .tinted(iconTint)
                .draw(in: chevronRect)
        }

        StatusIcon.glyph(size: Metrics.icon, color: grokTint).draw(in: grokRect)
        Self.terminalAppIcon.draw(in: termRect, from: .zero, operation: .sourceOver, fraction: 1)
    }

    override func mouseUp(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if NSEvent.modifierFlags.contains(.option) {
            onHoverCancel?()
            enclosingMenuItem?.menu?.cancelTracking()
            onTerminal?()
            return
        }
        switch hit(point) {
        case .terminal:
            // Terminal.app icon = open Grok Build in Terminal (same as Finder → Open in Grok).
            onHoverCancel?()
            enclosingMenuItem?.menu?.cancelTracking()
            onGrok?()
        case .into:
            onHoverCancel?()
            onGoInto?()
        case .grok, .name:
            onHoverCancel?()
            enclosingMenuItem?.menu?.cancelTracking()
            onGrok?()
        case .none:
            break
        }
    }

    override func mouseEntered(with event: NSEvent) {
        handleHover(at: convert(event.locationInWindow, from: nil))
        needsDisplay = true
    }

    override func mouseMoved(with event: NSEvent) {
        handleHover(at: convert(event.locationInWindow, from: nil))
        if enclosingMenuItem?.isHighlighted != lastHighlighted {
            needsDisplay = true
        }
    }

    override func mouseExited(with event: NSEvent) {
        onHoverCancel?()
    }

    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        needsDisplay = true
    }

    static func width(for titles: [String]) -> CGFloat {
        let font = NSFont.menuFont(ofSize: 13)
        let longest = titles
            .map { ($0 as NSString).size(withAttributes: [.font: font]).width }
            .max() ?? 80
        let name = min(max(ceil(longest), 72), 280)
        return Metrics.leading + Metrics.folder + Metrics.gap + name + 12
            + Metrics.chevron + 12
            + Metrics.icon + Metrics.iconGap + Metrics.icon + Metrics.trailing
    }

    private func handleHover(at point: NSPoint) {
        guard hoverEnabled, kind != .current else {
            onHoverCancel?()
            return
        }
        switch hit(point) {
        case .name:
            onNameHover?()
        default:
            onHoverCancel?()
        }
    }

    private enum Hit { case name, grok, terminal, into, none }

    private func hit(_ point: NSPoint) -> Hit {
        if kind != .current, chevronHit.contains(point) { return .into }
        if termRect.contains(point) { return .terminal }
        if bounds.contains(point) { return .name }
        return .none
    }

    private var folderRect: NSRect {
        NSRect(
            x: Metrics.leading,
            y: ((bounds.height - Metrics.folder) / 2).rounded(.down),
            width: Metrics.folder,
            height: Metrics.folder
        )
    }

    private func titleRect() -> NSRect {
        let x = Metrics.leading + Metrics.folder + Metrics.gap
        let maxX = chevronRect.minX - 8
        return NSRect(x: x, y: 0, width: max(0, maxX - x), height: bounds.height)
    }

    private var termRect: NSRect {
        NSRect(
            x: bounds.width - Metrics.trailing - Metrics.icon,
            y: ((bounds.height - Metrics.icon) / 2).rounded(.down),
            width: Metrics.icon,
            height: Metrics.icon
        )
    }

    private var grokRect: NSRect {
        NSRect(
            x: termRect.minX - Metrics.iconGap - Metrics.icon,
            y: termRect.minY,
            width: Metrics.icon,
            height: Metrics.icon
        )
    }

    private var chevronRect: NSRect {
        NSRect(
            x: grokRect.minX - 12 - Metrics.chevron,
            y: ((bounds.height - Metrics.chevron) / 2).rounded(.down),
            width: Metrics.chevron,
            height: Metrics.chevron
        )
    }

    private var chevronHit: NSRect { chevronRect.insetBy(dx: -8, dy: -5) }

    private static let terminalAppIcon: NSImage = {
        let icon = NSWorkspace.shared.icon(forFile: "/System/Applications/Utilities/Terminal.app")
        icon.size = NSSize(width: Metrics.icon, height: Metrics.icon)
        return icon
    }()
}

private enum Metrics {
    static let height: CGFloat = 24
    static let leading: CGFloat = 12
    static let folder: CGFloat = 16
    static let gap: CGFloat = 6
    static let icon: CGFloat = 16
    static let iconGap: CGFloat = 12
    static let chevron: CGFloat = 10
    static let trailing: CGFloat = 12
}

private extension NSImage {
    func tinted(_ color: NSColor) -> NSImage {
        let out = NSImage(size: size, flipped: false) { [self] rect in
            self.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
            color.set()
            rect.fill(using: .sourceIn)
            return true
        }
        return out
    }
}
