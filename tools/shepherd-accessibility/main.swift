import AppKit
import ApplicationServices
import Foundation

// Accessibility-only observation helper. It reads the frontmost application's
// AX tree; it never captures pixels, makes a network request, or writes a file.
// Do not run it until the operator has approved the macOS Accessibility prompt.

private struct Options {
    var once = false
    var intervalMS = 1_000
    var depth = 12
    var maxNodes = 2_000
    var exclusionNonce: String?

    init(arguments: [String]) throws {
        var index = 0
        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--once": once = true
            case "--interval-ms":
                index += 1
                guard index < arguments.count, let value = Int(arguments[index]), (250...60_000).contains(value) else {
                    throw HelperError.usage("--interval-ms requires an integer from 250 through 60000")
                }
                intervalMS = value
            case "--depth":
                index += 1
                guard index < arguments.count, let value = Int(arguments[index]), (1...50).contains(value) else {
                    throw HelperError.usage("--depth requires an integer from 1 through 50")
                }
                depth = value
            case "--max-nodes":
                index += 1
                guard index < arguments.count, let value = Int(arguments[index]), (1...2_000).contains(value) else {
                    throw HelperError.usage("--max-nodes requires an integer from 1 through 2000")
                }
                maxNodes = value
            case "--exclude-nonce":
                index += 1
                guard index < arguments.count, arguments[index].count >= 16 else {
                    throw HelperError.usage("--exclude-nonce requires a per-session nonce of at least 16 characters")
                }
                exclusionNonce = arguments[index]
            case "--help", "-h": throw HelperError.usage(Options.usage)
            default: throw HelperError.usage("Unknown argument: \(argument)\n\n\(Options.usage)")
            }
            index += 1
        }
    }

    static let usage = """
    Usage: shepherd-accessibility [--once] [--interval-ms 250...60000] [--depth 1...50] [--max-nodes 1...2000] [--exclude-nonce nonce]

    Reads the frontmost application's Accessibility tree. Do not run until the
    operator has approved the macOS Accessibility prompt.
    """
}

private enum HelperError: LocalizedError {
    case usage(String)
    var errorDescription: String? { switch self { case .usage(let message): return message } }
}

private struct Node: Encodable {
    let role: String
    let text: String
    let x: Double
    let y: Double
    let w: Double
    let h: Double
}

private struct Observation: Encodable {
    let app: String?
    let bundleID: String?
    let windowTitle: String?
    let url: String?
    let urlStatus: String
    let text: String
    let nodes: [Node]
    let reason: String

    enum CodingKeys: String, CodingKey {
        case app
        case bundleID = "bundle_id"
        case windowTitle = "window_title"
        case url
        case urlStatus = "url_status"
        case text
        case nodes
        case reason
    }
}

private struct URLReading {
    let value: String?
    let status: String
}

private struct TreeReading {
    var nodes: [Node] = []
    var url = URLReading(value: nil, status: "absent")
}

private struct Fingerprint: Equatable {
    let bundleID: String?
    let title: String?
    let text: String
}

private func attribute<T>(_ element: AXUIElement, _ name: String) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success, let value else { return nil }
    return value as? T
}

private func elementText(_ element: AXUIElement) -> String? {
    for name in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
        if let value: String = attribute(element, name) {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
    }
    return nil
}

private func elementFrame(_ element: AXUIElement) -> CGRect {
    guard let position: AXValue = attribute(element, kAXPositionAttribute),
          let size: AXValue = attribute(element, kAXSizeAttribute) else { return .zero }
    var point = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position, .cgPoint, &point), AXValueGetValue(size, .cgSize, &dimensions) else { return .zero }
    return CGRect(origin: point, size: dimensions)
}

private func browserAddress(_ element: AXUIElement) -> URLReading? {
    let role: String = attribute(element, kAXRoleAttribute) ?? ""
    guard role == kAXTextFieldRole else { return nil }
    let labels = [kAXIdentifierAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXSubroleAttribute]
        .compactMap { (name: String) -> String? in attribute(element, name) }
        .joined(separator: " ").lowercased()
    guard labels.contains("address") || labels.contains("url") else { return nil }
    guard let value: String = attribute(element, kAXValueAttribute), !value.isEmpty else { return URLReading(value: nil, status: "absent") }
    guard value.count <= 2_048 else { return URLReading(value: nil, status: "too_long") }
    guard let components = URLComponents(string: value), let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https", components.host != nil else {
        return URLReading(value: nil, status: "absent")
    }
    return URLReading(value: value, status: "ok")
}

