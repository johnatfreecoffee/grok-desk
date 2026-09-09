import AppKit

private let popMenuNotification = Notification.Name("dev.freecoffee.GrokFolders.popMenu")

@MainActor
final class StatusController: NSObject, NSMenuDelegate {
    private let statusItem: NSStatusItem
    private let store: StateStore
    private let scanner: FolderScanner
    private var hoverTimer: Timer?
    private var hoverToken = 0
    private var isRebuilding = false
    private var filterQuery = ""
    private var menuWidth: CGFloat = 240
    private var firstMatchPath: String?
    private var searchView: SearchFieldView?
    private var keyMonitor: Any?

    init(store: StateStore, scanner: FolderScanner) {
        self.store = store
        self.scanner = scanner
        self.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()

        if let button = statusItem.button {
            button.image = StatusIcon.menuBar()
            button.imagePosition = .imageOnly
            button.toolTip = "Grok Folders"
        }

        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        statusItem.menu = menu

        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(popFromSecondLaunch),
            name: popMenuNotification,
            object: "GrokFolders"
        )
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu == statusItem.menu else { return }
        if isRebuilding { return }
        cancelHover()
        filterQuery = ""
        rebuildRoot(menu)
    }

    func menuWillOpen(_ menu: NSMenu) {
        guard menu == statusItem.menu else { return }
        installKeyMonitor()
        searchView?.focusSoon()
    }

    func menu(_ menu: NSMenu, willHighlight item: NSMenuItem?) {
        for entry in menu.items {
            entry.view?.needsDisplay = true
        }
        if item?.tag != MenuTag.folder.rawValue {
            cancelHover()
        }
        if item?.tag == MenuTag.search.rawValue {
            searchView?.focus()
        }
    }

    func menuDidClose(_ menu: NSMenu) {
        guard menu == statusItem.menu else { return }
        removeKeyMonitor()
        cancelHover()
        filterQuery = ""
        searchView?.setQuery("")
    }

    @objc private func popFromSecondLaunch() {
        statusItem.button?.performClick(nil)
    }

    func popMenu() {
        statusItem.button?.performClick(nil)
    }

    // MARK: - Build

    private func rebuildRoot(_ menu: NSMenu) {
        menu.removeAllItems()

        let current = store.lastURL()
        let kids = scanner.children(of: current)
        var titles = [current.lastPathComponent, "Home", "Documents", "Desktop", "Search"]
        titles.append(contentsOf: kids.map(\.lastPathComponent))
        if let parent = scanner.parent(of: current) {
            titles.append(parent.lastPathComponent)
        }
        let recents = store.recents.filter { $0 != current.path }
        titles.append(contentsOf: recents.map { URL(fileURLWithPath: $0).lastPathComponent })
        menuWidth = max(FolderRowView.width(for: titles), 240)

        let search = SearchFieldView(width: menuWidth)
        search.onChange = { [weak self] q in self?.applyFilter(q) }
        search.onSubmit = { [weak self] in self?.submitFirstMatch() }
        search.onEscape = { [weak self] in self?.handleEscape() }
        searchView = search

        let searchItem = NSMenuItem()
        searchItem.view = search
        searchItem.isEnabled = true
        searchItem.tag = MenuTag.search.rawValue
        menu.addItem(searchItem)

        rebuildBody(menu)
    }

    private func rebuildBody(_ menu: NSMenu) {
        while menu.items.count > 1 {
            menu.removeItem(at: menu.items.count - 1)
        }

        let current = store.lastURL()
        let query = filterQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let width = menuWidth
        let recents = store.recents.filter { $0 != current.path }

        menu.addItem(.separator())

        if query.isEmpty {
            firstMatchPath = nil
            menu.addItem(iconRow(current, kind: .current, width: width))
            menu.addItem(.separator())

            if let parent = scanner.parent(of: current) {
                menu.addItem(iconRow(parent, title: "↑  \(parent.lastPathComponent)", kind: .jump, width: width))
                menu.addItem(.separator())
            }

            let kids = scanner.children(of: current)
            firstMatchPath = kids.first?.path
            if kids.isEmpty {
                let empty = NSMenuItem(title: "No folders", action: nil, keyEquivalent: "")
                empty.isEnabled = false
                menu.addItem(empty)
            } else {
                for child in kids {
                    menu.addItem(iconRow(child, kind: .folder, width: width))
                }
            }

            menu.addItem(.separator())
            menu.addItem(iconRow(scanner.home, title: "Home", kind: .jump, width: width))
            menu.addItem(iconRow(scanner.documents, title: "Documents", kind: .jump, width: width))
            menu.addItem(iconRow(scanner.desktop, title: "Desktop", kind: .jump, width: width))

            if !recents.isEmpty {
                let recentsItem = NSMenuItem(title: "Recents", action: nil, keyEquivalent: "")
                recentsItem.isEnabled = true
                let recentsMenu = NSMenu()
                recentsMenu.autoenablesItems = false
                recentsMenu.delegate = self
                let recentTitles = recents.map { URL(fileURLWithPath: $0).lastPathComponent }
                let recentWidth = FolderRowView.width(for: recentTitles)
                for path in recents {
                    let url = URL(fileURLWithPath: path, isDirectory: true)
                    recentsMenu.addItem(iconRow(url, kind: .folder, width: recentWidth))
                }
                recentsItem.submenu = recentsMenu
                menu.addItem(recentsItem)
            }

            menu.addItem(.separator())
            addChrome(to: menu)
            return
        }

        var seen = Set<String>()
        var hits: [(url: URL, title: String?)] = []

        func consider(_ url: URL, title: String? = nil) {
            let path = url.standardizedFileURL.path
            guard seen.insert(path).inserted else { return }
            guard scanner.matches(url, query: query, title: title) else { return }
            hits.append((url, title))
        }

        for child in scanner.children(of: current) { consider(child) }
        if let parent = scanner.parent(of: current) {
            consider(parent, title: "↑  \(parent.lastPathComponent)")
        }
        consider(scanner.home, title: "Home")
        consider(scanner.documents, title: "Documents")
        consider(scanner.desktop, title: "Desktop")
        for path in recents {
            consider(URL(fileURLWithPath: path, isDirectory: true))
        }
        for child in scanner.children(of: scanner.documents) { consider(child) }
        for child in scanner.children(of: scanner.desktop) { consider(child) }

        hits.sort {
            let ra = scanner.rank($0.url, query: query)
            let rb = scanner.rank($1.url, query: query)
            if ra != rb { return ra < rb }
            return $0.url.lastPathComponent.localizedStandardCompare($1.url.lastPathComponent) == .orderedAscending
        }
        if hits.count > 40 { hits = Array(hits.prefix(40)) }

        firstMatchPath = hits.first?.url.path

        if hits.isEmpty {
            let empty = NSMenuItem(title: "No matches", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
            return
        }

        for (index, hit) in hits.enumerated() {
            let item = iconRow(hit.url, title: hit.title, kind: .folder, width: width)
            if index == 0 {
                (item.view as? FolderRowView)?.emphasized = true
            }
            menu.addItem(item)
        }
    }

    private func addChrome(to menu: NSMenu) {
        let hover = NSMenuItem(
            title: "Open on Hover",
            action: #selector(toggleHover),
            keyEquivalent: ""
        )
        hover.target = self
        hover.state = store.openOnHover ? .on : .off
        menu.addItem(hover)

        let login = NSMenuItem(
            title: loginTitle(),
            action: #selector(toggleLogin),
            keyEquivalent: ""
        )
        login.target = self
        login.state = LoginItem.isEnabled ? .on : .off
        menu.addItem(login)

        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Grok Folders", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    private func applyFilter(_ query: String) {
        guard query != filterQuery else { return }
        filterQuery = query
        guard let menu = statusItem.menu else { return }
        isRebuilding = true
        rebuildBody(menu)
        isRebuilding = false
        for entry in menu.items {
            entry.view?.needsDisplay = true
        }
        if searchView?.isEditing != true {
            searchView?.focus()
        }
    }

    private func submitFirstMatch() {
        guard let path = firstMatchPath else { return }
        launchGrok(path)
        statusItem.menu?.cancelTracking()
    }

    private func handleEscape() {
        if filterQuery.isEmpty {
            statusItem.menu?.cancelTracking()
            return
        }
        searchView?.setQuery("")
        applyFilter("")
    }

    private func installKeyMonitor() {
        removeKeyMonitor()
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            self?.routeKey(event) ?? event
        }
    }

    private func removeKeyMonitor() {
        if let keyMonitor {
            NSEvent.removeMonitor(keyMonitor)
            self.keyMonitor = nil
        }
    }

    private func routeKey(_ event: NSEvent) -> NSEvent? {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if flags.contains(.command) || flags.contains(.control) {
            return event
        }
        guard let search = searchView else { return event }
        if search.isEditing { return event }
        search.interpret(event)
        return nil
    }

    private func iconRow(_ url: URL, title: String? = nil, kind: FolderRowView.Kind, width: CGFloat) -> NSMenuItem {
        let name = title ?? url.lastPathComponent
        let item = NSMenuItem(title: name, action: nil, keyEquivalent: "")
        item.isEnabled = true
        item.tag = kind == .current ? MenuTag.action.rawValue : MenuTag.folder.rawValue
        item.representedObject = url.path
        item.toolTip = url.path

        let view = FolderRowView(
            title: name,
            folderImage: folderIcon(url.path),
            width: width,
            kind: kind,
            hoverEnabled: store.openOnHover && kind == .folder
        )
        let path = url.path
        view.onGrok = { [weak self] in self?.launchGrok(path) }
        view.onTerminal = { [weak self] in self?.launchTerminal(path) }
        view.onGoInto = { [weak self] in self?.goTo(path) }
        view.onNameHover = { [weak self] in self?.scheduleHoverOpen(path) }
        view.onHoverCancel = { [weak self] in self?.cancelHover() }
        item.view = view
        return item
    }

    private func item(_ title: String, action: Selector, path: String) -> NSMenuItem {
        let row = NSMenuItem(title: title, action: action, keyEquivalent: "")
        row.target = self
        row.representedObject = path
        row.isEnabled = true
        return row
    }

    private func folderIcon(_ path: String) -> NSImage {
        let icon = NSWorkspace.shared.icon(forFile: path).copy() as? NSImage ?? NSWorkspace.shared.icon(forFile: path)
        icon.size = NSSize(width: 16, height: 16)
        return icon
    }

    private func loginTitle() -> String {
        if LoginItem.needsApproval {
            return "Launch at Login (allow in Settings…)"
        }
        return "Launch at Login"
    }

    // MARK: - Hover

    private func scheduleHoverOpen(_ path: String) {
        hoverToken += 1
        let token = hoverToken
        let timer = Timer(timeInterval: 0.45, repeats: false) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self else { return }
                guard token == self.hoverToken else { return }
                self.launchGrok(path)
                self.statusItem.menu?.cancelTracking()
            }
        }
        hoverTimer = timer
        RunLoop.main.add(timer, forMode: .eventTracking)
        RunLoop.main.add(timer, forMode: .default)
    }

    private func cancelHover() {
        hoverToken += 1
        hoverTimer?.invalidate()
        hoverTimer = nil
    }

    // MARK: - Actions

    private func launchGrok(_ path: String) {
        cancelHover()
        store.remember(path)
        Launcher.openGrok(path)
    }

    private func launchTerminal(_ path: String) {
        cancelHover()
        store.remember(path)
        Launcher.openTerminal(path)
    }

    @objc private func goInto(_ sender: NSMenuItem) {
        cancelHover()
        guard let path = sender.representedObject as? String else { return }
        goTo(path)
    }

    @objc private func toggleHover() {
        store.openOnHover.toggle()
    }

    @objc private func toggleLogin() {
        if LoginItem.needsApproval {
            LoginItem.openSettings()
            return
        }
        if !LoginItem.setEnabled(!LoginItem.isEnabled) && !LoginItem.isEnabled {
            LoginItem.openSettings()
        }
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }

    private func goTo(_ path: String) {
        filterQuery = ""
        searchView?.setQuery("")
        store.lastPath = path
        guard let menu = statusItem.menu else { return }
        isRebuilding = true
        rebuildRoot(menu)
        isRebuilding = false
        for entry in menu.items {
            entry.view?.needsDisplay = true
        }
        searchView?.focusSoon()
    }
}

private enum MenuTag: Int {
    case search = 5
    case folder = 10
    case action = 20
    case nav = 30
}
