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
const LOCK_STALE_MS = 180_000;

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
  return fs.readdirSync(dir).some(f => f.startsWith('UrlSoceng.store.') || f.startsWith('UrlMalware.store.'));
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
  printMessage(['Downloading Safe Browsing threat database via Chrome (up to 120s)...'], messageOptions);

  fs.mkdirSync(path.join(BASE_PROFILE_DIR, 'Default'), { recursive: true });
  fs.writeFileSync(
    path.join(BASE_PROFILE_DIR, 'Default', 'Preferences'),
    JSON.stringify({ safebrowsing: { enabled: true, enhanced: false } }),
  );

  const exe = getChromeExecutable();

  const baseArgs = [
    `--user-data-dir=${BASE_PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
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
    [...baseArgs, ...windowArgs, 'about:blank'],
    { stdio: 'ignore', detached: true, env: spawnEnv },
  );

  const maxWait = 120_000;
  const pollInterval = 5_000;
  let waited = 0;
  while (!isDbDir(SB_DIR) && waited < maxWait) {
    await new Promise(r => setTimeout(r, pollInterval));
    waited += pollInterval;
  }

  killChromeTree(chrome);

  if (xvfbProcess?.pid) {
    try { process.kill(xvfbProcess.pid, 'SIGTERM'); } catch {}
  }
}

export async function warmupSafeBrowsingBaseProfile(): Promise<void> {
  if (isDbDir(SB_DIR)) return;

  fs.mkdirSync(BASE_PROFILE_DIR, { recursive: true });

  const systemSbDir = findSystemSafeBrowsingDir();
  if (systemSbDir) {
    printMessage(['Copying Safe Browsing threat database from system Chrome profile...'], messageOptions);
    copyDirectory(systemSbDir, SB_DIR);
    printMessage(['Google Safe Browsing enabled (real-time URL protection active)'], messageOptions);
    return;
  }

  if (!acquireLock()) {
    consoleLogger.info('Another process is downloading Safe Browsing DB; waiting...');
    const waitStart = Date.now();
    while (!isDbDir(SB_DIR) && Date.now() - waitStart < 150_000) {
      await new Promise(r => setTimeout(r, 5_000));
    }
    return;
  }

  try {
    await spawnChromeForWarmup();

    if (isDbDir(SB_DIR)) {
      printMessage(['Google Safe Browsing enabled (real-time URL protection active)'], messageOptions);
    } else {
      printMessage(['WARNING: Safe Browsing DB did not populate. Protection may be reduced.'], messageOptions);
    }
  } finally {
    releaseLock();
  }
}

export function injectSafeBrowsingDb(targetDir: string): void {
  if (!isDbDir(SB_DIR)) return;
  if (fs.existsSync(path.join(targetDir, SEEDED_MARKER))) return;

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

  fs.writeFileSync(path.join(targetDir, SEEDED_MARKER), new Date().toISOString());
}

export async function ensureAndInjectSafeBrowsing(targetDir: string): Promise<void> {
  if (!process.env.GOOGLE_SAFE_BROWSING) return;

  if (process.platform === 'win32') {
    printMessage(['Google Safe Browsing is not yet supported on Windows.'], messageOptions);
    return;
  }

  await warmupSafeBrowsingBaseProfile();
  injectSafeBrowsingDb(targetDir);
}