private func walk(_ element: AXUIElement, depth: Int, options: Options, reading: inout TreeReading) {
    guard depth <= options.depth, reading.nodes.count < options.maxNodes else { return }
    if reading.url.status == "absent", let address = browserAddress(element) { reading.url = address }
    if let value = elementText(element) {
        let box = elementFrame(element)
        let role: String = attribute(element, kAXRoleAttribute) ?? "AXUnknown"
        reading.nodes.append(Node(role: role, text: value, x: box.origin.x, y: box.origin.y, w: box.width, h: box.height))
    }
    let children: [AXUIElement] = attribute(element, kAXChildrenAttribute) ?? []
    for child in children { walk(child, depth: depth + 1, options: options, reading: &reading) }
}

private func isOwnWindow(_ title: String?, nonce: String?) -> Bool {
    guard let title, let nonce else { return false }
    // The marker includes an unguessable session nonce, so arbitrary page title
    // text cannot suppress its enclosing browser window.
    return title.hasSuffix("Shepherd \(nonce)")
}

private final class ChangeFlag {
    private var changed = true
    func markChanged() { changed = true }
    func takeChanged() -> Bool { defer { changed = false }; return changed }
}

private func observerCallback(_: AXObserver, _: AXUIElement, _: CFString, refcon: UnsafeMutableRawPointer?) {
    guard let refcon else { return }
    Unmanaged<ChangeFlag>.fromOpaque(refcon).takeUnretainedValue().markChanged()
}

private final class ChangeObserver {
    private let flag = ChangeFlag()
    private var observer: AXObserver?

    init(application: AXUIElement, pid: pid_t) {
        var created: AXObserver?
        guard AXObserverCreate(pid, observerCallback, &created) == .success, let created else { return }
        observer = created
        let refcon = Unmanaged.passUnretained(flag).toOpaque()
        _ = AXObserverAddNotification(created, application, kAXFocusedWindowChangedNotification as CFString, refcon)
        _ = AXObserverAddNotification(created, application, kAXFocusedUIElementChangedNotification as CFString, refcon)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(created), .defaultMode)
    }

    func takeChanged() -> Bool { flag.takeChanged() }
}

private func write(_ observation: Observation) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    guard let data = try? encoder.encode(observation) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

private func snapshot(options: Options) -> (Observation, Fingerprint, pid_t)? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    let application = AXUIElementCreateApplication(app.processIdentifier)
    guard let window: AXUIElement = attribute(application, kAXFocusedWindowAttribute) else { return nil }
    let title: String? = attribute(window, kAXTitleAttribute)
    guard !isOwnWindow(title, nonce: options.exclusionNonce) else { return nil }
    var reading = TreeReading()
    walk(window, depth: 0, options: options, reading: &reading)
    let ordered = reading.nodes.sorted { $0.y == $1.y ? $0.x < $1.x : $0.y < $1.y }
    let text = ordered.map(\.text).joined(separator: "\n")
    // An AX text field must identify itself as an address/URL field and carry a
    // complete HTTP(S) URL before it can become URL metadata. Other apps emit
    // null/absent, so an unavailable browser address is never guessed.
    let url = reading.url
    let observation = Observation(app: app.localizedName, bundleID: app.bundleIdentifier, windowTitle: title,
                                  url: url.value, urlStatus: url.status, text: text, nodes: ordered, reason: "interval")
    return (observation, Fingerprint(bundleID: app.bundleIdentifier, title: title, text: text), app.processIdentifier)
}

do {
    let options = try Options(arguments: Array(CommandLine.arguments.dropFirst()))
    var previous: Fingerprint?
    var lastEmission = Date.distantPast
    var observer: ChangeObserver?
    var observedPID: pid_t?

    repeat {
        let now = Date()
        if let (snapshot, fingerprint, pid) = snapshot(options: options) {
            if observedPID != pid {
                observedPID = pid
                let application = AXUIElementCreateApplication(pid)
                observer = ChangeObserver(application: application, pid: pid)
            }
            let changed = fingerprint != previous
            let notified = observer?.takeChanged() ?? false
            let due = now.timeIntervalSince(lastEmission) * 1_000 >= Double(options.intervalMS)
            if changed || notified || due {
                let reason = changed || notified ? "change" : "interval"
                write(Observation(app: snapshot.app, bundleID: snapshot.bundleID, windowTitle: snapshot.windowTitle,
                                  url: snapshot.url, urlStatus: snapshot.urlStatus, text: snapshot.text, nodes: snapshot.nodes, reason: reason))
                previous = fingerprint
                lastEmission = now
            }
        } else {
            previous = nil
        }
        if options.once { break }
        // AXObserver notifications are delivered on this run loop. The short
        // timeout also catches tree updates from apps that omit notifications.
        CFRunLoopRunInMode(.defaultMode, 0.25, true)
    } while true
} catch {
    FileHandle.standardError.write(Data("Accessibility helper usage error\n".utf8))
    exit(64)
}
