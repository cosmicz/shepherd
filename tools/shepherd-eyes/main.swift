import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Vision

private struct Crop: Equatable {
    let x: Int
    let y: Int
    let width: Int
    let height: Int

    init(argument: String) throws {
        let parts = argument.split(separator: ",", omittingEmptySubsequences: false)
        guard parts.count == 4,
              let x = Int(parts[0]), let y = Int(parts[1]),
              let width = Int(parts[2]), let height = Int(parts[3]),
              x >= 0, y >= 0, width > 0, height > 0 else {
            throw HelperError.usage("--crop requires x,y,width,height in display pixels")
        }
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

private struct Options {
    var once = false
    var framesPerSecond: Double = 1
    var includedBundleID: String?
    var exclusionNonce: String?
    var crop: Crop?
    var cropOutput: URL?

    init(arguments: [String]) throws {
        var index = 0
        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--once":
                once = true
            case "--fps":
                index += 1
                guard index < arguments.count, let parsed = Double(arguments[index]), (0.1...10).contains(parsed) else {
                    throw HelperError.usage("--fps requires a number from 0.1 through 10")
                }
                framesPerSecond = parsed
            case "--include-app":
                index += 1
                guard index < arguments.count else {
                    throw HelperError.usage("--include-app requires a bundle identifier")
                }
                includedBundleID = arguments[index]
            case "--exclude-nonce":
                index += 1
                guard index < arguments.count, arguments[index].count >= 16 else {
                    throw HelperError.usage("--exclude-nonce requires a per-session nonce of at least 16 characters")
                }
                exclusionNonce = arguments[index]
            case "--crop":
                index += 1
                guard index < arguments.count else {
                    throw HelperError.usage("--crop requires x,y,width,height in display pixels")
                }
                crop = try Crop(argument: arguments[index])
            case "--crop-output":
                index += 1
                guard index < arguments.count, !arguments[index].isEmpty else {
                    throw HelperError.usage("--crop-output requires a caller-provided PNG path")
                }
                cropOutput = URL(fileURLWithPath: arguments[index])
            case "--help", "-h":
                throw HelperError.usage(Options.usage)
            default:
                throw HelperError.usage("Unknown argument: \(argument)\n\n\(Options.usage)")
            }
            index += 1
        }
        if crop != nil && cropOutput == nil { throw HelperError.usage("--crop requires --crop-output") }
        if crop == nil && cropOutput != nil { throw HelperError.usage("--crop-output requires --crop") }
    }

    static let usage = """
    Usage: shepherd-eyes [--once] [--fps 0.1...10] [--include-app bundle.id] [--exclude-nonce nonce] [--crop x,y,width,height --crop-output path]

    Captures the main display and the frontmost window in memory on each tick.
    --crop writes a display region only to the explicit --crop-output path.
    Do not run until Screen Recording permission has been approved.
    """
}

private enum HelperError: LocalizedError {
    case usage(String)
    case unavailable(String)

    var errorDescription: String? {
        switch self {
        case .usage(let message), .unavailable(let message):
            return message
        }
    }

    var kind: String {
        switch self {
        case .usage: return "usage"
        case .unavailable: return "unavailable"
        }
    }
}

private struct TextLine: Encodable {
    let text: String
    let x: Double
    let y: Double
    let w: Double
    let h: Double
}

private struct FrameLine: Encodable {
    let frameID: String
    let capturedAt: String
    let app: String?
    let bundleID: String?
    let windowTitle: String?
    let url: String?
    let windowText: String
    let windowLines: [TextLine]
    let windowWidth: Int
    let windowHeight: Int
    let displayText: String
    let displayLines: [TextLine]
    let displayWidth: Int
    let displayHeight: Int
    let captureMS: Int
    let ocrMS: Int
    let excludedWindows: Int
    let reason: String

    enum CodingKeys: String, CodingKey {
        case frameID = "frame_id"
        case capturedAt = "captured_at"
        case app
        case bundleID = "bundle_id"
        case windowTitle = "window_title"
        case url
        case windowText = "window_text"
        case windowLines = "window_lines"
        case windowWidth = "window_width"
        case windowHeight = "window_height"
        case displayText = "display_text"
        case displayLines = "display_lines"
        case displayWidth = "display_width"
        case displayHeight = "display_height"
        case captureMS = "capture_ms"
        case ocrMS = "ocr_ms"
        case excludedWindows = "excluded_windows"
        case reason
    }
}

private struct ErrorLine: Encodable {
    let kind: String
    let message: String
}

private struct FrontmostContext {
    let appName: String?
    let bundleID: String?
    let window: SCWindow?
    let title: String?
    let url: String?
}

private struct Fingerprint: Equatable {
    let windowID: UInt32?
    let title: String?
    let imageHash: UInt64
}

