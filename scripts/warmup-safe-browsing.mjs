#!/usr/bin/env node
/**
 * Standalone Safe Browsing warmup script for Docker build stage.
 * Calls the warmup function from the compiled oobee source.
 *
 * Usage: node scripts/warmup-safe-browsing.mjs [--profile-dir /path] [--timeout 180000]
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const profileDir = getArg('--profile-dir', undefined);
const timeoutMs = getArg('--timeout', undefined);

if (profileDir) process.env.SB_PROFILE_DIR = profileDir;
if (timeoutMs) process.env.SB_DB_TIMEOUT_MS = timeoutMs;

const { warmupSafeBrowsingBaseProfile } = await import(path.join(__dirname, '..', 'dist', 'safeBrowsingProfile.js'));

try {
  await warmupSafeBrowsingBaseProfile();
  process.exit(0);
} catch (err) {
  console.error('[SafeBrowsing] Warmup failed:', err);
  process.exit(1);
}
