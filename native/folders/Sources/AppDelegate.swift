import AppKit

private let bundleID = "dev.freecoffee.GrokFolders"
private let popMenuNotification = Notification.Name("dev.freecoffee.GrokFolders.popMenu")

@main
enum GrokFoldersMain {
    static func main() {
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
        if !others.isEmpty {
            DistributedNotificationCenter.default().postNotificationName(
                popMenuNotification,
                object: "GrokFolders",
                userInfo: nil,
                deliverImmediately: true
            )
            return
        }

        let app = NSApplication.shared
        let delegate = AppDelegate.shared
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    static let shared = AppDelegate()

    private var status: StatusController?
    private let store = StateStore()
    private let scanner = FolderScanner()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        status = StatusController(store: store, scanner: scanner)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        status?.popMenu()
        return false
    }
}
