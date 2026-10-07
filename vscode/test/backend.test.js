'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  addManagedPath,
  assertHostSupported,
  BackendManager,
  installBackend,
  installLayout,
  managedPathBlock,
  normalizedTarget,
  readInstallManifest,
  releaseTarget,
  removeManagedPath,
  uninstallBackend,
} = require('../backend');

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function releaseManifest(buffer, overrides = {}) {
  return {
    schema_version: 1,
    version: '0.1.2',
    base_url: 'https://github.com/CameronBraunstein/cluster-watcher/releases/download/v0.1.2/',
    targets: [{
      system: 'linux', architecture: 'x86_64', abi: 'glibc>=2.17',
      artifact: 'cluster-watcher-linux-x86_64', size: buffer.length, sha256: digest(buffer),
      ...overrides,
    }],
  };
}

async function temporaryLayout(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cluster-watcher-backend-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    binDir: path.join(root, 'bin'),
    executable: path.join(root, 'bin', 'cluster-watcher'),
    manifest: path.join(root, 'install-manifest.json'),
  };
}

test('release target normalization covers all supported Node host names', () => {
  assert.deepEqual(normalizedTarget('darwin', 'x64'), { system: 'macos', architecture: 'x86_64' });
  assert.deepEqual(normalizedTarget('win32', 'arm64'), { system: 'windows', architecture: 'aarch64' });
  assert.equal(releaseTarget(releaseManifest(Buffer.from('x')), 'linux', 'x64').artifact, 'cluster-watcher-linux-x86_64');
  assert.throws(() => releaseTarget(releaseManifest(Buffer.from('x')), 'freebsd', 'x64'), /No Cluster Watcher backend/);
});

test('minimum OS and glibc versions are compared numerically', async () => {
  await assertHostSupported({ system: 'windows', minimum_version: '10.0.22000' }, 'win32', '10.0.22631');
  await assert.rejects(
    assertHostSupported({ system: 'windows', minimum_version: '10.0.22000' }, 'win32', '10.0.19045'),
    /10\.0\.22000 or newer/,
  );
  await assertHostSupported({ system: 'linux', abi: 'glibc>=2.17' }, 'linux', '2.36');
  await assert.rejects(assertHostSupported({ system: 'linux', abi: 'glibc>=2.17' }, 'linux', '2.16'), /glibc 2\.17/);
});

test('managed install verifies size and checksum, smoke-tests, and records ownership', async (t) => {
  const layout = await temporaryLayout(t);
  const binary = Buffer.from('verified executable bytes');
  let validated;
  const manifest = await installBackend({
    releaseManifest: releaseManifest(binary),
    extensionVersion: '0.1.2',
    layout,
    platform: 'linux',
    architecture: 'x64',
    hostVersion: '2.36',
    fetchImpl: async () => new Response(binary, { headers: { 'content-length': String(binary.length) } }),
    validate: async (filename) => { validated = await fs.readFile(filename, 'utf8'); },
  });

  assert.equal(validated, binary.toString());
  assert.deepEqual(await fs.readFile(layout.executable), binary);
  assert.equal(manifest.owner, 'CameronBraunstein.cluster-watcher');
  assert.equal((await readInstallManifest(layout)).version, '0.1.2');
  assert.equal((await fs.stat(layout.executable)).mode & 0o111, 0o111);
});

test('failed verification leaves no executable or ownership claim', async (t) => {
  const layout = await temporaryLayout(t);
  const binary = Buffer.from('wrong bytes');
  const metadata = releaseManifest(binary, { sha256: '0'.repeat(64) });
  await assert.rejects(installBackend({
    releaseManifest: metadata,
    extensionVersion: '0.1.2',
    layout,
    platform: 'linux',
    hostVersion: '2.36',
    fetchImpl: async () => new Response(binary),
    validate: async () => {},
  }), /checksum mismatch/);
  await assert.rejects(fs.stat(layout.executable), { code: 'ENOENT' });
  assert.equal(await readInstallManifest(layout), undefined);
});

test('managed install never replaces an unowned executable', async (t) => {
  const layout = await temporaryLayout(t);
  const binary = Buffer.from('new bytes');
  await fs.mkdir(layout.binDir, { recursive: true });
  await fs.writeFile(layout.executable, 'user executable');
  await assert.rejects(installBackend({
    releaseManifest: releaseManifest(binary), extensionVersion: '0.1.2', layout,
    platform: 'linux', hostVersion: '2.36',
    fetchImpl: async () => new Response(binary), validate: async () => {},
  }), /not owned by this extension/);
  assert.equal(await fs.readFile(layout.executable, 'utf8'), 'user executable');
});

