import AppKit
import Foundation

enum LoginItem {
    static let label = "dev.freecoffee.GrokFolders"

    static var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    static var binaryURL: URL {
        Bundle.main.executableURL
            ?? Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/GrokFolders")
    }

    static var isEnabled: Bool {
        FileManager.default.fileExists(atPath: plistURL.path) && !isDisabled()
    }

    static var needsApproval: Bool { false }

    static func ensureInstalled() {
        let existed = FileManager.default.fileExists(atPath: plistURL.path)
        writePlist()
        if !existed {
            _ = setEnabled(true)
        }
    }

    @discardableResult
    static func setEnabled(_ on: Bool) -> Bool {
        writePlist()
        let uid = getuid()
        let target = "gui/\(uid)/\(label)"
        if on {
            _ = run("/bin/launchctl", ["enable", target])
            if !loaded() {
                _ = run("/bin/launchctl", ["bootstrap", "gui/\(uid)", plistURL.path])
            }
            return isEnabled
        }
        _ = run("/bin/launchctl", ["disable", target])
        return !isEnabled
    }

    static func openSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension") {
            NSWorkspace.shared.open(url)
        }
    }

    private static func loaded() -> Bool {
        run("/bin/launchctl", ["print", "gui/\(getuid())/\(label)"]) == 0
    }

    private static func isDisabled() -> Bool {
        let out = capture("/bin/launchctl", ["print-disabled", "gui/\(getuid())"])
        for raw in out.split(whereSeparator: \.isNewline) {
            let line = String(raw)
            guard line.contains(label) else { continue }
            return line.contains("=> disabled")
        }
        return false
    }

    private static func writePlist() {
        let bin = binaryURL.path
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let logs = "\(home)/Library/Logs/GrokFolders"
        try? FileManager.default.createDirectory(atPath: logs, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>\(label)</string>
          <key>ProgramArguments</key>
          <array>
            <string>\(bin)</string>
          </array>
          <key>RunAtLoad</key>
          <true/>
          <key>KeepAlive</key>
          <dict>
            <key>SuccessfulExit</key>
            <false/>
          </dict>
          <key>ThrottleInterval</key>
          <integer>3</integer>
          <key>StandardOutPath</key>
          <string>\(logs)/out.log</string>
          <key>StandardErrorPath</key>
          <string>\(logs)/err.log</string>
          <key>EnvironmentVariables</key>
          <dict>
            <key>HOME</key>
            <string>\(home)</string>
            <key>PATH</key>
            <string>/usr/bin:/bin:/usr/sbin:/sbin:\(home)/.grok/bin</string>
          </dict>
          <key>ProcessType</key>
          <string>Interactive</string>
        </dict>
        </plist>
        """
        try? plist.write(to: plistURL, atomically: true, encoding: .utf8)
    }

    @discardableResult
    private static func run(_ launchPath: String, _ arguments: [String]) -> Int32 {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: launchPath)
        task.arguments = arguments
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        do {
            try task.run()
            task.waitUntilExit()
            return task.terminationStatus
        } catch {
            return 1
        }
    }

    private static func capture(_ launchPath: String, _ arguments: [String]) -> String {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: launchPath)
        task.arguments = arguments
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do {
            try task.run()
            task.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8) ?? ""
        } catch {
            return ""
        }
    }
}
