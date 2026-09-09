import AppKit

final class SearchFieldView: NSView, NSTextFieldDelegate {
    static let height: CGFloat = 32

    var onChange: ((String) -> Void)?
    var onSubmit: (() -> Void)?
    var onEscape: (() -> Void)?

    private let field = MenuFilterField()
    private let icon = NSImageView()
    private let caret = BlinkCaretView()
    private var focusToken = 0
    private var caretTimer: Timer?

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
        addSubview(caret)
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
        layoutCaret()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window != nil else {
            focusToken += 1
            stopCaret()
            return
        }
        focusSoon()
    }

    override func mouseDown(with event: NSEvent) {
        focus()
        if let editor = field.currentEditor() {
            editor.mouseDown(with: event)
        }
        syncCaret()
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
        syncCaret()
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
        layoutCaret()
    }

    func focusSoon() {
        focusToken += 1
        let token = focusToken
        startCaret()
        for delay in [0.0, 0.02, 0.06, 0.12, 0.28] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, token == self.focusToken else { return }
                self.focus()
                self.syncCaret()
            }
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
        syncCaret()
    }

    func interpret(_ event: NSEvent) {
        if !isEditing { focus() }
        if isEditing {
            field.interpretKeyEvents([event])
            return
        }
        applyKeyWithoutEditor(event)
        syncCaret()
    }

    func handleCommand(_ event: NSEvent) -> Bool {
        guard let chars = event.charactersIgnoringModifiers?.lowercased() else { return false }
        switch chars {
        case "a":
            focus()
            if let editor = field.currentEditor() {
                editor.selectAll(nil)
            } else {
                field.selectText(nil)
            }
            return true
        case "c":
            copyString(selectedOrAll())
            return true
        case "x":
            let text = selectedOrAll()
            copyString(text)
            replaceSelection("")
            return true
        case "v":
            let paste = NSPasteboard.general.string(forType: .string) ?? ""
            replaceSelection(paste)
            return true
        default:
            return false
        }
    }

    func controlTextDidChange(_ obj: Notification) {
        onChange?(field.stringValue)
        layoutCaret()
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
        layoutCaret()
    }

    private func selectedOrAll() -> String {
        if let editor = field.currentEditor() {
            let range = editor.selectedRange
            if range.length > 0 {
                return (editor.string as NSString).substring(with: range)
            }
        }
        return field.stringValue
    }

    private func replaceSelection(_ insert: String) {
        focus()
        if let editor = field.currentEditor() as? NSTextView {
            let range = editor.selectedRange
            if editor.shouldChangeText(in: range, replacementString: insert) {
                editor.replaceCharacters(in: range, with: insert)
                editor.didChangeText()
            }
        } else {
            field.stringValue = insert
        }
        onChange?(field.stringValue)
        layoutCaret()
    }

    private func copyString(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
    }

    private func layoutCaret() {
        let inset: CGFloat = 8
        let height: CGFloat = 14
        let text = field.stringValue
        let font = field.font ?? NSFont.menuFont(ofSize: 13)
        let textWidth = (text as NSString).size(withAttributes: [.font: font]).width
        let x = field.frame.minX + inset + min(textWidth, max(0, field.frame.width - inset * 2 - 2))
        let y = field.frame.minY + ((field.frame.height - height) / 2).rounded(.down)
        caret.frame = NSRect(x: x, y: y, width: 1.5, height: height)
    }

    private func startCaret() {
        stopCaret()
        caret.lit = true
        syncCaret()
        let timer = Timer(timeInterval: 0.53, repeats: true) { [weak self] _ in
            guard let self else { return }
            if self.isEditing {
                self.caret.isHidden = true
                return
            }
            self.caret.lit.toggle()
            self.caret.isHidden = !self.caret.lit
        }
        RunLoop.main.add(timer, forMode: .eventTracking)
        RunLoop.main.add(timer, forMode: .default)
        RunLoop.main.add(timer, forMode: .common)
        caretTimer = timer
    }

    private func stopCaret() {
        caretTimer?.invalidate()
        caretTimer = nil
        caret.isHidden = true
    }

    private func syncCaret() {
        layoutCaret()
        if isEditing {
            caret.isHidden = true
        } else {
            caret.lit = true
            caret.isHidden = false
        }
    }
}

final class BlinkCaretView: NSView {
    var lit = true {
        didSet { needsDisplay = true }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard lit else { return }
        NSColor.labelColor.setFill()
        bounds.fill()
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
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard flags.contains(.command), let chars = event.charactersIgnoringModifiers?.lowercased() else {
            return false
        }
        switch chars {
        case "a":
            currentEditor()?.selectAll(nil)
            return true
        case "c":
            currentEditor()?.copy(nil)
            return true
        case "v":
            currentEditor()?.paste(nil)
            return true
        case "x":
            currentEditor()?.cut(nil)
            return true
        default:
            return super.performKeyEquivalent(with: event)
        }
    }
}
