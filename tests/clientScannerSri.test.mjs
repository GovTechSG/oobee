// asgard-0007: client scanner generator must fail closed without a Sentry SRI pin.
// Runs against dist/: `npm run build && npm test`. No network needed: every
// outbound https request is forced to fail via a --require preload.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generator = path.join(root, 'dist', 'generateOobeeClientScanner.js');
const VALID_SRI = 'sha384-rtfUMq82bneIHVOpL/60roC5pIJ9kDO15w13yGEBKZSJp3aIbrOAhimB61EwPClB';

let tmp;
let preload;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-'));
  preload = path.join(tmp, 'fail-net.cjs');
  fs.writeFileSync(
    preload,
    `const https = require('https');
const { syncBuiltinESMExports } = require('module');
const { EventEmitter } = require('events');
https.request = () => {
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.destroy = () => {};
  req.end = () => setImmediate(() => req.emit('error', new Error('simulated network failure')));
  return req;
};
syncBuiltinESMExports();
`,
  );
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const generate = (out, sri) => {
  const env = { ...process.env, OOBEE_DISABLE_TELEMETRY: '1' };
  delete env.OOBEE_SENTRY_SDK_SRI;
  if (sri !== undefined) env.OOBEE_SENTRY_SDK_SRI = sri;
  return spawnSync(process.execPath, ['--require', preload, generator, out], {
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
};

describe('generateOobeeClientScanner SRI handling', () => {
  test('CDN unreachable and no pin: exits non-zero and writes nothing', () => {
    const out = path.join(tmp, 'nopin.js');
    const r = generate(out);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Refusing to emit a bundle without an SRI pin/);
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.existsSync(`${out}.sha384`), false);
  });

  test('malformed OOBEE_SENTRY_SDK_SRI: exits non-zero and writes nothing', () => {
    const out = path.join(tmp, 'bad.js');
    const r = generate(out, 'sha384-not valid!');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /OOBEE_SENTRY_SDK_SRI is set but is not a valid/);
    assert.equal(fs.existsSync(out), false);
  });

  test('pinned via OOBEE_SENTRY_SDK_SRI: builds offline with integrity set', () => {
    const out = path.join(tmp, 'pinned.js');
    const r = generate(out, VALID_SRI);
    assert.equal(r.status, 0, r.stderr);
    const bundle = fs.readFileSync(out, 'utf8');
    assert.ok(bundle.includes(`_oobeeSentrySdkSri       = "${VALID_SRI}"`));
    assert.ok(bundle.includes('script.integrity = _oobeeSentrySdkSri;'));
    assert.ok(bundle.includes('No SRI pin for the Sentry SDK; refusing to load it.'));
    assert.match(fs.readFileSync(`${out}.sha384`, 'utf8'), /^sha384-/);
  });
});