test('POSIX PATH changes are marked, reversible, and preserve unrelated profile text', async (t) => {
  const layout = await temporaryLayout(t);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cluster-watcher-home-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const binary = Buffer.from('backend');
  await installBackend({
    releaseManifest: releaseManifest(binary), extensionVersion: '0.1.2', layout,
    platform: 'linux', hostVersion: '2.36', fetchImpl: async () => new Response(binary), validate: async () => {},
  });
  await fs.writeFile(path.join(home, '.bashrc'), '# existing\nsource ~/.bashrc_private\n');
  await fs.writeFile(path.join(home, '.bashrc_private'), 'export PROJECT=value\n');

  let ownership = await addManagedPath(layout, {
    platform: 'linux', homedir: home, env: { SHELL: '/bin/bash', PATH: '/usr/bin' },
  });
  assert.equal(ownership.system_path.profile, path.join(home, '.bashrc_private'));
  assert.match(await fs.readFile(ownership.system_path.profile, 'utf8'), /Cluster Watcher VS Code managed PATH/);
  assert.equal(ownership.system_path.block, managedPathBlock(layout.binDir));

  ownership = await removeManagedPath(layout, { platform: 'linux' });
  assert.equal(ownership.system_path.kind, 'none');
  assert.equal(await fs.readFile(path.join(home, '.bashrc_private'), 'utf8'), 'export PROJECT=value\n\n');
});

test('uninstall removes only extension-owned backend files and preserves other data', async (t) => {
  const layout = await temporaryLayout(t);
  const binary = Buffer.from('backend');
  await installBackend({
    releaseManifest: releaseManifest(binary), extensionVersion: '0.1.2', layout,
    platform: 'linux', hostVersion: '2.36', fetchImpl: async () => new Response(binary), validate: async () => {},
  });
  const personal = path.join(layout.root, 'personal.txt');
  await fs.writeFile(personal, 'keep');
  assert.equal(await uninstallBackend(layout), true);
  await assert.rejects(fs.stat(layout.executable), { code: 'ENOENT' });
  await assert.rejects(fs.stat(layout.manifest), { code: 'ENOENT' });
  assert.equal(await fs.readFile(personal, 'utf8'), 'keep');
});

test('Windows user PATH adapter adds and removes only its owned segment', async (t) => {
  const layout = await temporaryLayout(t);
  layout.executable = `${layout.executable}.exe`;
  const binary = Buffer.from('backend');
  await installBackend({
    releaseManifest: releaseManifest(binary, {
      system: 'windows', artifact: 'cluster-watcher-windows-x86_64.exe', minimum_version: '10.0.17763',
    }),
    extensionVersion: '0.1.2', layout, platform: 'win32', architecture: 'x64',
    hostVersion: '10.0.22631', fetchImpl: async () => new Response(binary), validate: async () => {},
  });
  let userPath = 'C:\\Tools;D:\\Programs';
  const windowsPath = { get: async () => userPath, set: async (value) => { userPath = value; } };
  let ownership = await addManagedPath(layout, { platform: 'win32', windowsPath });
  assert.equal(ownership.system_path.kind, 'windows-user');
  assert.equal(userPath.split(';').at(-1), layout.binDir);
  ownership = await removeManagedPath(layout, { platform: 'win32', windowsPath });
  assert.equal(ownership.system_path.kind, 'none');
  assert.equal(userPath, 'C:\\Tools;D:\\Programs');
});

test('managed install locations are host-specific and outside extension storage', () => {
  assert.match(installLayout({ platform: 'linux', homedir: '/home/alice', env: {} }).executable, /\.local\/share\/cluster-watcher\/vscode-backend/);
  assert.match(installLayout({ platform: 'darwin', homedir: '/Users/alice', env: {} }).executable, /Library\/Application Support\/Cluster Watcher/);
  assert.match(installLayout({ platform: 'win32', homedir: 'C:\\Users\\alice', env: { LOCALAPPDATA: 'C:\\Local' } }).executable, /cluster-watcher\.exe$/);
});

test('external backend selection is persistent and can replace a prior choice', async () => {
  const values = new Map();
  const context = {
    extensionPath: '/unused',
    globalState: {
      get: (key) => values.get(key),
      update: async (key, value) => { if (value === undefined) values.delete(key); else values.set(key, value); },
    },
    environmentVariableCollection: { delete() {}, prepend() {} },
  };
  const vscode = {
    window: {
      showOpenDialog: async () => [{ fsPath: process.execPath }],
      showInformationMessage() {},
    },
  };
  const manager = new BackendManager(vscode, context, '0.1.2');
  assert.equal(manager.executable('cluster-watcher'), 'cluster-watcher');
  assert.equal(await manager.chooseExisting(), true);
  assert.equal(manager.executable('cluster-watcher'), process.execPath);
  await manager.setSelection({ source: 'managed' });
  assert.equal(manager.executable('cluster-watcher'), manager.layout.executable);
  manager.ownership = { version: '0.1.1' };
  assert.equal(manager.managedNeedsUpdate(), true);
  manager.ownership.version = '0.1.2';
  assert.equal(manager.managedNeedsUpdate(), false);
});
