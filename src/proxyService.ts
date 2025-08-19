// getProxyInfo.ts
// Cross-platform proxy detector for Playwright/Chromium with PAC + credentials + macOS Keychain support.
//
// Windows: WinINET registry (HKCU → HKLM)
// macOS: env vars first, then `scutil --proxy` (reads per-protocol usernames/passwords;
//         if password is missing, fetch it from Keychain via `/usr/bin/security`)
// Linux/others: env vars only
//
// Output precedence in proxyInfoToArgs():
//   1) pacUrl → ["--proxy-pac-url=<url>", ...bypass]
//   2) manual proxies → ["--proxy-server=...", ...bypass] (embeds creds if provided/available)
//   3) autoDetect → ["--proxy-auto-detect", ...bypass]

import os from 'os';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

export interface ProxyInfo {
  // host:port OR user:pass@host:port (no scheme)
  http?: string;
  https?: string;
  socks?: string;
  // PAC + autodetect
  pacUrl?: string;
  autoDetect?: boolean;
  // optional bypass list (semicolon-separated)
  bypassList?: string;
  // optional global credentials to embed (URL-encoded)
  username?: string;
  password?: string;
}

/* ============================ helpers ============================ */

function stripScheme(u: string): string {
  return u.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
}
function semiJoin(arr?: string[]): string | undefined {
  if (!arr) return undefined;
  const cleaned = arr.map(s => s.trim()).filter(Boolean);
  return cleaned.length ? cleaned.join(';') : undefined;
}
function readCredsFromEnv(): { username?: string; password?: string } {
  const username = process.env.PROXY_USERNAME || process.env.HTTP_PROXY_USERNAME || undefined;
  const password = process.env.PROXY_PASSWORD || process.env.HTTP_PROXY_PASSWORD || undefined;
  return { username, password };
}
function hasUserinfo(v: string | undefined): boolean {
  return !!(v && /@/.test(v.split('/')[0]));
}
function withCreds(valueHostPort: string, scheme: 'http'|'https'|'socks5', username?: string, password?: string): string {
  if (!username || !password || hasUserinfo(valueHostPort)) {
    return `${scheme}://${valueHostPort}`;
  }
  const u = encodeURIComponent(username);
  const p = encodeURIComponent(password);
  return `${scheme}://${u}:${p}@${valueHostPort}`;
}
function pick(map: Record<string, string>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = map[k];
    if (v && String(v).trim().length) return String(v).trim();
  }
  return undefined;
}
function extractHost(valueHostPort: string): string {
  // valueHostPort may be "user:pass@host:port" or "host:port"
  const noUser = valueHostPort.includes('@') ? valueHostPort.split('@', 2)[1] : valueHostPort;
  return noUser.split(':', 2)[0];
}

/* ============================ env (macOS + Linux) ============================ */

function parseEnvProxyCommon(): ProxyInfo | null {
  const http = process.env.HTTP_PROXY || process.env.http_proxy || '';
  const https = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  const socks = process.env.ALL_PROXY || process.env.all_proxy || '';
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';

  const info: ProxyInfo = {};
  if (http) info.http = stripScheme(http);
  if (https) info.https = stripScheme(https);
  if (socks) info.socks = stripScheme(socks);
  if (noProxy) info.bypassList = semiJoin(noProxy.split(/[,;]/));

  const { username, password } = readCredsFromEnv();
  if (username && password) { info.username = username; info.password = password; }

  return (info.http || info.https || info.socks || info.bypassList) ? info : null;
}

/* ============================ macOS Keychain ============================ */

function securityExe(): string | null {
  const abs = '/usr/bin/security';
  return fs.existsSync(abs) ? abs : null;
}

/**
 * Try to read an Internet Password from macOS Keychain for a given host/account.
 * We intentionally avoid passing any user-controlled strings; host/account come from scutil.
 * Returns the password (raw) or undefined.
 */
