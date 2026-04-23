import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { consoleLogger } from './logs.js';

const BASE_PROFILE_DIR = path.join(os.homedir(), '.oobee', 'safe-browsing-profile');
const SB_DIR = path.join(BASE_PROFILE_DIR, 'Safe Browsing');
const SEEDED_MARKER = '.sb-seeded';

function getChromeExecutable(): string {
  const candidates: string[] =
    process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser'];
  return candidates.find(p => fs.existsSync(p)) ?? 'google-chrome';
}

function getSystemChromeSafeBrowsingDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Safe Browsing');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data', 'Safe Browsing');
  }
  return path.join(os.homedir(), '.config', 'google-chrome', 'Safe Browsing');
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

// Spawns real Chrome (no --remote-debugging-pipe) to download the Safe Browsing DB.
async function spawnChromeForWarmup(): Promise<void> {
  consoleLogger.info('Downloading Safe Browsing threat database via Chrome (up to 90s)...');

  fs.mkdirSync(path.join(BASE_PROFILE_DIR, 'Default'), { recursive: true });
  fs.writeFileSync(
    path.join(BASE_PROFILE_DIR, 'Default', 'Preferences'),
    JSON.stringify({ safebrowsing: { enabled: true, enhanced: false } }),
  );

  // Run without --headless so Chrome's component updater fires (headless suppresses it).
  // Minimise the window to avoid showing up on screen.
  const chrome = spawn(
    getChromeExecutable(),
    [
      `--user-data-dir=${BASE_PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-position=-10000,-10000',
      '--window-size=1,1',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  const maxWait = 120_000;
  const pollInterval = 5_000;
  let waited = 0;
  while (!isDbDir(SB_DIR) && waited < maxWait) {
    await new Promise(r => setTimeout(r, pollInterval));
    waited += pollInterval;
  }
  try { chrome.kill(); } catch {}
}

// Seeds the base profile. Tries system Chrome profile first (instant),
// falls back to spawning Chrome if system profile unavailable.
export async function warmupSafeBrowsingBaseProfile(): Promise<void> {
  if (isDbDir(SB_DIR)) return;

  fs.mkdirSync(BASE_PROFILE_DIR, { recursive: true });

  const systemSbDir = getSystemChromeSafeBrowsingDir();
  if (isDbDir(systemSbDir)) {
    consoleLogger.info('Copying Safe Browsing threat database from system Chrome profile...');
    copyDirectory(systemSbDir, SB_DIR);
    consoleLogger.info('Safe Browsing threat database ready.');
    return;
  }

  await spawnChromeForWarmup();

  if (isDbDir(SB_DIR)) {
    consoleLogger.info('Safe Browsing threat database ready.');
  } else {
    consoleLogger.warn('Safe Browsing DB did not populate; protection may be reduced.');
  }
}

// Copies Safe Browsing DB files from the base profile into targetDir and enables
// safebrowsing in Preferences. Skips if already done (marker file present).
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
  if (process.env.OOBEE_SAFE_BROWSING !== '1') return;
  await warmupSafeBrowsingBaseProfile();
  injectSafeBrowsingDb(targetDir);
}
