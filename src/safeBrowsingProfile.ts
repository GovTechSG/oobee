import { type ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import printMessage from 'print-message';
import { chromium as playwrightChromium } from 'playwright';
import { consoleLogger } from './logs.js';
import { messageOptions } from './constants/common.js';

const BASE_PROFILE_DIR = path.join(os.homedir(), '.oobee', 'safe-browsing-profile');
const SB_DIR = path.join(BASE_PROFILE_DIR, 'Safe Browsing');
const SEEDED_MARKER = '.sb-seeded';
const LOCK_DIR = path.join(BASE_PROFILE_DIR, '.warmup-lock');
const DB_DOWNLOAD_TIMEOUT_MS = parseInt(process.env.SB_DB_TIMEOUT_MS || '180000', 10);
const LOCK_STALE_MS = DB_DOWNLOAD_TIMEOUT_MS;

function getChromeExecutable(): string {
  const candidates: string[] =
    process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
        ];

  const found = candidates.find(p => fs.existsSync(p));
  if (found) return found;

  try {
    const playwrightPath = playwrightChromium.executablePath();
    if (fs.existsSync(playwrightPath)) return playwrightPath;
  } catch {}

  return 'google-chrome';
}

function findSystemSafeBrowsingDir(): string | null {
  const candidates =
    process.platform === 'darwin'
      ? [path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Safe Browsing')]
      : [
          '/opt/oobee-safe-browsing/Safe Browsing',
          path.join(os.homedir(), '.config', 'google-chrome', 'Safe Browsing'),
          path.join(os.homedir(), '.config', 'chromium', 'Safe Browsing'),
        ];
  return candidates.find(isDbDir) ?? null;
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
  try {
    process.kill(-chrome.pid, 'SIGKILL');
  } catch {
    try { chrome.kill('SIGKILL'); } catch {}
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
  // download local hash-prefix databases. Enhanced protection relies on OHTTP
  // real-time checks which don't work with Playwright/CDP navigations.
  // Standard protection NEEDS local databases, so Chrome downloads them.
  fs.writeFileSync(
    path.join(BASE_PROFILE_DIR, 'Default', 'Preferences'),
    JSON.stringify({ safebrowsing: { enabled: true, enhanced: false } }),
  );

  const exe = getChromeExecutable();

  const isLinuxDocker = process.platform === 'linux' && fs.existsSync('/.dockerenv');
  const baseArgs = [
    `--user-data-dir=${BASE_PROFILE_DIR}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--ignore-certificate-errors',
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
    ...(isLinuxDocker ? [
      '--disable-dev-shm-usage', '--disable-gpu', '--disable-software-rasterizer',
      '--in-process-gpu', '--disable-gpu-compositing',
      '--disable-features=VizDisplayCompositor', '--no-zygote',
      '--ozone-platform=x11',
    ] : []),
  ];

  let spawnEnv: NodeJS.ProcessEnv = { ...process.env };
  let windowArgs: string[] = ['--window-position=-10000,-10000', '--window-size=1,1'];
  let xvfbProcess: ChildProcess | null = null;

  if (process.platform === 'linux' && !process.env.DISPLAY) {
    const displayNum = ':99';
    let xvfbStarted = false;
    try {
      xvfbProcess = spawn('Xvfb', [displayNum, '-screen', '0', '1024x768x24'], {
        stdio: 'ignore',
        detached: true,
      });
      xvfbProcess.unref();
      await new Promise(r => setTimeout(r, 1500));

      if (xvfbProcess.exitCode === null && !xvfbProcess.killed) {
        spawnEnv = { ...process.env, DISPLAY: displayNum };
        xvfbStarted = true;
      } else {
        xvfbProcess = null;
      }
    } catch {
      xvfbProcess = null;
    }

    if (!xvfbStarted) {
      windowArgs = ['--headless=old', '--disable-gpu'];
    }
  }

  const chrome = spawn(
    exe,
    [...baseArgs, ...windowArgs, 'https://www.google.com/generate_204'],
    { stdio: 'ignore', detached: true, env: spawnEnv },
  );

  const maxWait = DB_DOWNLOAD_TIMEOUT_MS;
  const pollInterval = 5_000;
  let waited = 0;
  while (!isDbDir(SB_DIR) && waited < maxWait) {
    await new Promise(r => setTimeout(r, pollInterval));
    waited += pollInterval;
    if (waited % 15_000 === 0) {
      consoleLogger.info(`[SafeBrowsing] Waiting for hash-prefix DB... (${waited / 1000}s)`);
    }
  }

  killChromeTree(chrome);

  if (xvfbProcess?.pid) {
    try { process.kill(xvfbProcess.pid, 'SIGTERM'); } catch {}
  }
}

export async function warmupSafeBrowsingBaseProfile(): Promise<void> {
  consoleLogger.info(`[SafeBrowsing] BASE_PROFILE_DIR: ${BASE_PROFILE_DIR}`);
  consoleLogger.info(`[SafeBrowsing] SB_DIR: ${SB_DIR}`);
  consoleLogger.info(`[SafeBrowsing] isDbDir(SB_DIR): ${isDbDir(SB_DIR)}`);
  if (isDbDir(SB_DIR)) {
    consoleLogger.info('[SafeBrowsing] DB already exists in base profile, skipping warmup');
    return;
  }

  fs.mkdirSync(BASE_PROFILE_DIR, { recursive: true });

  const systemSbDir = findSystemSafeBrowsingDir();
  consoleLogger.info(`[SafeBrowsing] findSystemSafeBrowsingDir() = ${systemSbDir}`);
  if (systemSbDir) {
    consoleLogger.info(`[SafeBrowsing] Found system DB at: ${systemSbDir}`);
    const files = fs.readdirSync(systemSbDir);
    consoleLogger.info(`[SafeBrowsing] Files in system DB: ${files.join(', ')}`);
    printMessage(['Copying Safe Browsing threat database from system Chrome profile...'], messageOptions);
    copyDirectory(systemSbDir, SB_DIR);
    printMessage(['Google Safe Browsing enabled (real-time URL protection active)'], messageOptions);
    return;
  }

  const exe = getChromeExecutable();
  const chromeFound = fs.existsSync(exe);
  consoleLogger.info(`[SafeBrowsing] Chrome executable: ${exe}, found: ${chromeFound}`);
  if (!chromeFound) {
    printMessage(['WARNING: Google Chrome not found. Safe Browsing requires Chrome (not Chromium). On Linux Docker, build with --platform linux/amd64.'], messageOptions);
    return;
  }

  if (!acquireLock()) {
    consoleLogger.info('Another process is downloading Safe Browsing DB; waiting...');
    const waitStart = Date.now();
    while (!isDbDir(SB_DIR) && Date.now() - waitStart < DB_DOWNLOAD_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, 5_000));
    }
    if (isDbDir(SB_DIR)) {
      printMessage(['Google Safe Browsing enabled (real-time URL protection active)'], messageOptions);
    }
    return;
  }

  try {
    await spawnChromeForWarmup();

    if (isDbDir(SB_DIR)) {
      printMessage(['Google Safe Browsing enabled (real-time URL protection active)'], messageOptions);
    } else {
      printMessage([`WARNING: Safe Browsing DB did not populate in ${DB_DOWNLOAD_TIMEOUT_MS / 1000}s. Protection may be reduced.`], messageOptions);
    }
  } finally {
    releaseLock();
  }
}

export function injectSafeBrowsingDb(targetDir: string): void {
  consoleLogger.info(`[SafeBrowsing] injectSafeBrowsingDb(${targetDir})`);
  consoleLogger.info(`[SafeBrowsing] isDbDir(SB_DIR=${SB_DIR}): ${isDbDir(SB_DIR)}`);
  if (!isDbDir(SB_DIR)) {
    consoleLogger.info('[SafeBrowsing] No DB to inject — setting preferences only');
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
    consoleLogger.info(`[SafeBrowsing] Wrote preferences to ${prefsPath} (has OHTTP key: ${!!((prefs.safebrowsing as any)?.hash_real_time_ohttp_key)})`);
    return;
  }
  if (fs.existsSync(path.join(targetDir, SEEDED_MARKER))) {
    consoleLogger.info('[SafeBrowsing] Already seeded (marker exists), skipping');
    return;
  }

  consoleLogger.info('[SafeBrowsing] Copying DB + setting preferences');
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
  consoleLogger.info(`[SafeBrowsing] Wrote preferences to ${prefsPath}: ${JSON.stringify(prefs.safebrowsing)}`);

  fs.writeFileSync(path.join(targetDir, SEEDED_MARKER), new Date().toISOString());
  consoleLogger.info('[SafeBrowsing] Injection complete');
}

export async function ensureAndInjectSafeBrowsing(targetDir: string): Promise<void> {
  if (!process.env.GOOGLE_SAFE_BROWSING) return;
  consoleLogger.info(`[SafeBrowsing] ensureAndInjectSafeBrowsing(${targetDir})`);

  if (process.platform === 'win32') {
    printMessage(['Google Safe Browsing is not yet supported on Windows.'], messageOptions);
    return;
  }

  await warmupSafeBrowsingBaseProfile();
  injectSafeBrowsingDb(targetDir);
  consoleLogger.info('[SafeBrowsing] ensureAndInjectSafeBrowsing complete');
}
