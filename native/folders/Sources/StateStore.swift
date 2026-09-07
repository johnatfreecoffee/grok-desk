import Foundation

enum OpenMode: String, Codable, Sendable {
    case grok
    case terminal
}

struct AppState: Codable, Sendable {
    var lastPath: String
    var recents: [String]
    var defaultOpen: OpenMode
    var openOnHover: Bool

    static func fresh(documents: String) -> AppState {
        AppState(
            lastPath: documents,
            recents: [],
            defaultOpen: .grok,
            openOnHover: true
        )
    }
}

final class StateStore: @unchecked Sendable {
    private let url: URL
    private let scanner: FolderScanner
    private var state: AppState
    private let lock = NSLock()

    init(scanner: FolderScanner = FolderScanner()) {
        self.scanner = scanner
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("GrokFolders", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        self.url = root.appendingPathComponent("state.json")
        if let data = try? Data(contentsOf: url),
           let decoded = try? JSONDecoder().decode(AppState.self, from: data) {
            self.state = decoded
        } else {
            self.state = .fresh(documents: scanner.documents.path)
        }
        normalizeLocked()
    }

    var lastPath: String {
        get { lock.withLock { state.lastPath } }
        set {
            lock.withLock {
                state.lastPath = newValue
                rememberRecentLocked(newValue)
            }
            save()
        }
    }

    var recents: [String] {
        lock.withLock { state.recents }
    }

    var defaultOpen: OpenMode {
        get { lock.withLock { state.defaultOpen } }
        set {
            lock.withLock { state.defaultOpen = newValue }
            save()
        }
    }

    var openOnHover: Bool {
        get { lock.withLock { state.openOnHover } }
        set {
            lock.withLock { state.openOnHover = newValue }
            save()
        }
    }

    func lastURL() -> URL {
        lock.withLock {
            normalizeLocked()
            return URL(fileURLWithPath: state.lastPath, isDirectory: true)
        }
    }

    func remember(_ path: String) {
        lock.withLock {
            state.lastPath = path
            rememberRecentLocked(path)
        }
        save()
    }

    func save() {
        lock.withLock {
            guard let data = try? JSONEncoder().encode(state) else { return }
            try? data.write(to: url, options: .atomic)
        }
    }

    private func rememberRecentLocked(_ path: String) {
        var next = state.recents.filter { $0 != path }
        next.insert(path, at: 0)
        if next.count > 8 { next = Array(next.prefix(8)) }
        state.recents = next
    }

    private func normalizeLocked() {
        if scanner.resolvedDirectory(at: state.lastPath) == nil {
            state.lastPath = scanner.documents.path
        }
        state.recents = state.recents.compactMap { scanner.resolvedDirectory(at: $0)?.path }
        var seen = Set<String>()
        state.recents = state.recents.filter { seen.insert($0).inserted }
    }
}

private extension NSLock {
    func withLock<T>(_ body: () -> T) -> T {
        lock()
        defer { unlock() }
        return body()
    }
}
