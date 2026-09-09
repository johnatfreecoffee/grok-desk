import AppKit

final class SearchFieldView: NSView, NSTextFieldDelegate {
    static let height: CGFloat = 32

    var onChange: ((String) -> Void)?
    var onSubmit: (() -> Void)?
    var onEscape: (() -> Void)?

    private let field = MenuFilterField()
    private let icon = NSImageView()
    private var focusToken = 0

    var query: String { field.stringValue }
    var isEditing: Bool { field.currentEditor() != nil }

    init(width: CGFloat) {
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: Self.height))
        wantsLayer = false

        let symbol = NSImage(systemSymbolName: "magnifyingglass", accessibilityDescription: "Search")
        icon.image = symbol?.withSymbolConfiguration(.init(pointSize: 12, weight: .medium))
        icon.contentTintColor = .secondaryLabelColor
        icon.imageScaling = .scaleProportionallyDown
        addSubview(icon)

        field.placeholderString = "Search"
        field.font = NSFont.menuFont(ofSize: 13)
        field.isBezeled = true
        field.bezelStyle = .roundedBezel
        field.isEditable = true
        field.isSelectable = true
        field.isBordered = true
        field.focusRingType = .none
        field.delegate = self
        field.refusesFirstResponder = false
        (field.cell as? NSTextFieldCell)?.isScrollable = true
        (field.cell as? NSTextFieldCell)?.sendsActionOnEndEditing = false
        field.target = self
        field.action = #selector(submit)
        addSubview(field)
        layout()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override var acceptsFirstResponder: Bool { true }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// NSMenu delivers mouse events to the item view, not hit-tested children.
    override func hitTest(_ point: NSPoint) -> NSView? {
        bounds.contains(point) ? self : nil
    }

    override func layout() {
        super.layout()
        let pad: CGFloat = 10
        let iconSize: CGFloat = 14
        let fieldHeight: CGFloat = 22
        let y = ((bounds.height - fieldHeight) / 2).rounded(.down)
        icon.frame = NSRect(x: pad, y: y + 4, width: iconSize, height: iconSize)
        let fieldX = icon.frame.maxX + 6
        field.frame = NSRect(
            x: fieldX,
            y: y,
            width: max(60, bounds.width - fieldX - pad),
            height: fieldHeight
        )
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window != nil else {
            focusToken += 1
            return
        }
        focusSoon()
    }

    override func mouseDown(with event: NSEvent) {
        focus()
        if let editor = field.currentEditor() {
            editor.mouseDown(with: event)
        }
    }

    override func mouseDragged(with event: NSEvent) {
        field.currentEditor()?.mouseDragged(with: event)
    }

    override func mouseUp(with event: NSEvent) {
        if let editor = field.currentEditor() {
            editor.mouseUp(with: event)
        } else {
            focus()
        }
    }

    override func keyDown(with event: NSEvent) {
        interpret(event)
    }

    func setQuery(_ value: String) {
        if field.stringValue != value {
            field.stringValue = value
        }
        if let editor = field.currentEditor() {
            editor.selectedRange = NSRange(location: (value as NSString).length, length: 0)
        }
    }

    func focusSoon() {
        focusToken += 1
        let token = focusToken
        DispatchQueue.main.async { [weak self] in
            guard let self, token == self.focusToken else { return }
            self.focus()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { [weak self] in
            guard let self, token == self.focusToken else { return }
            self.focus()
        }
    }

    func focus() {
        guard let window else { return }
        if !window.isKeyWindow {
            window.makeKey()
        }
        window.makeFirstResponder(field)
        if field.currentEditor() == nil {
            field.selectText(nil)
        }
        if let editor = field.currentEditor() {
            editor.selectedRange = NSRange(location: (field.stringValue as NSString).length, length: 0)
        }
    }

    func interpret(_ event: NSEvent) {
        if !isEditing { focus() }
        if isEditing {
            field.interpretKeyEvents([event])
            return
        }
        applyKeyWithoutEditor(event)
    }

    func controlTextDidChange(_ obj: Notification) {
        onChange?(field.stringValue)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            onSubmit?()
            return true
        }
        if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
            onEscape?()
            return true
        }
        return false
    }

    @objc private func submit() {
        onSubmit?()
    }

    private func applyKeyWithoutEditor(_ event: NSEvent) {
        switch event.keyCode {
        case 36, 76:
            onSubmit?()
        case 53:
            onEscape?()
        case 51:
            guard !field.stringValue.isEmpty else { return }
            field.stringValue = String(field.stringValue.dropLast())
            onChange?(field.stringValue)
        default:
            guard let chars = event.characters else { return }
            let filtered = chars.filter { ch in
                !ch.isNewline && ch != "\u{7f}" && ch.unicodeScalars.allSatisfy { $0.value >= 32 }
            }
            guard !filtered.isEmpty else { return }
            field.stringValue += filtered
            onChange?(field.stringValue)
        }
    }
}

final class MenuFilterField: NSTextField {
    override var acceptsFirstResponder: Bool { true }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        super.mouseDown(with: event)
    }

    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok, let editor = currentEditor() as? NSTextView {
            editor.insertionPointColor = .labelColor
        }
        return ok
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.contains(.command) {
            return super.performKeyEquivalent(with: event)
        }
        return false
    }
}
