// Capture one 2x PNG per demo page, framed with a simulated address bar.
//
//   node demo/capture.mjs [--port 8099]  # SHEPHERD_CHROME or the newest Playwright headless shell
//
// The browser runs with a throwaway profile, background networking disabled and
// a host resolver that maps every name except loopback to NOTFOUND, so the
// capture cannot reach the network even if a page tried to. The browser gets a
// minimal allowlisted environment so provider secrets (ANTHROPIC_API_KEY, ...)
// never reach it. It is an installed third-party binary: in the event rig, run
// it only after posting intent on the bead and getting the operator's go.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'fixtures.json'), 'utf8'));
const { width, height, scale } = manifest.viewport;

function chrome() {
  if (process.env.SHEPHERD_CHROME) return process.env.SHEPHERD_CHROME;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const shells = existsSync(cache) ? readdirSync(cache).filter((name) => /^chromium_headless_shell-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : [];
  for (const shell of shells) {
    for (const arch of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64']) {
      const binary = join(cache, shell, arch, 'chrome-headless-shell');
      if (existsSync(binary)) return binary;
    }
  }
  throw Error('No headless Chromium found; set SHEPHERD_CHROME to a Chromium/Chrome binary.');
}

function childEnvironment(home) {
  // Allowlist, not denylist: nothing from the caller's environment passes unless named.
  return { HOME: home, TMPDIR: process.env.TMPDIR ?? tmpdir(), LANG: 'en_US.UTF-8' };
}

const binary = chrome();
const { server, port } = await import('./serve.mjs');
await new Promise((resolve, reject) => {
  server.once('error', (error) => reject(error.code === 'EADDRINUSE' ? Error(`Port ${port} is in use; stop the demo server or pass --port N.`) : error));
  server.listen(port, '127.0.0.1', resolve);
});
const profile = await mkdtemp(join(tmpdir(), 'shepherd-capture-'));
try {
  for (const page of manifest.pages) {
    // Render to a fresh sibling file and replace the tracked PNG only once a new,
    // valid PNG exists, so a browser that writes nothing can never leave stale pixels passing.
    const output = join(root, 'screenshots', `${page.id}.png`);
    const fresh = join(root, 'screenshots', `.${page.id}.capture.png`);
    await rm(fresh, { force: true });
    await run(binary, [
      '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      `--user-data-dir=${profile}`, `--window-size=${width},${height}`, `--force-device-scale-factor=${scale}`,
      `--screenshot=${fresh}`, `http://127.0.0.1:${port}/frame/${page.id}`,
    ], { timeout: 30_000, env: childEnvironment(profile) });
    const png = await readFile(fresh).catch(() => null);
    if (!png || png.length < 1024 || !png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      await rm(fresh, { force: true });
      throw Error(`Browser did not write a new PNG for ${page.id}; ${output} left unchanged.`);
    }
    await rename(fresh, output);
    console.log(`captured ${page.id} -> demo/screenshots/${page.id}.png`);
  }
} finally {
  server.close();
  await rm(profile, { recursive: true, force: true });
}
