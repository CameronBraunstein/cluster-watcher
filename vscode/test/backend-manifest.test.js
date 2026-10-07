'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createBackendManifest } = require('../scripts/create-backend-manifest');
const { backendManifestProblems } = require('../scripts/check-publish');

test('release manifest generator binds every target to exact bytes and version', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cluster-watcher-release-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('native artifact');
  await fs.writeFile(path.join(directory, 'cluster-watcher-linux-x86_64'), bytes);
  const manifest = await createBackendManifest({
    schema_version: 1,
    targets: [{ system: 'linux', architecture: 'x86_64', artifact: 'cluster-watcher-linux-x86_64' }],
  }, directory, '1.2.3', 'owner/repository');
  assert.equal(manifest.version, '1.2.3');
  assert.equal(manifest.base_url, 'https://github.com/owner/repository/releases/download/v1.2.3/');
  assert.equal(manifest.targets[0].size, bytes.length);
  assert.equal(manifest.targets[0].sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
});

test('publish check rejects missing, stale, or incomplete backend metadata', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cluster-watcher-publish-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const missing = path.join(directory, 'missing.json');
  assert.match(backendManifestProblems({ version: '0.1.2' }, missing)[0], /generate/);
  const stale = path.join(directory, 'backend.json');
  await fs.writeFile(stale, JSON.stringify({ schema_version: 1, version: '0.1.1', targets: [] }));
  const problems = backendManifestProblems({ version: '0.1.2' }, stale);
  assert.ok(problems.some((problem) => /version/.test(problem)));
  assert.ok(problems.some((problem) => /six/.test(problem)));
});
