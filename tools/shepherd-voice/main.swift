// Shepherd voice helper (contract): on-device speech recognition only.
//
// Listens to the Mac's own audio output (ScreenCaptureKit audio capture, covered
// by the Screen and System Audio Recording permission) or, with --input
// microphone, to the default input device, and prints recognised text as JSON
// lines in bounded segments, each tagged with its origin. Recognition must run on this Mac: every request sets
// requiresOnDeviceRecognition, and a locale without an on-device model is
// reported unavailable instead of falling back to Apple's servers. Audio stays
// in memory and is never written anywhere; only text segments are printed.
//
// Output, one JSON object per line:
//   {"kind":"listening","locale":"en-US","origin":"system"|"microphone"}
//   {"kind":"segment","t_start":ISO8601,"t_end":ISO8601,"text":"...","confidence":0..1,"reason":"change"|"interval","origin":"system"|"microphone"}
//   {"kind":"unavailable","reason":"no_on_device_model"|"recognizer_unavailable"|"speech_denied"|"microphone_unavailable"|"system_audio_unavailable"|"system_audio_denied"|"usage"}
//   {"kind":"stopped"}
// A segment closes after about two seconds without new words ("change") or when
// it reaches 30 seconds or 400 characters ("interval"). SIGTERM stops capture
// and exits 0.
//
// Do not run this from tmux or an unattended shell: the first run asks for
// Speech Recognition (and Microphone, or Screen and System Audio Recording)
// permission, which needs the operator.
import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit
import Speech

let maxSegmentSeconds: TimeInterval = 30
let maxSegmentCharacters = 400
let pauseSeconds: TimeInterval = 2

setvbuf(stdout, nil, _IOLBF, 0)
let timestamp = ISO8601DateFormatter()
timestamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}

func unavailable(_ reason: String) -> Never {
    emit(["kind": "unavailable", "reason": reason])
    exit(2)
}

// The only place a recognition request is created.
func makeRequest() -> SFSpeechAudioBufferRecognitionRequest {
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = true
    request.addsPunctuation = true
    return request
}

var localeIdentifier = "en-US"
var inputOrigin = "system"
var arguments = CommandLine.arguments.dropFirst().makeIterator()
while let argument = arguments.next() {
    switch argument {
    case "--locale":
        guard let value = arguments.next(), value.range(of: "^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$", options: .regularExpression) != nil else { unavailable("usage") }
        localeIdentifier = value
    case "--input":
        guard let value = arguments.next(), value == "system" || value == "microphone" else { unavailable("usage") }
        inputOrigin = value
    default:
        unavailable("usage")
    }
}

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)) else { unavailable("recognizer_unavailable") }
guard recognizer.supportsOnDeviceRecognition else { unavailable("no_on_device_model") }

// The Mac's own audio output, through ScreenCaptureKit. Only an audio output is
// attached, so no screen frames are delivered; Shepherd's own sounds are excluded.
final class SystemAudio: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    var onSample: ((CMSampleBuffer) -> Void)?

    func start() {
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
            DispatchQueue.main.async {
                guard error == nil, let display = content?.displays.first else { unavailable(error == nil ? "system_audio_unavailable" : "system_audio_denied") }
                let configuration = SCStreamConfiguration()
                configuration.capturesAudio = true
                configuration.excludesCurrentProcessAudio = true
                configuration.sampleRate = 48_000
                configuration.channelCount = 1
                // The smallest frame the stream accepts; no screen output is attached.
                configuration.width = 2
                configuration.height = 2
                configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
                let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: configuration, delegate: self)
                do { try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: .main) } catch { unavailable("system_audio_unavailable") }
                stream.startCapture { error in if error != nil { DispatchQueue.main.async { unavailable("system_audio_denied") } } }
                self.stream = stream
            }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid else { return }
        onSample?(sampleBuffer)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) { DispatchQueue.main.async { unavailable("system_audio_unavailable") } }

    func stop() { stream?.stopCapture(completionHandler: nil) }
}

final class Listener {
    private let recognizer: SFSpeechRecognizer
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var segmentStart = Date()
    private var lastChange = Date()
    private var text = ""
    private var confidence = 0.0
    private var closing = false
    private var timer: DispatchSourceTimer?
    private let system = SystemAudio()

    init(recognizer: SFSpeechRecognizer) { self.recognizer = recognizer }

    func start() {
        if inputOrigin == "system" {
            system.onSample = { [weak self] sample in self?.request?.appendAudioSampleBuffer(sample) }
            system.start()
        } else {
            startMicrophone()
        }
        beginSegment()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
        timer.setEventHandler { [weak self] in self?.tick() }
        timer.resume()
        self.timer = timer
        emit(["kind": "listening", "locale": localeIdentifier, "origin": inputOrigin])
    }

    private func startMicrophone() {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0 else { unavailable("microphone_unavailable") }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            DispatchQueue.main.async { self?.request?.append(buffer) }
        }
        engine.prepare()
        do { try engine.start() } catch { unavailable("microphone_unavailable") }
    }

    private func beginSegment() {
        let request = makeRequest()
        self.request = request
        segmentStart = Date()
        lastChange = segmentStart
        text = ""
        confidence = 0
        closing = false
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async { self?.handle(result: result, error: error) }
        }
    }

    private func handle(result: SFSpeechRecognitionResult?, error: Error?) {
        if let result {
            let latest = result.bestTranscription.formattedString
            if latest != text { text = latest; lastChange = Date() }
            let segments = result.bestTranscription.segments
            if !segments.isEmpty { confidence = segments.map { Double($0.confidence) }.reduce(0, +) / Double(segments.count) }
            if result.isFinal { publish(reason: closingReason ?? "change"); beginSegment(); return }
        }
        if error != nil, closing { publish(reason: closingReason ?? "change"); beginSegment() }
    }

    private var closingReason: String?

    private func tick() {
        guard !closing else { return }
        let now = Date()
        if now.timeIntervalSince(segmentStart) >= maxSegmentSeconds || text.count >= maxSegmentCharacters {
            finish(reason: "interval")
        } else if !text.isEmpty && now.timeIntervalSince(lastChange) >= pauseSeconds {
            finish(reason: "change")
        }
    }

    // Ends the current request; the final result then publishes the segment.
    private func finish(reason: String) {
        closing = true
        closingReason = reason
        request?.endAudio()
    }

    private func publish(reason: String) {
        closingReason = nil
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return }
        emit([
            "kind": "segment", "t_start": timestamp.string(from: segmentStart), "t_end": timestamp.string(from: Date()),
            "text": String(words.prefix(maxSegmentCharacters)), "confidence": (confidence * 1000).rounded() / 1000, "reason": reason, "origin": inputOrigin,
        ])
    }

    // Publishes any words heard so far, then stops capture and exits.
    func stop() -> Never {
        timer?.cancel()
        publish(reason: "change")
        system.stop()
        if inputOrigin == "microphone" {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        task?.cancel()
        request = nil
        emit(["kind": "stopped"])
        exit(0)
    }
}

let listener = Listener(recognizer: recognizer)

signal(SIGTERM, SIG_IGN)
let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termination.setEventHandler { listener.stop() }
termination.resume()

SFSpeechRecognizer.requestAuthorization { status in
    DispatchQueue.main.async {
        guard status == .authorized else { unavailable("speech_denied") }
        listener.start()
    }
}

dispatchMain()
