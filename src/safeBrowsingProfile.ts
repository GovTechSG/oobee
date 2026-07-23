import { type ChildProcess, spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import printMessage from 'print-message';
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

function findPrePopulatedSource(): string | null {
  const envPath = process.env.SB_PREPOPULATED_DIR;
  if (envPath) {
    if (isDbDir(path.join(envPath, 'Safe Browsing'))) return path.join(envPath, 'Safe Browsing');
    if (isDbDir(envPath)) return envPath;
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
      const extractDir = path.join(BASE_PROFILE_DIR, 'Safe Browsing');
      fs.mkdirSync(extractDir, { recursive: true });
      try {
        execSync(`unzip -o -q "${zipPath}" -d "${extractDir}"`, { stdio: 'pipe' });
        if (isDbDir(extractDir)) return extractDir;
      } catch (e) {
        sbDebug(`[SafeBrowsing] Failed to extract zip: ${e}`);
      }
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

  return dirCandidates.find(isDbDir) ?? null;
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

function copyDirectory(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, file), path.join(dst, file));
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
    '--ignore-certificate-errors',
    ...(process.platform === 'linux' ? ['--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] : []),
  ];

  const chrome = spawn(
    exe,
    [...baseArgs, '--headless=new', '--disable-gpu', 'https://www.google.com/generate_204'],
    { stdio: 'ignore', detached: true },
  );

  const maxWait = DB_DOWNLOAD_TIMEOUT_MS;
  const pollInterval = 5_000;
  let waited = 0;
  while (!isDbDir(SB_DIR) && waited < maxWait) {
    await new Promise(r => setTimeout(r, pollInterval));
    waited += pollInterval;
    if (waited % 15_000 === 0) {
      sbDebug(`[SafeBrowsing] Waiting for hash-prefix DB... (${waited / 1000}s)`);
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

  const prePopulated = findPrePopulatedSource();
  sbDebug(`[SafeBrowsing] findPrePopulatedSource() = ${prePopulated}`);
  if (prePopulated) {
    sbDebug(`[SafeBrowsing] Found pre-populated DB at: ${prePopulated}`);
    const files = fs.readdirSync(prePopulated);
    sbDebug(`[SafeBrowsing] Files: ${files.join(', ')}`);
    printMessage(['Copying Safe Browsing threat database from pre-populated source...'], messageOptions);
    copyDirectory(prePopulated, SB_DIR);
    printMessage(['Google Safe Browsing enabled (local hash-prefix DB active)'], messageOptions);
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
