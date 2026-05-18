import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { chromium as playwrightChromium } from 'playwright';
import { consoleLogger } from './logs.js';
const BASE_PROFILE_DIR = path.join(os.homedir(), '.oobee', 'safe-browsing-profile');
const SB_DIR = path.join(BASE_PROFILE_DIR, 'Safe Browsing');
const SEEDED_MARKER = '.sb-seeded';
function getChromeExecutable() {
    const candidates = process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : process.platform === 'win32'
            ? [
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            ]
            : [
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable',
                '/usr/bin/chromium-browser',
                '/usr/bin/chromium',
            ];
    const found = candidates.find(p => fs.existsSync(p));
    if (found)
        return found;
    // Fall back to Playwright's bundled Chromium (available in Docker/CI with ms-playwright image)
    try {
        const playwrightPath = playwrightChromium.executablePath();
        if (fs.existsSync(playwrightPath))
            return playwrightPath;
    }
    catch { }
    return 'google-chrome';
}
// Returns the first system Safe Browsing DB dir that is already populated.
// Checks Chrome then Chromium on Linux (Docker may only have Chromium).
function findSystemSafeBrowsingDir() {
    const candidates = process.platform === 'darwin'
        ? [path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Safe Browsing')]
        : process.platform === 'win32'
            ? [path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data', 'Safe Browsing')]
            : [
                path.join(os.homedir(), '.config', 'google-chrome', 'Safe Browsing'),
                path.join(os.homedir(), '.config', 'chromium', 'Safe Browsing'),
            ];
    return candidates.find(isDbDir) ?? null;
}
function isDbDir(dir) {
    if (!fs.existsSync(dir))
        return false;
    return fs.readdirSync(dir).some(f => f.startsWith('UrlSoceng.store.') || f.startsWith('UrlMalware.store.'));
}
function copyDirectory(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const file of fs.readdirSync(src)) {
        fs.copyFileSync(path.join(src, file), path.join(dst, file));
    }
}
// Spawns a real Chrome/Chromium (no --remote-debugging-pipe) to download the Safe Browsing DB.
// On Linux without a display (Docker), first tries Xvfb; falls back to --headless=old.
async function spawnChromeForWarmup() {
    consoleLogger.info('Downloading Safe Browsing threat database via Chrome (up to 120s)...');
    fs.mkdirSync(path.join(BASE_PROFILE_DIR, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(BASE_PROFILE_DIR, 'Default', 'Preferences'), JSON.stringify({ safebrowsing: { enabled: true, enhanced: false } }));
    const exe = getChromeExecutable();
    const baseArgs = [
        `--user-data-dir=${BASE_PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        // Required when running as non-root in Docker
        ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
    ];
    let spawnEnv = { ...process.env };
    // On Linux without a display, attempt Xvfb so Chrome can run non-headless
    // (headless=new suppresses the Safe Browsing DB download; headless=old is the fallback)
    let windowArgs = ['--window-position=-10000,-10000', '--window-size=1,1'];
    if (process.platform === 'linux' && !process.env.DISPLAY) {
        const displayNum = ':99';
        let xvfbStarted = false;
        try {
            const xvfb = spawn('Xvfb', [displayNum, '-screen', '0', '1024x768x24'], {
                stdio: 'ignore',
                detached: true,
            });
            xvfb.unref();
            await new Promise(r => setTimeout(r, 1500));
            spawnEnv = { ...process.env, DISPLAY: displayNum };
            xvfbStarted = true;
        }
        catch {
            // Xvfb not available
        }
        if (!xvfbStarted) {
            // headless=old runs more background services than headless=new,
            // giving the Safe Browsing updater a chance to fire
            windowArgs = ['--headless=old', '--disable-gpu'];
        }
    }
    const chrome = spawn(exe, [...baseArgs, ...windowArgs, 'about:blank'], { stdio: 'ignore', detached: false, env: spawnEnv });
    const maxWait = 120_000;
    const pollInterval = 5_000;
    let waited = 0;
    while (!isDbDir(SB_DIR) && waited < maxWait) {
        await new Promise(r => setTimeout(r, pollInterval));
        waited += pollInterval;
    }
    try {
        chrome.kill();
    }
    catch { }
}
// Seeds the base profile. Tries system Chrome/Chromium profile first (instant),
// falls back to spawning Chrome/Chromium if no system profile is available.
export async function warmupSafeBrowsingBaseProfile() {
    if (isDbDir(SB_DIR))
        return;
    fs.mkdirSync(BASE_PROFILE_DIR, { recursive: true });
    const systemSbDir = findSystemSafeBrowsingDir();
    if (systemSbDir) {
        consoleLogger.info('Copying Safe Browsing threat database from system Chrome/Chromium profile...');
        copyDirectory(systemSbDir, SB_DIR);
        consoleLogger.info('Safe Browsing threat database ready.');
        return;
    }
    await spawnChromeForWarmup();
    if (isDbDir(SB_DIR)) {
        consoleLogger.info('Safe Browsing threat database ready.');
    }
    else {
        consoleLogger.warn('Safe Browsing DB did not populate; protection may be reduced.');
    }
}
// Copies Safe Browsing DB files from the base profile into targetDir and enables
// safebrowsing in Preferences. Skips if already done (marker file present).
export function injectSafeBrowsingDb(targetDir) {
    if (!isDbDir(SB_DIR))
        return;
    if (fs.existsSync(path.join(targetDir, SEEDED_MARKER)))
        return;
    copyDirectory(SB_DIR, path.join(targetDir, 'Safe Browsing'));
    const defaultDir = path.join(targetDir, 'Default');
    fs.mkdirSync(defaultDir, { recursive: true });
    const prefsPath = path.join(defaultDir, 'Preferences');
    let prefs = {};
    if (fs.existsSync(prefsPath)) {
        try {
            prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
        }
        catch { }
    }
    prefs.safebrowsing = { ...prefs.safebrowsing, enabled: true, enhanced: false };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
    fs.writeFileSync(path.join(targetDir, SEEDED_MARKER), new Date().toISOString());
}
export async function ensureAndInjectSafeBrowsing(targetDir) {
    if (process.env.OOBEE_SAFE_BROWSING !== '1')
        return;
    await warmupSafeBrowsingBaseProfile();
    injectSafeBrowsingDb(targetDir);
}