function keychainFindInternetPassword(host: string, account?: string): string | undefined {
  const sec = securityExe();
  if (!sec || !host) return undefined;

  const baseArgs = ['find-internet-password', '-s', host, '-w'];
  let attempt = spawnSync(sec, account ? [...baseArgs, '-a', account] : baseArgs, {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  if (!attempt.error && attempt.status === 0 && attempt.stdout) {
    return attempt.stdout.replace(/\r?\n$/, '');
  }

  // Retry without account if first attempt failed and we had specified one
  if (account) {
    attempt = spawnSync(sec, baseArgs, {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
    });
    if (!attempt.error && attempt.status === 0 && attempt.stdout) {
      return attempt.stdout.replace(/\r?\n$/, '');
    }
  }
  return undefined;
}

/* ============================ macOS fallback (scutil) ============================ */

function parseMacScutil(): ProxyInfo | null {
  const out = spawnSync('/usr/sbin/scutil', ['--proxy'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  if (out.error || !out.stdout) return null;

  const map: Record<string, string> = {};
  for (const line of out.stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9]+)\s*:\s*(.+?)\s*$/);
    if (m) map[m[1]] = m[2];
  }

  const info: ProxyInfo = {};

  // PAC + autodetect
  if (map['ProxyAutoConfigEnable'] === '1' && map['ProxyAutoConfigURLString']) {
    info.pacUrl = map['ProxyAutoConfigURLString'].trim();
  }
  if (map['ProxyAutoDiscoveryEnable'] === '1') info.autoDetect = true;

  // Per-protocol credentials (Apple has used different keys across versions)
  const httpUser = pick(map, ['HTTPProxyUsername', 'HTTPUser', 'HTTPUsername']);
  let   httpPass = pick(map, ['HTTPProxyPassword', 'HTTPPassword']); // may be missing
  const httpsUser = pick(map, ['HTTPSProxyUsername', 'HTTPSUser', 'HTTPSUsername']);
  let   httpsPass = pick(map, ['HTTPSProxyPassword', 'HTTPSPassword']);
  const socksUser = pick(map, ['SOCKSProxyUsername', 'SOCKSUser', 'SOCKSUsername']);
  let   socksPass = pick(map, ['SOCKSProxyPassword', 'SOCKSPassword']);

  // Manual proxies (host:port OR user:pass@host:port)
  if (map['HTTPEnable'] === '1' && map['HTTPProxy'] && map['HTTPPort']) {
    const hostPort = `${map['HTTPProxy']}:${map['HTTPPort']}`;
    // If macOS has username but no password, try Keychain for this host/account
    if (httpUser && !httpPass) {
      httpPass = keychainFindInternetPassword(extractHost(hostPort), httpUser);
    }
    if (httpUser && httpPass) {
      info.http = `${encodeURIComponent(httpUser)}:${encodeURIComponent(httpPass)}@${hostPort}`;
    } else {
      info.http = hostPort;
    }
  }
  if (map['HTTPSEnable'] === '1' && map['HTTPSProxy'] && map['HTTPSPort']) {
    const hostPort = `${map['HTTPSProxy']}:${map['HTTPSPort']}`;
    if (httpsUser && !httpsPass) {
      httpsPass = keychainFindInternetPassword(extractHost(hostPort), httpsUser);
    }
    if (httpsUser && httpsPass) {
      info.https = `${encodeURIComponent(httpsUser)}:${encodeURIComponent(httpsPass)}@${hostPort}`;
    } else {
      info.https = hostPort;
    }
  }
  if (map['SOCKSEnable'] === '1' && map['SOCKSProxy'] && map['SOCKSPort']) {
    const hostPort = `${map['SOCKSProxy']}:${map['SOCKSPort']}`;
    if (socksUser && !socksPass) {
      socksPass = keychainFindInternetPassword(extractHost(hostPort), socksUser);
    }
    if (socksUser && socksPass) {
      info.socks = `${encodeURIComponent(socksUser)}:${encodeURIComponent(socksPass)}@${hostPort}`;
    } else {
      info.socks = hostPort;
    }
  }

  // Bypass list
  let exceptions: string[] = [];
  if (map['ExceptionsList']) {
    const quoted = [...map['ExceptionsList'].matchAll(/"([^"]+)"/g)].map(m => m[1]);
    exceptions = quoted.length
      ? quoted
      : map['ExceptionsList'].replace(/[<>{}()]/g, ' ')
          .split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  }
  if (map['ExcludeSimpleHostnames'] === '1' && !exceptions.includes('<local>')) exceptions.unshift('<local>');
  const bypassList = semiJoin(exceptions);
  if (bypassList) info.bypassList = bypassList;

  // If scutil did not provide creds anywhere, still allow env creds as global fallback
  if (!hasUserinfo(info.http || '') || !hasUserinfo(info.https || '') || !hasUserinfo(info.socks || '')) {
    const { username, password } = readCredsFromEnv();
    if (username && password) { info.username = username; info.password = password; }
  }

  return (info.pacUrl || info.http || info.https || info.socks || info.autoDetect || info.bypassList) ? info : null;
}

/* ============================ Windows (Registry only) ============================ */

function regExeCandidates(): string[] {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const sys32 = path.join(root, 'System32', 'reg.exe');
  const syswow64 = path.join(root, 'SysWOW64', 'reg.exe');
  const sysnative = path.join(root, 'Sysnative', 'reg.exe'); // for 32-bit node on 64-bit OS
  const set = new Set([sysnative, sys32, syswow64]);
  return [...set].filter(p => p && fs.existsSync(p));
}
function execReg(args: string[]): string | null {
  for (const exe of regExeCandidates()) {
    const out = spawnSync(exe, args, {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
    });
    if (!out.error && out.stdout) return out.stdout;
  }
  return null;
}

type WinVals = {
  ProxyEnable?: string;
  ProxyServer?: string;
  ProxyOverride?: string;
  AutoConfigURL?: string;
  AutoDetect?: string;
};

function readRegVals(hiveKey: string): WinVals | null {
  const stdout = execReg(['query', hiveKey]);
  if (!stdout) return null;

  const take = (name: string) => {
    const m = stdout.match(new RegExp(`\\s${name}\\s+REG_\\w+\\s+(.+)$`, 'mi'));
    return m ? m[1].trim() : '';
  };

  return {
    ProxyEnable:   take('ProxyEnable'),
    ProxyServer:   take('ProxyServer'),
    ProxyOverride: take('ProxyOverride'),
    AutoConfigURL: take('AutoConfigURL'),
    AutoDetect:    take('AutoDetect'),
  };
}

function parseWindowsRegistry(): ProxyInfo | null {
  const HKCU = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const HKLM = 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

  const cu = readRegVals(HKCU);
  const lm = readRegVals(HKLM);
  const v = cu || lm;
  if (!v) return null;

  const info: ProxyInfo = {};
  const enabled = v.ProxyEnable && v.ProxyEnable !== '0';

  // PAC + autodetect
  if (v.AutoConfigURL) info.pacUrl = v.AutoConfigURL;
  if (v.AutoDetect && v.AutoDetect !== '0') info.autoDetect = true;

  // Manual proxies
  if (enabled && v.ProxyServer) {
    const s = v.ProxyServer.trim();
    if (s.includes('=')) {
      for (const part of s.split(';')) {
        const [proto, addr] = part.split('=');
        if (!proto || !addr) continue;
        const p = proto.trim().toLowerCase();
        const a = stripScheme(addr.trim());
        if (p === 'http') info.http = a;
        else if (p === 'https') info.https = a;
        else if (p === 'socks' || p === 'socks5') info.socks = a;
      }
    } else {
      const a = stripScheme(s);
      info.http = a;
      info.https = a;
    }
  }

  // Bypass list
  if (v.ProxyOverride) info.bypassList = semiJoin(v.ProxyOverride.split(/[,;]/));

  // Env creds as global fallback (Windows does not store proxy creds in ProxyServer)
  const { username, password } = readCredsFromEnv();
  if (username && password) { info.username = username; info.password = password; }

  return (info.pacUrl || info.http || info.https || info.socks || info.autoDetect || info.bypassList) ? info : null;
}

/* ============================ Public API ============================ */

export function getProxyInfo(): ProxyInfo | null {
  const plat = os.platform();
  if (plat === 'win32') return parseWindowsRegistry();
  if (plat === 'darwin') return parseEnvProxyCommon() || parseMacScutil();
  return parseEnvProxyCommon(); // Linux/others
}

export function proxyInfoToArgs(info: ProxyInfo | null): string[] {
  if (!info) return [];

  // 1) PAC takes precedence
  if (info.pacUrl) {
    const args = [`--proxy-pac-url=${info.pacUrl}`];
    if (info.bypassList) args.push(`--proxy-bypass-list=${info.bypassList}`);
    return args;
  }

  // 2) Manual proxies
  const parts: string[] = [];
  const haveGlobalCreds = !!(info.username && info.password);

  if (info.http) {
    parts.push(
      haveGlobalCreds
        ? `http=${withCreds(info.http, 'http', info.username, info.password)}`
        : `http=${hasUserinfo(info.http) ? `http://${info.http}` : info.http}`
    );
  }
  if (info.https) {
    parts.push(
      haveGlobalCreds
        ? `https=${withCreds(info.https, 'https', info.username, info.password)}`
        : `https=${hasUserinfo(info.https) ? `https://${info.https}` : info.https}`
    );
  }
  if (info.socks) {
    parts.push(
      haveGlobalCreds
        ? `socks5=${withCreds(info.socks, 'socks5', info.username, info.password)}`
        : `socks5=${hasUserinfo(info.socks) ? `socks5://${info.socks}` : info.socks}`
    );
  }

  if (parts.length > 0) {
    const args = [`--proxy-server=${parts.join(';')}`];
    if (info.bypassList) args.push(`--proxy-bypass-list=${info.bypassList}`);
    return args;
  }

  // 3) Autodetect
  if (info.autoDetect) {
    const args = ['--proxy-auto-detect'];
    if (info.bypassList) args.push(`--proxy-bypass-list=${info.bypassList}`);
    return args;
  }

  return [];
}
