// asgard-0003: Safe Browsing prepopulated-zip extraction containment.
// Runs against dist/: `npm run build && npm test`.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';

process.env.OOBEE_DISABLE_TELEMETRY = '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { extractZipBufferSafely } = await import(pathToFileURL(path.join(root, 'dist', 'safeBrowsingProfile.js')).href);

const S_IFLNK = 0o120000;

const build = async entries => {
  const zip = new JSZip();
  for (const e of entries) {
    zip.file(e.name, e.data ?? 'x', {
      dir: !!e.dir,
      createFolders: false,
      ...(e.mode !== undefined && { unixPermissions: e.mode }),
    });
  }
  return zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' });
};

// JSZip normalises names on write, so craft raw names by patching the buffer.
const withRawName = (buf, from, to) => {
  assert.equal(from.length, to.length);
  const a = Buffer.from(from);
  const b = Buffer.from(to);
  let i = buf.indexOf(a);
  assert.ok(i >= 0);
  while (i >= 0) {
    b.copy(buf, i);
    i = buf.indexOf(a, i + 1);
  }
  return buf;
};

let tmp;
let dest;
let outside;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbzip-'));
  dest = path.join(tmp, 'extract');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(dest);
  fs.mkdirSync(outside);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const outsideIsEmpty = () => assert.deepEqual(fs.readdirSync(outside), []);

// Windows only allows creating symlinks with Developer Mode or admin rights.
// Tests that plant a symlink on disk are skipped when that is not possible.
const canCreateSymlinks = (() => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbzip-probe-'));
  try {
    fs.symlinkSync(probeDir, path.join(probeDir, 'link'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
})();
const symlinkSkip = canCreateSymlinks ? false : 'cannot create symlinks on this system';

describe('legitimate Safe Browsing DB archives', () => {
  test('extracts flat DB files', async () => {
    const buf = await build([
      { name: 'UrlMalware.store.4_1', data: 'm' },
      { name: 'UrlSoceng.store.4_1', data: 's' },
    ]);
    await extractZipBufferSafely(buf, dest);
    assert.equal(fs.readFileSync(path.join(dest, 'UrlMalware.store.4_1'), 'utf8'), 'm');
    assert.equal(fs.readFileSync(path.join(dest, 'UrlSoceng.store.4_1'), 'utf8'), 's');
  });

  test('extracts DB nested under "Safe Browsing/"', async () => {
    const buf = await build([
      { name: 'Safe Browsing/', dir: true },
      { name: 'Safe Browsing/UrlMalBin.store.4_1', data: 'b' },
    ]);
    await extractZipBufferSafely(buf, dest);
    assert.equal(fs.readFileSync(path.join(dest, 'Safe Browsing', 'UrlMalBin.store.4_1'), 'utf8'), 'b');
  });
});

describe('malicious archives are refused and nothing escapes', () => {
  test('symlink entry followed by a write through it (zip-slip via symlink)', async () => {
    const buf = await build([
      { name: 'link', data: outside, mode: S_IFLNK | 0o777 },
      { name: 'link/evil', data: 'pwned' },
    ]);
    await assert.rejects(extractZipBufferSafely(buf, dest), /symlink/);
    outsideIsEmpty();
    assert.deepEqual(fs.readdirSync(dest), [], 'nothing written before validation');
  });

  test('lone symlink entry', async () => {
    const buf = await build([{ name: 'UrlMalware.store.4_1', data: '/etc/passwd', mode: S_IFLNK | 0o777 }]);
    await assert.rejects(extractZipBufferSafely(buf, dest), /symlink/);
  });

  test('"../" traversal', async () => {
    const buf = withRawName(await build([{ name: 'xx/escape.txt' }]), 'xx/escape.txt', '../escape.txt');
    await assert.rejects(extractZipBufferSafely(buf, dest), /traversal/);
    assert.equal(fs.existsSync(path.join(tmp, 'escape.txt')), false);
  });

  test('absolute path', async () => {
    const buf = withRawName(await build([{ name: 'xabs.txt' }]), 'xabs.txt', '/abs.txt');
    await assert.rejects(extractZipBufferSafely(buf, dest), /unsafe/);
  });

  test('backslash / Windows-style path', async () => {
    const buf = withRawName(await build([{ name: 'a_b.txt' }]), 'a_b.txt', 'a\\b.txt');
    await assert.rejects(extractZipBufferSafely(buf, dest), /unsafe/);
  });

  test('pre-planted symlink at a target path is not written through', { skip: symlinkSkip }, async () => {
    fs.symlinkSync(path.join(outside, 'victim'), path.join(dest, 'UrlMalware.store.4_1'), 'file');
    const buf = await build([{ name: 'UrlMalware.store.4_1', data: 'pwned' }]);
    await assert.rejects(extractZipBufferSafely(buf, dest));
    outsideIsEmpty();
  });

  test('pre-planted symlinked parent dir is not followed', { skip: symlinkSkip }, async () => {
    fs.symlinkSync(outside, path.join(dest, 'Safe Browsing'), 'junction');
    const buf = await build([{ name: 'Safe Browsing/UrlMalware.store.4_1', data: 'pwned' }]);
    await assert.rejects(extractZipBufferSafely(buf, dest), /escapes/);
    outsideIsEmpty();
  });
});
