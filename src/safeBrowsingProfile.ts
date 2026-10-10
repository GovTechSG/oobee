import { type ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import JSZip from 'jszip';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import printMessage from 'print-message';
import type { Readable } from 'stream';
import { consoleLogger } from './logs.js';
import { messageOptions } from './constants/common.js';

const BASE_PROFILE_DIR = process.env.SB_PROFILE_DIR || path.join(os.homedir(), '.oobee', 'safe-browsing-profile');
const SB_DIR = path.join(BASE_PROFILE_DIR, 'Safe Browsing');
const SEEDED_MARKER = '.sb-seeded';
const FAILED_MARKER = path.join(BASE_PROFILE_DIR, '.sb-warmup-failed');
const LOCK_DIR = path.join(BASE_PROFILE_DIR, '.warmup-lock');
const DB_DOWNLOAD_TIMEOUT_MS = parseInt(process.env.SB_DB_TIMEOUT_MS || '300000', 10);
const LOCK_STALE_MS = DB_DOWNLOAD_TIMEOUT_MS;

const SB_DEBUG = !!process.env.GOOGLE_SAFE_BROWSING_DEBUG;
function sbDebug(msg: string) {
  if (SB_DEBUG) consoleLogger.info(msg);
}

// Optional pinned SHA-256 digest (hex) for the prepopulated Safe Browsing zip.
// When set, findPrePopulatedSource() refuses to use any zip whose contents do
// not match, closing the CWE-345/CWE-494 gap where a locally-planted or stale
// archive would otherwise be trusted and silently disable Safe Browsing for
// every scanning session.
const SB_PREPOPULATED_SHA256 = process.env.SB_PREPOPULATED_SHA256;

/**
 * Best-effort provenance check for a candidate prepopulated Safe Browsing
 * source (zip file or directory): reject anything that is group/world
 * writable, or not owned by the current user or root. This mirrors the
 * TLS-based protection already applied to the Chrome-download warmup path
 * (see spawnChromeForWarmup) by ensuring a less-privileged process sharing a
 * mounted volume (e.g. /data, /opt) cannot plant a substitute database that
 * gets silently trusted.
 */
function hasTrustedOwnerAndMode(st: fs.Stats, p: string): boolean {
  if (process.platform === 'win32') return true; // POSIX permission/owner bits are not meaningful here
  if ((st.mode & 0o022) !== 0) {
    sbDebug(`[SafeBrowsing] Rejecting ${p}: group/world-writable (mode=${(st.mode & 0o777).toString(8)})`);
    return false;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid && st.uid !== 0) {
    sbDebug(`[SafeBrowsing] Rejecting ${p}: owned by uid ${st.uid}, expected ${uid} or root`);
    return false;
  }
  return true;
}

function isOwnedAndNotWorldWritable(p: string): boolean {
  if (process.platform === 'win32') return true;
  try {
    return hasTrustedOwnerAndMode(fs.statSync(p), p);
  } catch (e) {
    sbDebug(`[SafeBrowsing] Failed to stat ${p}: ${e}`);
    return false;
  }
}

// asgard-0003: upper bounds for the prepopulated Safe Browsing zip. A real DB
// is tens of MB across a handful of files; anything far beyond that is a zip
// bomb or not a Safe Browsing DB at all.
const SB_ZIP_MAX_BYTES = 512 * 1024 * 1024;
const SB_ZIP_MAX_ENTRIES = 1000;
const SB_ZIP_MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;

/**
 * Reads a candidate prepopulated Safe Browsing zip ONCE and verifies exactly
 * those bytes (asgard-0003).
 *
 * Previously ownership/permissions, the optional SHA-256 and the `unzip`
 * extraction were three separate opens of `zipPath`, so on a shared mount
 * (/data, /opt) the file could be swapped between check and extraction
 * (TOCTOU). Here the file is opened once, ownership/mode are checked with
 * fstat on that descriptor, and the same buffer is hashed and then extracted.
 * Nothing re-reads the path afterwards.
 */
function readVerifiedPrePopulatedZip(zipPath: string): Buffer | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(zipPath, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      sbDebug(`[SafeBrowsing] Rejecting ${zipPath}: not a regular file`);
      return null;
    }
    if (!hasTrustedOwnerAndMode(st, zipPath)) return null;
    if (st.size > SB_ZIP_MAX_BYTES) {
      consoleLogger.info(`[SafeBrowsing] Rejecting pre-populated zip ${zipPath}: ${st.size} bytes exceeds ${SB_ZIP_MAX_BYTES}`);
      return null;
    }
    const data = fs.readFileSync(fd);

    if (SB_PREPOPULATED_SHA256) {
      const actual = crypto.createHash('sha256').update(data).digest('hex');
      if (actual.toLowerCase() !== SB_PREPOPULATED_SHA256.trim().toLowerCase()) {
        consoleLogger.info(`[SafeBrowsing] Rejecting pre-populated zip ${zipPath}: SHA-256 mismatch (expected ${SB_PREPOPULATED_SHA256}, got ${actual})`);
        return null;
      }
      sbDebug(`[SafeBrowsing] Pre-populated zip ${zipPath} matched pinned SHA-256`);
    } else {
      consoleLogger.info(`[SafeBrowsing] WARNING: no SB_PREPOPULATED_SHA256 pinned digest configured; trusting ${zipPath} based on ownership/permission checks and archive content validation only`);
    }
    return data;
  } catch (e) {
    sbDebug(`[SafeBrowsing] Failed to read ${zipPath}: ${e}`);
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/**
 * Extracts an in-memory zip into `destDir` with full containment
 * (asgard-0003). Replaces `unzip -o`, which restores symlink entries, so an
 * archive with `link -> /elsewhere` followed by `link/evil` could write
 * outside the profile directory on some unzip builds.
 *
 * The whole archive is validated BEFORE anything is written; one bad entry
 * rejects it. Refused: symlinks and other special entry types; absolute
 * paths, drive letters, backslashes, NUL bytes and `.`/`..` segments; names
 * that resolve outside `destDir`; too many entries or too many bytes.
 * Files are written with `wx`, so a pre-existing file or symlink at a target
 * path fails extraction instead of being followed. `destDir` must be a fresh
 * empty directory owned by this process.
 */
export async function extractZipBufferSafely(data: Buffer, destDir: string): Promise<void> {
  const zip = await JSZip.loadAsync(data);
  const realDest = fs.realpathSync(destDir);
  const entries = Object.values(zip.files);
  if (entries.length > SB_ZIP_MAX_ENTRIES) {
    throw new Error(`[SafeBrowsing] Archive has ${entries.length} entries (max ${SB_ZIP_MAX_ENTRIES})`);
  }

  const plan: { file: JSZip.JSZipObject; target: string; isDir: boolean }[] = [];
  for (const file of entries) {
    // JSZip strips "../" from `name`; judge the raw stored name instead.
    const rawName: string = (file as any).unsafeOriginalName ?? file.name;
    if (
      !rawName ||
      rawName.includes('\0') ||
      rawName.includes('\\') ||
      rawName.startsWith('/') ||
      /^[a-zA-Z]:/.test(rawName)
    ) {
      throw new Error(`[SafeBrowsing] Refusing unsafe archive entry name: ${JSON.stringify(rawName)}`);
    }
    const segments = rawName.replace(/\/$/, '').split('/');
    if (segments.some(s => s === '' || s === '.' || s === '..')) {
      throw new Error(`[SafeBrowsing] Refusing archive entry with path traversal: ${JSON.stringify(rawName)}`);
    }
    const type = (typeof file.unixPermissions === 'number' ? file.unixPermissions : 0) & S_IFMT;
    if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) {
      throw new Error(`[SafeBrowsing] Refusing symlink or special-file archive entry: ${JSON.stringify(rawName)}`);
    }
    const target = path.resolve(realDest, ...segments);
    if (!target.startsWith(realDest + path.sep)) {
      throw new Error(`[SafeBrowsing] Archive entry escapes extraction dir: ${JSON.stringify(rawName)}`);
    }
    plan.push({ file, target, isDir: file.dir || type === S_IFDIR });
  }

  let written = 0;
  for (const { file, target, isDir } of plan) {
    if (isDir) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const realParent = fs.realpathSync(path.dirname(target));
    if (realParent !== realDest && !realParent.startsWith(realDest + path.sep)) {
      throw new Error(`[SafeBrowsing] Archive entry parent escapes extraction dir: ${file.name}`);
    }
    // asgard-0009 (10 Oct 2026 re-scan): check BEFORE decompressing, not after.
    // file.async('nodebuffer') used to fully inflate each entry into one
    // buffer first and only then compare its length against the budget — a
    // single highly-compressed entry (deflate can reach ~1000:1) could
    // balloon to gigabytes in that one allocation before the check ever ran.
    // _data.uncompressedSize is read from the zip's central directory, with
    // no decompression, so a declared-oversized entry is rejected up front.
    const declaredSize = (file as any)._data?.uncompressedSize;
    if (typeof declaredSize === 'number' && written + declaredSize > SB_ZIP_MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`[SafeBrowsing] Archive entry ${file.name} declares ${declaredSize} bytes, exceeding the ${SB_ZIP_MAX_UNCOMPRESSED_BYTES}-byte uncompressed budget`);
    }
    // `wx` alone is not enough on Windows: creating a file over a dangling
    // symlink follows the link and creates its target. Refuse anything
    // (file, dir, symlink, junction) already at the target path.
    let existing: fs.Stats | undefined;
    try {
      existing = fs.lstatSync(target);
    } catch {}
    if (existing) {
      throw new Error(`[SafeBrowsing] Refusing to overwrite existing path during extraction: ${file.name}`);
    }
    // Stream rather than file.async('nodebuffer'): the declared-size check
    // above is a cheap first barrier, but a crafted/corrupt zip could lie
    // about its own central-directory metadata. Streaming re-checks the
    // REAL decompressed byte count as it arrives and aborts mid-entry if it
    // ever exceeds the budget, so no single entry is ever fully buffered
    // in memory before the cap can act.
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(target, { flags: 'wx', mode: 0o644 });
      // JSZip's .d.ts types nodeStream() as the generic NodeJS.ReadableStream
      // interface, which omits .destroy() even though the object returned at
      // runtime is a real Readable. Cast to the concrete type instead of
      // suppressing the check, so a genuine API mismatch would still surface.
      const stream = file.nodeStream('nodebuffer') as unknown as Readable;
      let entryWritten = 0;
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        stream.unpipe(out);
        stream.destroy();
        out.destroy();
        fs.rm(target, { force: true }, () => reject(err));
      };
      stream.on('data', (chunk: Buffer) => {
        entryWritten += chunk.length;
        written += chunk.length;
        if (written > SB_ZIP_MAX_UNCOMPRESSED_BYTES) {
          fail(new Error(`[SafeBrowsing] Archive exceeds ${SB_ZIP_MAX_UNCOMPRESSED_BYTES} uncompressed bytes`));
        }
      });
      stream.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      stream.pipe(out);
    });
  }
}

