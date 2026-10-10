/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';

// asgard-0008 (2026-10-09 re-scan): previously built a shell command string via
// exec(), with argv interpolated unescaped into it. The only caller passes
// hardcoded literal paths (see package.json's `copyfiles` script), so there is
// no reachable attacker input today — but the pattern is a loaded gun for any
// future caller. Replaced with a direct fs.cpSync, which never touches a
// shell and so has no injection surface regardless of future callers.
const sourceDir = process.argv[2];
const destDir = process.argv[3];

if (!sourceDir || !destDir) {
  console.error('Usage: node copyFiles.js <sourceDir> <destDir>');
  process.exit(1);
}

try {
  // Matches the old `mkdir -p destDir && cp -vr sourceDir destDir` behaviour:
  // the source is copied INTO destDir as destDir/<basename(sourceDir)>, not
  // destDir's contents replaced by sourceDir's contents.
  fs.mkdirSync(destDir, { recursive: true });
  const target = path.join(destDir, path.basename(sourceDir));
  fs.cpSync(sourceDir, target, { recursive: true, force: true });
  console.log(`Copied ${sourceDir} -> ${target}`);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}

