import AppKit
import Foundation

// A local, non-activating concern banner. It receives only the companion's
// spoken template and a policy label; it never reads screen content or network.

private enum Usage: Error { case invalid }

private struct Options {
    let text: String
    let pattern: String
    let title: String
    let timeout: TimeInterval

    init(arguments: [String]) throws {
        var values: [String: String] = [:]
        var index = 0
        while index < arguments.count {
            let flag = arguments[index]
            guard ["--text", "--pattern", "--title", "--timeout"].contains(flag), index + 1 < arguments.count else { throw Usage.invalid }
            index += 1
            guard values[flag] == nil else { throw Usage.invalid }
            values[flag] = arguments[index]
            index += 1
        }
        guard let text = values["--text"], !text.isEmpty, text.count <= 512,
              let pattern = values["--pattern"], !pattern.isEmpty, pattern.count <= 96,
              let title = values["--title"], Self.hasSessionNonce(title),
              let timeoutText = values["--timeout"], let timeout = TimeInterval(timeoutText), (1...120).contains(timeout) else { throw Usage.invalid }
        self.text = text
        self.pattern = pattern
        self.title = title
        self.timeout = timeout
    }

    private static func hasSessionNonce(_ title: String) -> Bool {
        guard let marker = title.range(of: "Shepherd ", options: .backwards) else { return false }
        let nonce = title[marker.upperBound...]
        return nonce.count >= 16 && !nonce.contains(where: { $0.isWhitespace })
    }
}

private final class AlertPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class BannerController: NSObject {
    private let options: Options
    private var panel: AlertPanel?
    private var completed = false

    init(options: Options) { self.options = options }

    func show() {
        let size = NSSize(width: 680, height: 244)
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: size.width, height: size.height)
        let frame = NSRect(x: screen.midX - size.width / 2, y: screen.maxY - size.height - 28, width: size.width, height: size.height)
        let panel = AlertPanel(contentRect: frame, styleMask: [.nonactivatingPanel, .fullSizeContentView], backing: .buffered, defer: false)
        panel.title = options.title
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = NSColor.windowBackgroundColor

        let content = NSView(frame: NSRect(origin: .zero, size: size))
        let label = NSTextField(wrappingLabelWithString: options.text)
        label.font = .systemFont(ofSize: 28, weight: .semibold)
        label.textColor = .labelColor
        label.maximumNumberOfLines = 3
        label.frame = NSRect(x: 32, y: 88, width: size.width - 64, height: 124)
        label.alignment = .center
        content.addSubview(label)

        let detail = NSTextField(labelWithString: options.pattern.replacingOccurrences(of: "_", with: " "))
        detail.font = .systemFont(ofSize: 14, weight: .medium)
        detail.textColor = .secondaryLabelColor
        detail.alignment = .center
        detail.frame = NSRect(x: 32, y: 65, width: size.width - 64, height: 18)
        content.addSubview(detail)

        let call = NSButton(title: "Call family", target: self, action: #selector(callFamily))
        call.bezelStyle = .rounded
        call.keyEquivalent = ""
        call.frame = NSRect(x: 175, y: 20, width: 150, height: 32)
        content.addSubview(call)
        let fine = NSButton(title: "I'm fine", target: self, action: #selector(fine))
        fine.bezelStyle = .rounded
        fine.keyEquivalent = ""
        fine.frame = NSRect(x: 355, y: 20, width: 150, height: 32)
        content.addSubview(fine)

        panel.contentView = content
        self.panel = panel
        panel.orderFrontRegardless()
        DispatchQueue.main.asyncAfter(deadline: .now() + options.timeout) { [weak self] in self?.finish("timeout") }
    }

    @objc private func callFamily() { finish("call") }
    @objc private func fine() { finish("fine") }

    private func finish(_ action: String) {
        guard !completed else { return }
        completed = true
        panel?.close()
        print("{\"action\":\"\(action)\"}")
        fflush(stdout)
        NSApplication.shared.terminate(nil)
    }
}

do {
    let options = try Options(arguments: Array(CommandLine.arguments.dropFirst()))
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let controller = BannerController(options: options)
    controller.show()
    app.run()
} catch {
    FileHandle.standardError.write(Data("Usage: shepherd-banner --text TEXT --pattern LABEL --title '... Shepherd NONCE' --timeout SECONDS\n".utf8))
    exit(64)
}
