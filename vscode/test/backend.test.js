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
  downloadFromCheckout,
  hostCompatibilityVersion,
  installFromSource,
  installBackend,
  installLayout,
  managedPathBlock,
  normalizedTarget,
  readInstallManifest,
  releaseTarget,
  removeManagedPath,
  sourceCheckoutRoot,
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
  await assert.rejects(
    assertHostSupported({ system: 'linux', abi: 'glibc>=2.17' }, 'linux', ''),
    /glibc version could not be determined.*install from a source checkout/i,
  );
});

test('Linux compatibility falls back to getconf when the extension runtime omits glibc', async () => {
  const reported = await hostCompatibilityVersion('linux', {
    report: { getReport: () => ({ header: { glibcVersionRuntime: '2.36' } }) },
    run: () => { throw new Error('getconf should not run when Node reports glibc'); },
  });
  assert.equal(reported, '2.36');
  const commands = [];
  const run = (command, args, options, callback) => {
    commands.push([command, args, options]);
    callback(null, 'glibc 2.28\n', '');
  };
  const version = await hostCompatibilityVersion('linux', {
    report: { getReport: () => ({ header: {} }) }, run,
  });
  assert.equal(version, '2.28');
  assert.deepEqual(commands, [['getconf', ['GNU_LIBC_VERSION'], { timeout: 3000 }]]);
  await assertHostSupported({ system: 'linux', abi: 'glibc>=2.17' }, 'linux', version);
});

test('Linux compatibility does not misidentify an unknown libc as non-glibc', async () => {
  const missing = await hostCompatibilityVersion('linux', {
    report: { getReport: () => { throw new Error('report unavailable'); } },
    run: (_command, _args, _options, callback) => callback(new Error('getconf unavailable'), '', ''),
  });
  assert.equal(missing, undefined);
  await assert.rejects(
    assertHostSupported({ system: 'linux', abi: 'glibc>=2.17' }, 'linux', missing || ''),
    (error) => /glibc version could not be determined/.test(error.message)
      && /--from-source --add-to-path/.test(error.message)
      && !/non-glibc/.test(error.message),
  );
});

test('a checkout without release metadata supports source installation in development', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cluster-watcher-dev-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const extensionPath = path.join(root, 'vscode');
  await fs.mkdir(extensionPath);
  for (const name of ['install.sh', 'cluster-watcher.spec', 'pyproject.toml']) {
    await fs.writeFile(path.join(root, name), 'test fixture');
  }
  assert.equal(await sourceCheckoutRoot(extensionPath, 'linux'), root);
  assert.equal(await sourceCheckoutRoot(extensionPath, 'win32'), undefined);

  let invocation;
  const executable = await installFromSource(root, false, {
    env: { HOME: '/test-home', XDG_BIN_HOME: '/test-bin' },
    run: (command, args, options, callback) => {
      invocation = { command, args, options };
      callback(null, '', '');
    },
  });
  assert.equal(executable, '/test-bin/cluster-watcher');
  assert.equal(invocation.command, 'bash');
  assert.deepEqual(invocation.args, [path.join(root, 'install.sh'), '--from-source']);
  assert.equal(invocation.options.cwd, root);
  assert.equal(invocation.options.timeout, 20 * 60 * 1000);
  await installFromSource(root, true, {
    env: { HOME: '/test-home' },
    run: (command, args, _options, callback) => {
      assert.equal(command, 'bash');
      assert.deepEqual(args, [path.join(root, 'install.sh'), '--from-source', '--add-to-path']);
      callback(null, '', '');
    },
  });
  await assert.rejects(installFromSource(root, false, {
    env: { HOME: '/test-home' },
    run: (_command, _args, _options, callback) => callback(new Error('failed'), 'build failed', ''),
  }), /Source build failed: build failed/);
  await downloadFromCheckout(root, true, {
    env: { HOME: '/test-home' },
    run: (command, args, _options, callback) => {
      assert.equal(command, 'bash');
      assert.deepEqual(args, [path.join(root, 'install.sh'), '--add-to-path']);
      callback(null, '', '');
    },
  });
  await assert.rejects(downloadFromCheckout(root, false, {
    env: { HOME: '/test-home' },
    run: (_command, _args, _options, callback) => callback(new Error('failed'), '', 'checksum mismatch'),
  }), /Release download failed: checksum mismatch/);
  await fs.writeFile(path.join(extensionPath, 'backend-manifest.json'), '{}');
  assert.equal(await sourceCheckoutRoot(extensionPath, 'linux'), undefined);
});

test('development first-use installation selects the source-built command', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cluster-watcher-dev-choice-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const extensionPath = path.join(root, 'vscode');
  await fs.mkdir(extensionPath);
  for (const name of ['install.sh', 'cluster-watcher.spec', 'pyproject.toml']) {
    await fs.writeFile(path.join(root, name), 'test fixture');
  }
  const values = new Map();
  const context = {
    extensionPath,
    globalState: {
      get: (key) => values.get(key),
      update: async (key, value) => values.set(key, value),
    },
    environmentVariableCollection: { delete() {}, prepend() {} },
  };
  let choices;
  const vscode = {
    ProgressLocation: { Notification: 1 },
    window: {
      showInformationMessage: async () => undefined,
      showQuickPick: async (items) => { choices = items; return items.find((item) => item.mode === 'source' && !item.addToPath); },
      withProgress: async (_options, callback) => callback({ report() {} }),
    },
  };
  let requested;
  const manager = new BackendManager(vscode, context, '0.1.2', {
    sourceInstall: async (checkout, addToPath) => {
      requested = { checkout, addToPath };
      return process.execPath;
    },
  });
  assert.equal(await manager.offerFirstUse('missing-cluster-watcher', true), true);
  assert.deepEqual(requested, { checkout: root, addToPath: false });
  assert.deepEqual(choices.map((item) => item.label), [
    'Download Latest Release and Add to PATH',
    'Download Latest Release (No PATH Change)',
    'Build from Source and Add to PATH',
    'Build from Source (No PATH Change)',
    'Choose Existing Executable',
  ]);
  assert.equal(manager.executable(), process.execPath);
  assert.equal(manager.selection().source, 'external');
});

test('development first-use download selects the verified-release install path', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cluster-watcher-dev-download-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const extensionPath = path.join(root, 'vscode');
  await fs.mkdir(extensionPath);
  for (const name of ['install.sh', 'cluster-watcher.spec', 'pyproject.toml']) {
    await fs.writeFile(path.join(root, name), 'test fixture');
  }
  const values = new Map();
  const context = {
    extensionPath,
    globalState: {
      get: (key) => values.get(key),
      update: async (key, value) => values.set(key, value),
    },
    environmentVariableCollection: { delete() {}, prepend() {} },
  };
  const vscode = {
    ProgressLocation: { Notification: 1 },
    window: {
      showInformationMessage: async () => undefined,
      showQuickPick: async (items) => items.find((item) => item.mode === 'download' && !item.addToPath),
      withProgress: async (_options, callback) => callback({ report() {} }),
    },
  };
  let requested;
  const manager = new BackendManager(vscode, context, '0.1.2', {
    sourceInstall: async () => { throw new Error('source build must not run'); },
    checkoutDownload: async (checkout, addToPath) => {
      requested = { checkout, addToPath };
      return process.execPath;
    },
  });
  assert.equal(await manager.offerFirstUse('missing-cluster-watcher', true), true);
  assert.deepEqual(requested, { checkout: root, addToPath: false });
  assert.equal(manager.executable(), process.execPath);
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