function getChromeExecutable(): string | null {
  let candidates: string[];
  if (process.platform === 'darwin') {
    candidates = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  } else if (process.platform === 'win32') {
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates = [
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
  } else {
    candidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
    ];
  }

  return candidates.find(p => fs.existsSync(p)) ?? null;
}

type PrePopulatedSource = { dir: string; cleanup?: string };

async function findPrePopulatedSource(): Promise<PrePopulatedSource | null> {
  const envPath = process.env.SB_PREPOPULATED_DIR;
  if (envPath) {
    const nestedDir = path.join(envPath, 'Safe Browsing');
    if (isDbDir(nestedDir) && isOwnedAndNotWorldWritable(envPath) && isOwnedAndNotWorldWritable(nestedDir)) return { dir: nestedDir };
    if (isDbDir(envPath) && isOwnedAndNotWorldWritable(envPath)) return { dir: envPath };
    sbDebug(`[SafeBrowsing] SB_PREPOPULATED_DIR=${envPath} rejected (missing DB or fails ownership/permission check)`);
  }

  const zipCandidates = [
    process.env.SB_PREPOPULATED_ZIP,
    '/data/safe-browsing-db.zip',
    '/opt/oobee-safe-browsing/safe-browsing-db.zip',
    path.join(os.homedir(), '.oobee', 'safe-browsing-db.zip'),
  ].filter(Boolean) as string[];

  for (const zipPath of zipCandidates) {
    if (fs.existsSync(zipPath)) {
      sbDebug(`[SafeBrowsing] Found pre-populated zip: ${zipPath}`);
      // Read once: the bytes checked are exactly the bytes extracted (no TOCTOU).
      const zipData = readVerifiedPrePopulatedZip(zipPath);
      if (!zipData) {
        consoleLogger.info(`[SafeBrowsing] Skipping untrusted pre-populated zip: ${zipPath}`);
        continue;
      }
      // Extract into a fresh private staging dir, never straight into the live
      // profile, so a rejected archive leaves nothing behind. The caller copies
      // the validated DB files into SB_DIR.
      let stagingDir: string | undefined;
      try {
        stagingDir = fs.mkdtempSync(path.join(BASE_PROFILE_DIR, '.sb-extract-'));
        await extractZipBufferSafely(zipData, stagingDir);
        // Accept DB files at the archive root or under "Safe Browsing/".
        const nested = path.join(stagingDir, 'Safe Browsing');
        const dbDir = isDbDir(nested) ? nested : stagingDir;
        if (isDbDir(dbDir)) {
          consoleLogger.info(`[SafeBrowsing] Using verified pre-populated DB from ${zipPath}`);
          return { dir: dbDir, cleanup: stagingDir };
        }
        sbDebug(`[SafeBrowsing] ${zipPath} does not contain a Safe Browsing DB`);
      } catch (e) {
        consoleLogger.info(`[SafeBrowsing] Rejecting pre-populated zip ${zipPath}: ${(e as Error).message}`);
      }
      if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  const dirCandidates: string[] = [];
  if (process.platform === 'darwin') {
    dirCandidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Safe Browsing'));
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    dirCandidates.push(path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Safe Browsing'));
  } else {
    dirCandidates.push(
      '/data/chrome-profile/Safe Browsing',
      '/opt/oobee-safe-browsing/Safe Browsing',
      path.join(os.homedir(), '.config', 'google-chrome', 'Safe Browsing'),
      path.join(os.homedir(), '.config', 'chromium', 'Safe Browsing'),
    );
  }

  const foundDir = dirCandidates.find(d => isDbDir(d) && isOwnedAndNotWorldWritable(d));
  if (foundDir) {
    consoleLogger.info(`[SafeBrowsing] Using pre-populated DB from local Chrome/Chromium profile: ${foundDir}`);
  }
  return foundDir ? { dir: foundDir } : null;
}

function isDbDir(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some(f =>
    f.startsWith('UrlSoceng.store.') ||
    f.startsWith('UrlMalware.store.') ||
    f.startsWith('UrlMalBin.store.') ||
    f.startsWith('UrlBilling.store.'),
  );
}

// Flat copy of a Safe Browsing DB dir. asgard-0003: only regular files are
// copied (lstat, so symlinks are never followed), and a symlink already sitting
// at the destination is removed rather than written through — otherwise a
// planted `dst/UrlMalware.store.x -> /elsewhere` would redirect the write.
function copyDirectory(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    const from = path.join(src, file);
    const to = path.join(dst, file);
    if (!fs.lstatSync(from).isFile()) {
      sbDebug(`[SafeBrowsing] Skipping non-regular file in DB dir: ${from}`);
      continue;
    }
    try {
      if (fs.lstatSync(to).isSymbolicLink()) fs.unlinkSync(to);
    } catch {}
    fs.copyFileSync(from, to);
  }
}

function killChromeTree(chrome: ChildProcess): void {
  if (!chrome.pid) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  } else {
    try {
      process.kill(-chrome.pid, 'SIGKILL');
    } catch {
      try { chrome.kill('SIGKILL'); } catch {}
    }
  }
}

function acquireLock(): boolean {
  try {
    fs.mkdirSync(LOCK_DIR);
    fs.writeFileSync(path.join(LOCK_DIR, 'pid'), `${process.pid}\n${Date.now()}`);
    return true;
  } catch {
    try {
      const content = fs.readFileSync(path.join(LOCK_DIR, 'pid'), 'utf8');
      const timestamp = parseInt(content.split('\n')[1], 10);
      if (Date.now() - timestamp > LOCK_STALE_MS) {
        fs.rmSync(LOCK_DIR, { recursive: true, force: true });
        return acquireLock();
      }
    } catch {
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
      return acquireLock();
    }
    return false;
  }
}

function releaseLock(): void {
  try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch {}
}

async function spawnChromeForWarmup(): Promise<void> {
  printMessage([`Downloading Safe Browsing threat database via Chrome (up to ${DB_DOWNLOAD_TIMEOUT_MS / 1000}s)...`], messageOptions);

  fs.mkdirSync(path.join(BASE_PROFILE_DIR, 'Default'), { recursive: true });
  // Use standard protection (not enhanced) for the warmup to force Chrome to
  // download local hash-prefix databases. Enhanced protection uses OHTTP
  // real-time checks exclusively and does NOT download local databases.
  // Standard protection NEEDS local databases, so Chrome downloads them.
  fs.writeFileSync(
    path.join(BASE_PROFILE_DIR, 'Default', 'Preferences'),
    JSON.stringify({ safebrowsing: { enabled: true, enhanced: false } }),
  );

  const exe = getChromeExecutable()!;

  const baseArgs = [
    `--user-data-dir=${BASE_PROFILE_DIR}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    // Do NOT pass --ignore-certificate-errors here. The security-relevant
    // traffic in this warmup is the Safe Browsing hash-prefix database
    // download; disabling TLS validation for that connection lets an
    // on-path attacker substitute a stale/empty/tampered DB that then
    // propagates into every scanning profile (injectSafeBrowsingDb),
    // silently defeating the "we protect the analyst against malicious
    // URLs" property. The generate_204 probe below only needs standard
    // TLS to succeed — Google's cert chains anchor to public roots. If a
    // corporate proxy MITMs egress, add the proxy CA to the system
    // trust store rather than globally disabling certificate checks.
    // Warmup only visits google.com/generate_204 to trigger a DB download into
    // a throwaway profile — no untrusted content. --no-sandbox is safe here and
    // is required inside BuildKit / restricted containers where Chrome's
    // setuid/namespace sandbox can't initialise (SIGABRT during zygote setup).
    // Runtime scanning Chrome (launched via Playwright, not this code path)
    // keeps the sandbox on.
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : []),
  ];

  const chromeStdio: 'ignore' | 'inherit' = SB_DEBUG ? 'inherit' : 'ignore';
  sbDebug(`[SafeBrowsing] Spawning Chrome: ${exe}`);
  sbDebug(`[SafeBrowsing] Chrome args: ${[...baseArgs, '--headless=new', '--disable-gpu', 'https://www.google.com/generate_204'].join(' ')}`);
  const chrome = spawn(
    exe,
    [...baseArgs, '--headless=new', '--disable-gpu', 'https://www.google.com/generate_204'],
    { stdio: chromeStdio, detached: true },
  );
  sbDebug(`[SafeBrowsing] Chrome PID: ${chrome.pid}`);
  chrome.on('exit', (code, signal) => {
    consoleLogger.info(`[SafeBrowsing] Chrome exited early: code=${code} signal=${signal}`);
  });
  chrome.on('error', err => {
    consoleLogger.info(`[SafeBrowsing] Chrome spawn error: ${err}`);
  });

  const maxWait = DB_DOWNLOAD_TIMEOUT_MS;
  const pollInterval = 5_000;
  let waited = 0;
  while (!isDbDir(SB_DIR) && waited < maxWait) {
    await new Promise(r => setTimeout(r, pollInterval));
    waited += pollInterval;
    if (waited % 15_000 === 0) {
      let sbListing = '(missing)';
      try {
        sbListing = fs.existsSync(SB_DIR) ? fs.readdirSync(SB_DIR).join(', ') || '(empty)' : '(missing)';
      } catch (e) {
        sbListing = `(read error: ${e})`;
      }
      consoleLogger.info(`[SafeBrowsing] Waiting for hash-prefix DB... (${waited / 1000}s) SB_DIR contents: ${sbListing}`);
    }
  }

  killChromeTree(chrome);
}

export async function warmupSafeBrowsingBaseProfile(): Promise<void> {
  sbDebug(`[SafeBrowsing] BASE_PROFILE_DIR: ${BASE_PROFILE_DIR}`);
  sbDebug(`[SafeBrowsing] SB_DIR: ${SB_DIR}`);
  sbDebug(`[SafeBrowsing] isDbDir(SB_DIR): ${isDbDir(SB_DIR)}`);
  if (isDbDir(SB_DIR)) {
    sbDebug('[SafeBrowsing] DB already exists in base profile, skipping warmup');
    return;
  }

  if (fs.existsSync(FAILED_MARKER)) {
    sbDebug('[SafeBrowsing] Previous warmup failed (marker exists), skipping retry');
    return;
  }

  fs.mkdirSync(BASE_PROFILE_DIR, { recursive: true });

  const prePopulated = await findPrePopulatedSource();
  sbDebug(`[SafeBrowsing] findPrePopulatedSource() = ${prePopulated?.dir}`);
  if (prePopulated) {
    try {
      sbDebug(`[SafeBrowsing] Found pre-populated DB at: ${prePopulated.dir}`);
      const files = fs.readdirSync(prePopulated.dir);
      sbDebug(`[SafeBrowsing] Files: ${files.join(', ')}`);
      printMessage([`Copying Safe Browsing threat database from verified pre-populated source: ${prePopulated.dir}`], messageOptions);
      copyDirectory(prePopulated.dir, SB_DIR);
      printMessage(['Google Safe Browsing enabled (local hash-prefix DB active)'], messageOptions);
    } finally {
      if (prePopulated.cleanup) fs.rmSync(prePopulated.cleanup, { recursive: true, force: true });
    }
    return;
  }

  const exe = getChromeExecutable();
  sbDebug(`[SafeBrowsing] Chrome executable: ${exe}`);
  if (!exe) {
    sbDebug('[SafeBrowsing] Google Chrome not found, marking as failed');
    fs.mkdirSync(BASE_PROFILE_DIR, { recursive: true });
    fs.writeFileSync(FAILED_MARKER, `no-chrome:${new Date().toISOString()}`);
    printMessage(['WARNING: Google Chrome not found. Safe Browsing requires Chrome (not Chromium). On Linux Docker, build with --platform linux/amd64.'], messageOptions);
    return;
  }

  if (!acquireLock()) {
    sbDebug('Another process is downloading Safe Browsing DB; waiting...');
    const waitStart = Date.now();
    while (!isDbDir(SB_DIR) && Date.now() - waitStart < DB_DOWNLOAD_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, 5_000));
    }
    if (isDbDir(SB_DIR)) {
      printMessage(['Google Safe Browsing enabled (local hash-prefix DB active)'], messageOptions);
    }
    return;
  }

  try {
    await spawnChromeForWarmup();

    if (isDbDir(SB_DIR)) {
      printMessage(['Google Safe Browsing enabled (local hash-prefix DB active)'], messageOptions);
    } else {
      fs.writeFileSync(FAILED_MARKER, `timeout:${new Date().toISOString()}`);
      printMessage([`WARNING: Safe Browsing DB did not populate in ${DB_DOWNLOAD_TIMEOUT_MS / 1000}s. Protection may be reduced.`], messageOptions);
    }
  } finally {
    releaseLock();
  }
}

export function injectSafeBrowsingDb(targetDir: string): void {
  sbDebug(`[SafeBrowsing] injectSafeBrowsingDb(${targetDir})`);
  sbDebug(`[SafeBrowsing] isDbDir(SB_DIR=${SB_DIR}): ${isDbDir(SB_DIR)}`);
  if (!isDbDir(SB_DIR)) {
    sbDebug('[SafeBrowsing] No DB to inject — setting preferences only');
    const defaultDir = path.join(targetDir, 'Default');
    fs.mkdirSync(defaultDir, { recursive: true });
    const prefsPath = path.join(defaultDir, 'Preferences');
    let prefs: Record<string, unknown> = {};
    if (fs.existsSync(prefsPath)) {
      try { prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8')); } catch {}
    }
    // Copy the full safebrowsing object (including OHTTP key) from base profile
    const basePrefsPath = path.join(BASE_PROFILE_DIR, 'Default', 'Preferences');
    let baseSbPrefs: Record<string, unknown> = { enabled: true, enhanced: false };
    if (fs.existsSync(basePrefsPath)) {
      try {
        const basePrefs = JSON.parse(fs.readFileSync(basePrefsPath, 'utf8'));
        if (basePrefs?.safebrowsing) {
          baseSbPrefs = { ...basePrefs.safebrowsing, enabled: true, enhanced: false };
        }
      } catch {}
    }
    prefs.safebrowsing = { ...(prefs.safebrowsing as object), ...baseSbPrefs };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
    sbDebug(`[SafeBrowsing] Wrote preferences to ${prefsPath} (has OHTTP key: ${!!((prefs.safebrowsing as any)?.hash_real_time_ohttp_key)})`);
    return;
  }
  if (fs.existsSync(path.join(targetDir, SEEDED_MARKER))) {
    sbDebug('[SafeBrowsing] Already seeded (marker exists), skipping');
    return;
  }

  sbDebug('[SafeBrowsing] Copying DB + setting preferences');
  copyDirectory(SB_DIR, path.join(targetDir, 'Safe Browsing'));

  const defaultDir = path.join(targetDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true });
  const prefsPath = path.join(defaultDir, 'Preferences');
  let prefs: Record<string, unknown> = {};
  if (fs.existsSync(prefsPath)) {
    try { prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8')); } catch {}
  }
  prefs.safebrowsing = { ...(prefs.safebrowsing as object), enabled: true, enhanced: false };
  fs.writeFileSync(prefsPath, JSON.stringify(prefs));
  sbDebug(`[SafeBrowsing] Wrote preferences to ${prefsPath}: ${JSON.stringify(prefs.safebrowsing)}`);

  fs.writeFileSync(path.join(targetDir, SEEDED_MARKER), new Date().toISOString());
  sbDebug('[SafeBrowsing] Injection complete');
}

/**
 * Args that Playwright adds by default which must be removed when Safe Browsing is enabled,
 * otherwise Chrome disables the SB service.
 */
export function getSafeBrowsingIgnoredArgs(): string[] {
  if (!process.env.GOOGLE_SAFE_BROWSING) return [];
  return [
    '--safebrowsing-disable-auto-update',
    '--disable-client-side-phishing-detection',
    '--disable-background-networking',
    '--disable-component-update',
  ];
}


export async function ensureAndInjectSafeBrowsing(targetDir: string): Promise<void> {
  if (!process.env.GOOGLE_SAFE_BROWSING) return;
  sbDebug(`[SafeBrowsing] ensureAndInjectSafeBrowsing(${targetDir})`);


  await warmupSafeBrowsingBaseProfile();
  injectSafeBrowsingDb(targetDir);
  sbDebug('[SafeBrowsing] ensureAndInjectSafeBrowsing complete');
}
