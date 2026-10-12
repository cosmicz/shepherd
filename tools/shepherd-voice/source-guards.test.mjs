// Source guards for the on-device voice helper (contract). These inspect and
// type-check main.swift; they never run the helper, so no Microphone or Speech
// Recognition prompt can appear from a test run.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('./main.swift', import.meta.url));
const source = await readFile(sourcePath, 'utf8');
// Comments may name forbidden APIs to explain why they are absent.
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('imports only Apple Foundation, Speech, AVFoundation, ScreenCaptureKit and CoreMedia', () => {
  const imports = [...code.matchAll(/^\s*import\s+(\w+)/gm)].map((match) => match[1]);
  assert.deepEqual([...new Set(imports)].sort(), ['AVFoundation', 'CoreMedia', 'Foundation', 'ScreenCaptureKit', 'Speech']);
});

test('system audio is the default input: ScreenCaptureKit audio only, no video output, own audio excluded', () => {
  assert.match(code, /var inputOrigin\s*=\s*"system"/);
  assert.match(code, /\.capturesAudio\s*=\s*true/);
  assert.match(code, /\.excludesCurrentProcessAudio\s*=\s*true/);
  const outputs = [...code.matchAll(/addStreamOutput\([^)]*type:\s*\.(\w+)/g)].map((match) => match[1]);
  assert.deepEqual(outputs, ['audio'], 'only an audio output is attached; no screen frames are received');
  assert.match(code, /appendAudioSampleBuffer\(/);
  // Every segment names where its audio came from.
  assert.match(code, /"origin":\s*inputOrigin/);
  assert.match(code, /value == "system" \|\| value == "microphone"/);
});

test('no network API is referenced', () => {
  assert.doesNotMatch(code, /\b(?:Network|CFNetwork|URLSession|URLRequest|NSURLConnection|Combine|NWConnection)\b/);
});

test('no audio or text is written to a file', () => {
  assert.doesNotMatch(code, /\b(?:FileManager|AVAudioFile|AVAudioRecorder|createFile|fopen|FileHandle\(forWriting|FileHandle\(forUpdating)\b|\.write\(to:/);
});

test('on-device recognition is enforced by construction: one request factory, flag true, never false', () => {
  // Only buffer requests from the microphone; file-based recognition is not used.
  assert.doesNotMatch(code, /SFSpeechURLRecognitionRequest/);
  assert.equal([...code.matchAll(/SFSpeechAudioBufferRecognitionRequest\(\)/g)].length, 1, 'exactly one place creates a request');
  const factory = code.match(/func makeRequest\(\)[^{]*\{([\s\S]*?)\n\}/);
  assert.ok(factory, 'makeRequest() exists');
  assert.match(factory[1], /SFSpeechAudioBufferRecognitionRequest\(\)/);
  assert.match(factory[1], /\.requiresOnDeviceRecognition\s*=\s*true/);
  assert.doesNotMatch(code, /requiresOnDeviceRecognition\s*=(?!\s*true\b)/);
  // Every recognition task is built from makeRequest().
  for (const match of code.matchAll(/recognitionTask\(with:\s*(\w+)/g)) assert.equal(match[1], 'request');
  assert.match(code, /request\s*=\s*makeRequest\(\)/);
  // Without an on-device model the helper reports unavailable instead of using the server.
  assert.match(code, /supportsOnDeviceRecognition/);
  assert.match(code, /"no_on_device_model"/);
});

test('segments are bounded at 30 seconds or 400 characters, with reason change or interval', () => {
  assert.match(code, /let maxSegmentSeconds(?::\s*\w+)?\s*=\s*30(?:\.0)?\b/);
  assert.match(code, /let maxSegmentCharacters(?::\s*\w+)?\s*=\s*400\b/);
  const reasons = new Set([...code.matchAll(/finish\(reason:\s*"(\w+)"/g)].map((match) => match[1]));
  assert.deepEqual([...reasons].sort(), ['change', 'interval']);
});

test('SIGTERM stops capture and exits cleanly', () => {
  assert.match(code, /makeSignalSource\(signal:\s*SIGTERM/);
  assert.match(code, /signal\(SIGTERM,\s*SIG_IGN\)/);
  assert.match(code, /removeTap\(onBus:\s*0\)/);
  assert.match(code, /exit\(0\)/);
});

test('main.swift type-checks against the Apple SDK (compile only, never run)', { skip: !existsSync('/usr/bin/swiftc') && 'swiftc not installed' }, () => {
  execFileSync('/usr/bin/swiftc', ['-typecheck', sourcePath], { stdio: 'pipe', timeout: 120_000 });
});
