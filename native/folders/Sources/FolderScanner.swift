import Foundation

struct FolderScanner {
    static let skipNames: Set<String> = [
        "node_modules", ".git", "dist", "build", ".next", "coverage",
        "__pycache__", "DerivedData", ".venv", "venv", "target",
        ".cache", ".turbo", ".output", "Pods", ".gradle",
        "vendor", ".build", ".DS_Store", "Carthage",
        ".swiftpm", ".terraform", ".npm", ".yarn",
    ]

    let fileManager: FileManager

    init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
    }

    var home: URL {
        fileManager.homeDirectoryForCurrentUser.standardizedFileURL
    }

    var documents: URL {
        home.appendingPathComponent("Documents", isDirectory: true)
    }

    var desktop: URL {
        home.appendingPathComponent("Desktop", isDirectory: true)
    }

    func isAllowedRoot(_ url: URL) -> Bool {
        let path = url.standardizedFileURL.path
        let homePath = home.path
        return path == homePath || path.hasPrefix(homePath + "/")
    }

    func parent(of url: URL) -> URL? {
        let parent = url.deletingLastPathComponent().standardizedFileURL
        guard isAllowedRoot(parent) else { return nil }
        if parent.path == url.standardizedFileURL.path { return nil }
        return parent
    }

    func resolvedDirectory(at path: String) -> URL? {
        var isDir: ObjCBool = false
        let url = URL(fileURLWithPath: path).standardizedFileURL
        guard fileManager.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue else {
            return nil
        }
        guard isAllowedRoot(url) else { return nil }
        return url
    }

    func children(of url: URL, limit: Int = 80) -> [URL] {
        let keys: [URLResourceKey] = [
            .isDirectoryKey, .isHiddenKey, .isSymbolicLinkKey, .isPackageKey, .localizedNameKey,
        ]
        guard let list = try? fileManager.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: keys,
            options: [.skipsHiddenFiles]
        ) else { return [] }

        var dirs: [URL] = []
        dirs.reserveCapacity(min(limit, list.count))
        for item in list {
            guard dirs.count < limit else { break }
            guard shouldInclude(item) else { continue }
            dirs.append(item.standardizedFileURL)
        }
        dirs.sort {
            $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending
        }
        return dirs
    }

    func matches(_ url: URL, query: String, title: String? = nil) -> Bool {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if q.isEmpty { return true }
        let opts: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
        if let title, title.range(of: q, options: opts) != nil { return true }
        if url.lastPathComponent.range(of: q, options: opts) != nil { return true }
        let homePath = home.path
        let path = url.path
        let rel = path.hasPrefix(homePath + "/") ? String(path.dropFirst(homePath.count + 1)) : path
        return rel.range(of: q, options: opts) != nil
    }

    func rank(_ url: URL, query: String) -> Int {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let name = url.lastPathComponent.lowercased()
        if name == q { return 0 }
        if name.hasPrefix(q) { return 1 }
        if name.contains(q) { return 2 }
        return 3
    }

    func shouldInclude(_ url: URL) -> Bool {
        let name = url.lastPathComponent
        if name.hasPrefix(".") { return false }
        if Self.skipNames.contains(name) { return false }
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isHiddenKey, .isPackageKey, .isSymbolicLinkKey])
        if values?.isHidden == true { return false }
        if values?.isPackage == true { return false }
        if values?.isDirectory == true { return true }
        if values?.isSymbolicLink == true {
            var isDir: ObjCBool = false
            if fileManager.fileExists(atPath: url.path, isDirectory: &isDir) {
                return isDir.boolValue
            }
        }
        return false
    }
}