private final class StopFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false

    func requestStop() {
        lock.lock()
        stopped = true
        lock.unlock()
    }

    var isStopped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }
}

private final class JSONLines {
    private let encoder: JSONEncoder = {
        let value = JSONEncoder()
        value.outputFormatting = [.withoutEscapingSlashes]
        return value
    }()

    func write<T: Encodable>(_ value: T, to handle: FileHandle) {
        guard let encoded = try? encoder.encode(value) else { return }
        handle.write(encoded)
        handle.write(Data("\n".utf8))
    }
}

private final class EyesHelper {
    private let options: Options
    private let output = JSONLines()
    private let stopFlag = StopFlag()
    private var previousFingerprint: Fingerprint?
    private var lastEmission = Date.distantPast

    init(options: Options) {
        self.options = options
    }

    func run() async {
        let signalSource = installTerminationHandler()
        defer { signalSource.cancel() }

        repeat {
            do {
                try await captureAndEmitIfChanged()
            } catch {
                writeError(error)
            }

            if options.once || stopFlag.isStopped { break }
            try? await Task.sleep(for: .seconds(1 / options.framesPerSecond))
        } while !stopFlag.isStopped
    }

    private func installTerminationHandler() -> DispatchSourceSignal {
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global(qos: .userInitiated))
        source.setEventHandler { [stopFlag] in stopFlag.requestStop() }
        source.resume()
        return source
    }

    private func captureAndEmitIfChanged() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let frontmost = frontmostContext(content: content)

        if let requestedBundleID = options.includedBundleID, frontmost.bundleID != requestedBundleID {
            return
        }

        let filters = try filters(for: content, frontmost: frontmost)
        let captureStart = ContinuousClock.now
        let windowImage = try await SCScreenshotManager.captureImage(
            contentFilter: filters.window,
            configuration: screenshotConfiguration(for: filters.window)
        )
        let displayImage = try await SCScreenshotManager.captureImage(
            contentFilter: filters.display,
            configuration: screenshotConfiguration(for: filters.display)
        )
        let captureMS = milliseconds(since: captureStart)
        let fingerprint = Fingerprint(
            windowID: frontmost.window.map { UInt32($0.windowID) },
            title: frontmost.title,
            imageHash: downscaledHash(windowImage) ^ downscaledHash(displayImage)
        )
        let changed = fingerprint != previousFingerprint
        guard changed || Date().timeIntervalSince(lastEmission) >= 30 else { return }
        previousFingerprint = fingerprint

        let ocrStart = ContinuousClock.now
        let windowLines = try recognizeText(in: windowImage)
        let displayLines = try recognizeText(in: displayImage)
        let ocrMS = milliseconds(since: ocrStart)
        let record = FrameLine(
            frameID: UUID().uuidString,
            capturedAt: ISO8601DateFormatter().string(from: Date()),
            app: frontmost.appName,
            bundleID: frontmost.bundleID,
            windowTitle: frontmost.title,
            url: frontmost.url,
            windowText: windowLines.map(\.text).joined(separator: "\n"),
            windowLines: windowLines,
            windowWidth: windowImage.width,
            windowHeight: windowImage.height,
            displayText: displayLines.map(\.text).joined(separator: "\n"),
            displayLines: displayLines,
            displayWidth: displayImage.width,
            displayHeight: displayImage.height,
            captureMS: captureMS,
            ocrMS: ocrMS,
            excludedWindows: filters.excludedCount,
            reason: changed ? "change" : "interval"
        )
        try writeCrop(from: displayImage)
        output.write(record, to: .standardOutput)
        lastEmission = Date()
    }

    private func frontmostContext(content: SCShareableContent) -> FrontmostContext {
        let shareableWindows = Dictionary(uniqueKeysWithValues: content.windows.map { (UInt32($0.windowID), $0) })
        let ordered = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let front = ordered.first { ($0[kCGWindowLayer as String] as? Int) == 0 }
        let window = front.flatMap { entry in
            (entry[kCGWindowNumber as String] as? UInt32).flatMap { shareableWindows[$0] }
        }
        let application = front.flatMap { entry in
            (entry[kCGWindowOwnerPID as String] as? Int32).flatMap(NSRunningApplication.init(processIdentifier:))
        }
        let bundleID = application?.bundleIdentifier
        let title = window?.title
        return FrontmostContext(
            appName: application?.localizedName,
            bundleID: bundleID,
            window: window,
            title: title,
            url: browserURL(for: bundleID)
        )
    }

    private func filters(for content: SCShareableContent, frontmost: FrontmostContext) throws -> (window: SCContentFilter, display: SCContentFilter, excludedCount: Int) {
        guard let window = frontmost.window else {
            throw HelperError.unavailable("No shareable frontmost window is available")
        }
        guard !isSelfWindow(window) else {
            throw HelperError.unavailable("The frontmost window is marked as Shepherd-owned")
        }
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
            throw HelperError.unavailable("No shareable display is available")
        }
        let excludedWindows = content.windows.filter(isSelfWindow)
        return (
            window: SCContentFilter(desktopIndependentWindow: window),
            display: SCContentFilter(display: display, excludingWindows: excludedWindows),
            excludedCount: excludedWindows.count
        )
    }

    // Pixels remain in memory unless the caller explicitly asks to journal an
    // evidence crop at their supplied path. Crop coordinates are display pixels.
    private func writeCrop(from displayImage: CGImage) throws {
        guard let crop = options.crop, let outputURL = options.cropOutput else { return }
        let bounds = CGRect(x: 0, y: 0, width: displayImage.width, height: displayImage.height)
        let requested = CGRect(x: crop.x, y: crop.y, width: crop.width, height: crop.height)
        guard bounds.contains(requested), let image = displayImage.cropping(to: requested) else {
            throw HelperError.unavailable("Requested crop is outside the captured display")
        }
        guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            throw HelperError.unavailable("Unable to encode requested crop")
        }
        try data.write(to: outputURL, options: .atomic)
    }

    private func screenshotConfiguration(for filter: SCContentFilter) -> SCStreamConfiguration {
        let configuration = SCStreamConfiguration()
        configuration.showsCursor = false
        let scale = CGFloat(filter.pointPixelScale)
        configuration.width = max(1, Int(filter.contentRect.width * scale))
        configuration.height = max(1, Int(filter.contentRect.height * scale))
        return configuration
    }

    private func isSelfWindow(_ window: SCWindow) -> Bool {
        guard let nonce = options.exclusionNonce, let title = window.title else { return false }
        return title.hasSuffix("Shepherd \(nonce)")
    }

    private func recognizeText(in image: CGImage) throws -> [TextLine] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.recognitionLanguages = ["en-US"]

        let handler = VNImageRequestHandler(cgImage: image)
        try handler.perform([request])
        let imageWidth = Double(image.width)
        let imageHeight = Double(image.height)
        return (request.results ?? []).compactMap { observation in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            let box = observation.boundingBox
            return TextLine(
                text: candidate.string,
                x: Double(box.minX) * imageWidth,
                y: Double(1 - box.maxY) * imageHeight,
                w: Double(box.width) * imageWidth,
                h: Double(box.height) * imageHeight
            )
        }
    }

    private func downscaledHash(_ image: CGImage) -> UInt64 {
        let side = 256
        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        pixels.withUnsafeMutableBytes { rawBuffer in
            guard let context = CGContext(
                data: rawBuffer.baseAddress,
                width: side,
                height: side,
                bitsPerComponent: 8,
                bytesPerRow: side * 4,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return }
            context.interpolationQuality = .low
            context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
        }

        var value: UInt64 = 1_469_598_103_934_665_603
        for byte in pixels {
            value ^= UInt64(byte)
            value &*= 1_099_511_628_211
        }
        return value
    }

    private func browserURL(for bundleID: String?) -> String? {
        let source: String?
        switch bundleID {
        case "com.apple.Safari":
            source = "tell application id \"com.apple.Safari\" to return URL of front document"
        case "com.google.Chrome", "com.google.Chrome.canary", "com.microsoft.edgemac", "com.brave.Browser", "com.operasoftware.Opera":
            guard let bundleID else { return nil }
            source = "tell application id \"\(bundleID)\" to return URL of active tab of front window"
        default:
            source = nil
        }
        guard let source, let script = NSAppleScript(source: source) else { return nil }
        var error: NSDictionary?
        return script.executeAndReturnError(&error).stringValue
    }

    private func milliseconds(since start: ContinuousClock.Instant) -> Int {
        let duration = start.duration(to: .now)
        return Int(duration.components.seconds * 1_000) + Int(duration.components.attoseconds / 1_000_000_000_000_000)
    }

    private func writeError(_ error: Error) {
        if let helperError = error as? HelperError {
            output.write(ErrorLine(kind: helperError.kind, message: helperError.localizedDescription), to: .standardError)
        } else {
            output.write(ErrorLine(kind: "capture", message: error.localizedDescription), to: .standardError)
        }
    }
}

Task {
    do {
        let options = try Options(arguments: Array(CommandLine.arguments.dropFirst()))
        await EyesHelper(options: options).run()
        exit(0)
    } catch {
        let output = JSONLines()
        if let helperError = error as? HelperError {
            output.write(ErrorLine(kind: helperError.kind, message: helperError.localizedDescription), to: .standardError)
        } else {
            output.write(ErrorLine(kind: "usage", message: error.localizedDescription), to: .standardError)
        }
        exit(2)
    }
}
dispatchMain()
