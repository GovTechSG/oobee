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
  // optional include-only list of domain patterns (from INCLUDE_PROXY env)
  includeList?: string[];
}

export interface ProxySettings {
  server: string;
  username?: string;
  password?: string;
  bypass?: string;
}

// New discriminated union that the launcher can switch on
export type ProxyResolution =
  | { kind: 'manual'; settings: ProxySettings }   // Playwright proxy option
  | { kind: 'pac'; pacUrl: string; bypass?: string } // Use --proxy-pac-url
  | { kind: 'none' };    

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
/**
 * Try to read an Internet Password from macOS Keychain for a given host/account.
 * We intentionally avoid passing any user-controlled strings; host/account come from scutil.
 * Returns the password (raw) or undefined.
 */
export function keychainFindInternetPassword(host: string, account?: string): string | undefined {
  console.log("Attempting to find internet proxy password in macOS keychain...");

  // Only attempt on macOS, in an interactive session, or when explicitly allowed.
  if (process.platform !== 'darwin') return undefined;
  const allow = process.stdin.isTTY || process.env.ENABLE_KEYCHAIN_LOOKUP === '1';
  if (!allow) return undefined;

  const SECURITY_BIN = '/usr/bin/security';
  const OUTPUT_LIMIT = 64 * 1024; // 64 KiB

  // Verify absolute binary and realpath
  try {
    if (!fs.existsSync(SECURITY_BIN)) return undefined;
    const real = fs.realpathSync(SECURITY_BIN);
    if (real !== SECURITY_BIN) return undefined;
  } catch {
    return undefined;
  }

  // Minimal sanitized env (avoid proxy/env influence)
  const env = {
    PATH: '/usr/bin:/bin',
    http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '',
    NODE_OPTIONS: '', NODE_PATH: '', DYLD_LIBRARY_PATH: '', LD_LIBRARY_PATH: '',
  } as NodeJS.ProcessEnv;

  const baseArgs = ['find-internet-password', '-s', host, '-w'];
  const args = account ? [...baseArgs, '-a', account] : baseArgs;

  // No timeout: allow user to respond to Keychain prompt
  const res = spawnSync(SECURITY_BIN, args, {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (!res.error && res.status === 0 && res.stdout) {
    const out = res.stdout.slice(0, OUTPUT_LIMIT).replace(/\r?\n$/, '');
    return out || undefined;
  }

  // Retry without account if first try used one
  if (account) {
    const retry = spawnSync(SECURITY_BIN, baseArgs, {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!retry.error && retry.status === 0 && retry.stdout) {
      const out = retry.stdout.slice(0, OUTPUT_LIMIT).replace(/\r?\n$/, '');
      return out || undefined;
    }
  }

  // Common Keychain errors you may see in retry.stderr:
  // - "User interaction is not allowed." (Keychain locked / non-interactive / no UI permission)
  // - "The specified item could not be found in the keychain."
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

  // Collect per-protocol creds (Apple keys vary by macOS version)
  const httpUser = pick(map, ['HTTPProxyUsername', 'HTTPUser', 'HTTPUsername']);
  let   httpPass = pick(map, ['HTTPProxyPassword', 'HTTPPassword']);
  const httpsUser = pick(map, ['HTTPSProxyUsername', 'HTTPSUser', 'HTTPSUsername']);
  let   httpsPass = pick(map, ['HTTPSProxyPassword', 'HTTPSPassword']);
  const socksUser = pick(map, ['SOCKSProxyUsername', 'SOCKSUser', 'SOCKSUsername']);
  let   socksPass = pick(map, ['SOCKSProxyPassword', 'SOCKSPassword']);

  // Manual proxies (always set host:port only; never include creds)
  if (map['HTTPEnable'] === '1' && map['HTTPProxy'] && map['HTTPPort']) {
    const hostPort = `${map['HTTPProxy']}:${map['HTTPPort']}`;
    info.http = hostPort;
    // If macOS has username but no password, try Keychain for this host/account
    if (httpUser && !httpPass) httpPass = keychainFindInternetPassword(extractHost(hostPort), httpUser);
  }

  if (map['HTTPSEnable'] === '1' && map['HTTPSProxy'] && map['HTTPSPort']) {
    const hostPort = `${map['HTTPSProxy']}:${map['HTTPSPort']}`;
    info.https = hostPort;
    if (httpsUser && !httpsPass) httpsPass = keychainFindInternetPassword(extractHost(hostPort), httpsUser);
  }

  if (map['SOCKSEnable'] === '1' && map['SOCKSProxy'] && map['SOCKSPort']) {
    const hostPort = `${map['SOCKSProxy']}:${map['SOCKSPort']}`;
    info.socks = hostPort;
    if (socksUser && !socksPass) socksPass = keychainFindInternetPassword(extractHost(hostPort), socksUser);
  }

  // Choose one set of creds to expose globally: prefer HTTP, else HTTPS, else SOCKS
  // (Do not overwrite if env already provided username/password.)
  if (!info.username && !info.password) {
    if (httpUser && httpPass) {
      info.username = httpUser;
      info.password = httpPass;
    } else if (httpsUser && httpsPass) {
      info.username = httpsUser;
      info.password = httpsPass;
    } else if (socksUser && socksPass) {
      info.username = socksUser;
      info.password = socksPass;
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
  if ((!info.username || !info.password)) {
    const envCreds = readCredsFromEnv();
    if (envCreds.username && envCreds.password) {
      info.username = info.username || envCreds.username;
      info.password = info.password || envCreds.password;
    }
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
  const enabledManual = !!v.ProxyEnable && v.ProxyEnable !== '0' && v.ProxyEnable.toLowerCase() !== '0x0';
  const enabledAuto   = !!v.AutoDetect && v.AutoDetect !== '0' && v.AutoDetect.toLowerCase() !== '0x0';
  const anyEnabled    = enabledManual || enabledAuto || !!v.AutoConfigURL;

  // PAC + autodetect (only when something is actually enabled)
  if (v.AutoConfigURL) info.pacUrl = v.AutoConfigURL.trim(); // PAC stands on its own
  if (enabledAuto) info.autoDetect = true;                    // autodetect still gated

  // Manual proxies
  if (enabledManual && v.ProxyServer) {
    const s = v.ProxyServer.trim();
    if (s.includes('=')) {
      for (const part of s.split(/[,;]/)) {
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
  if (anyEnabled && v.ProxyOverride) info.bypassList = semiJoin(v.ProxyOverride.split(/[,;]/));

  // Env creds as global fallback (Windows does not store proxy creds in ProxyServer)
  const { username, password } = readCredsFromEnv();
  if (username && password) { info.username = username; info.password = password; }

  return (info.pacUrl || info.http || info.https || info.socks || info.autoDetect || info.bypassList) ? info : null;
}

/* ============================ Public API ============================ */

export function getProxyInfo(): ProxyInfo | null {
  const plat = os.platform();
  let info: ProxyInfo | null;
  if (plat === 'win32') info = parseEnvProxyCommon() || parseWindowsRegistry();
  else if (plat === 'darwin') info = parseEnvProxyCommon() || parseMacScutil();
  else info = parseEnvProxyCommon(); // Linux/others

  // Apply INCLUDE_PROXY env: semicolon-separated domain globs that SHOULD use the proxy
  const includeProxy = process.env.INCLUDE_PROXY;
  if (includeProxy && info) {
    const patterns = includeProxy
      .split(/[,;]/)
      .map(s => s.trim())
      .filter(Boolean);
    if (patterns.length > 0) {
      // INCLUDE_PROXY and NO_PROXY are mutually exclusive; INCLUDE_PROXY takes precedence
      const noProxy = process.env.NO_PROXY || process.env.no_proxy;
      if (noProxy || info.bypassList) {
        console.warn(
          'INCLUDE_PROXY is set — ignoring NO_PROXY / bypass list. ' +
          'These two settings cannot be mixed; INCLUDE_PROXY takes precedence.',
        );
        info.bypassList = undefined;
      }
      info.includeList = patterns;
    }
  }

  return info;
}

/**
 * Convert a glob-style domain pattern (e.g. *.example.com) to a regex source string.
 */
function domainPatternToRegex(pattern: string): string {
  // Escape dots, replace * with [^.]* or .* depending on position
  // *.example.com → match any subdomain of example.com
  let escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials except *
    .replace(/\*/g, '.*'); // convert glob * to regex .*
  return `^${escaped}$`;
}

/**
 * Build a PAC script that routes only includeList domains through the given proxy,
 * and returns DIRECT for everything else.
 */
function buildIncludeOnlyPac(proxyServer: string, includeList: string[]): string {
  // proxyServer is like "http://host:port" or "socks5://host:port"
  let pacProxy: string;
  if (proxyServer.startsWith('socks5://')) {
    pacProxy = `SOCKS5 ${proxyServer.replace('socks5://', '')}`;
  } else if (proxyServer.startsWith('socks://') || proxyServer.startsWith('socks4://')) {
    pacProxy = `SOCKS ${proxyServer.replace(/^socks[4]?:\/\//, '')}`;
  } else {
    // http:// or https:// → PROXY host:port
    pacProxy = `PROXY ${proxyServer.replace(/^https?:\/\//, '')}`;
  }

  // Build JS conditions using shExpMatch (built-in PAC function that supports glob patterns)
  const conditions = includeList
    .map(pattern => `shExpMatch(host, ${JSON.stringify(pattern)})`)
    .join(' || ');

  const pac = [
    'function FindProxyForURL(url, host) {',
    `  if (${conditions}) {`,
    `    return ${JSON.stringify(pacProxy)};`,
    '  }',
    '  return "DIRECT";',
    '}',
  ].join('\n');

  return pac;
}

export function proxyInfoToResolution(info: ProxyInfo | null): ProxyResolution {
  if (!info) return { kind: 'none' };

  // If INCLUDE_PROXY is set, generate a PAC that only proxies the listed domains
  if (info.includeList && info.includeList.length > 0) {
    // Determine the proxy server string
    let proxyServer: string | undefined;
    if (info.http) proxyServer = `http://${info.http}`;
    else if (info.https) proxyServer = `http://${info.https}`;
    else if (info.socks) proxyServer = `socks5://${info.socks}`;

    if (proxyServer) {
      // If credentials exist, embed them for the manual proxy auth
      // PAC scripts themselves don't carry auth, but Playwright's proxy option can
      // We use PAC for routing, and if creds are needed, Playwright will prompt or
      // we set them via the proxy option. Unfortunately Playwright doesn't allow
      // proxy.username with a PAC, so we embed in the launch arg and rely on
      // Chromium's built-in auth handler for proxy auth challenges.
      const pac = buildIncludeOnlyPac(proxyServer, info.includeList);
      const pacDataUrl = `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pac).toString('base64')}`;
      return { kind: 'pac', pacUrl: pacDataUrl, bypass: info.bypassList };
    }
  }

  // Prefer manual proxies first (these work with Playwright's proxy option)
  if (info.http) {
    return { kind: 'manual', settings: {
      server: `http://${info.http}`,
      username: info.username,
      password: info.password,
      bypass: info.bypassList,
    }};
  }
  if (info.https) {
    return { kind: 'manual', settings: {
      server: `http://${info.https}`,
      username: info.username,
      password: info.password,
      bypass: info.bypassList,
    }};
  }
  if (info.socks) {
    return { kind: 'manual', settings: {
      server: `socks5://${info.socks}`,
      username: info.username,
      password: info.password,
      bypass: info.bypassList,
    }};
  }

  // PAC → handle via Chromium args; do NOT try proxy.server = 'pac+...'
  if (info.pacUrl) {
    // Minor hardening: prefer 127.0.0.1 over localhost for loopback PAC
    const pacUrl = info.pacUrl.replace('://localhost', '://127.0.0.1');
    return { kind: 'pac', pacUrl, bypass: info.bypassList };
  }

  // Auto-detect not supported directly
  return { kind: 'none' };
}
