import Foundation
import Zharp

/// ZharpNative: what @zharp/react-native's JavaScript asks of the device (see the Android module
/// for the same, method by method).
///
/// - start: Zharp for iOS underneath (crashes, hangs), with React Native's RCTFatalException — a
///   fatal JS error the JS side saves as itself — left out, so a JS crash is counted once, and
///   URLSession left to the JS side, which traces fetch (React Native's fetch runs on URLSession).
/// - sessionId / setUser / clearUser / setTag: one session and one user for both sides.
/// - saveFatal / takeFatal: a fatal JS error on disk before the app dies, sent on the next launch.
@objc(ZharpNative)
final class ZharpNative: NSObject {
    @objc static func requiresMainQueueSetup() -> Bool { false }

    @objc func start(_ options: NSDictionary) -> NSString? {
        if !Zharp.isStarted {
            Zharp.start { o in
                o.key = options["key"] as? String ?? ""
                o.service = options["service"] as? String
                o.environment = options["environment"] as? String
                o.release = options["release"] as? String
                o.endpoint = options["endpoint"] as? String
                o.tracingOrigins = options["tracingOrigins"] as? [String] ?? []
                o.tracing = options["tracing"] as? Bool ?? true
                o.captureHeaders = options["captureHeaders"] as? Bool ?? true
                o.debug = options["debug"] as? Bool ?? false
                // JS records the screens (routes), the requests (fetch) and, when asked, the logs.
                o.trackScreens = false
                o.traceNetwork = false
                o.logs = false
                o.ignoreCrashTypes = ["RCTFatalException"]
            }
        }
        return Zharp.sessionId as NSString?
    }

    @objc func sessionId() -> NSString? {
        Zharp.sessionId as NSString?
    }

    @objc func setUser(_ id: NSString?, email: NSString?, name: NSString?) {
        guard let id = id as String?, !id.isEmpty else { return Zharp.clearUser() }
        Zharp.setUser(id: id, email: email as String?, name: name as String?)
    }

    @objc func clearUser() {
        Zharp.clearUser()
    }

    @objc func setTag(_ key: NSString, value: NSString?) {
        Zharp.setTag(key as String, value as String?)
    }

    @objc func saveFatal(_ body: NSString) -> NSNumber {
        guard let dir = Self.pendingDirectory() else { return false }
        let file = dir.appendingPathComponent("fatal-\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString).json")
        do {
            try (body as String).data(using: .utf8)?.write(to: file, options: .atomic)
            return true
        } catch {
            return false
        }
    }

    @objc func takeFatal() -> NSArray {
        guard let dir = Self.pendingDirectory(),
              let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return [] }
        var bodies: [String] = []
        for file in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            if let text = try? String(contentsOf: file, encoding: .utf8) { bodies.append(text) }
            try? FileManager.default.removeItem(at: file)
        }
        return bodies as NSArray
    }

    private static func pendingDirectory() -> URL? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let dir = base.appendingPathComponent("zharp-react-native", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}
