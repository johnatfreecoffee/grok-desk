import AppKit
import Foundation

enum Launcher {
    static var grokBin: String {
        NSString(string: "~/.grok/bin/grok").expandingTildeInPath
    }

    static var openInGrok: String {
        NSString(string: "~/.grok/bin/open-in-grok").expandingTildeInPath
    }

    static func openGrok(_ path: String) {
        log("GROK \(path)")
        let script = openInGrok
        if FileManager.default.isExecutableFile(atPath: script) {
            DispatchQueue.global(qos: .userInitiated).async {
                let task = Process()
                task.executableURL = URL(fileURLWithPath: "/bin/zsh")
                task.arguments = [script, path]
                var env = ProcessInfo.processInfo.environment
                env["HOME"] = NSHomeDirectory()
                env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:\(NSHomeDirectory())/.grok/bin"
                task.environment = env
                task.standardOutput = FileHandle.nullDevice
                task.standardError = FileHandle.nullDevice
                try? task.run()
            }
            return
        }
        runOsascript(openGrokSource, argument: path)
    }

    static func openTerminal(_ path: String) {
        log("TERM \(path)")
        runOsascript(openTerminalSource, argument: path)
    }

    static func reveal(_ path: String) {
        NSWorkspace.shared.open(URL(fileURLWithPath: path, isDirectory: true))
    }

    private static let openGrokSource = """
    on run argv
      set theDir to item 1 of argv
      tell application "Terminal"
        activate
        do script "export PATH=\\"$HOME/.grok/bin:$PATH\\"; cd " & quoted form of theDir & " && exec grok --cwd " & quoted form of theDir
      end tell
    end run
    """

    private static let openTerminalSource = """
    on run argv
      set theDir to item 1 of argv
      tell application "Terminal"
        activate
        do script "export PATH=\\"$HOME/.grok/bin:$PATH\\"; cd " & quoted form of theDir
      end tell
    end run
    """

    private static func runOsascript(_ source: String, argument: String) {
        DispatchQueue.global(qos: .userInitiated).async {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            task.arguments = ["-l", "AppleScript", "-", argument]
            let input = Pipe()
            let err = Pipe()
            task.standardInput = input
            task.standardOutput = FileHandle.nullDevice
            task.standardError = err
            var env = ProcessInfo.processInfo.environment
            env["HOME"] = NSHomeDirectory()
            env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:\(NSHomeDirectory())/.grok/bin"
            task.environment = env
            do {
                try task.run()
                input.fileHandleForWriting.write(source.data(using: .utf8)!)
                input.fileHandleForWriting.closeFile()
                task.waitUntilExit()
                if task.terminationStatus != 0 {
                    let msg = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                    log("osascript fail \(task.terminationStatus) \(msg)")
                }
            } catch {
                log("osascript error \(error)")
            }
        }
    }

    private static func log(_ line: String) {
        let dir = NSHomeDirectory() + "/Library/Logs/GrokFolders"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let path = dir + "/actions.log"
        let stamp = ISO8601DateFormatter().string(from: Date())
        let text = "\(stamp) \(line)\n"
        guard let data = text.data(using: .utf8) else { return }
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: data)
            return
        }
        if let handle = try? FileHandle(forWritingTo: URL(fileURLWithPath: path)) {
            defer { try? handle.close() }
            try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        }
    }
}
