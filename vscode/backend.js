'use strict';

/**
 * Download, verify, select, and remove the native Cluster Watcher backend.
 *
 * The managed install deliberately lives outside VS Code's extension storage:
 * removing the extension must not unexpectedly remove a command that the user
 * chose to expose to their terminal. Every mutation is recorded in a small
 * ownership manifest so an unrelated executable or PATH entry is never
 * overwritten or removed.
 */

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const BACKEND_STATE_KEY = 'clusterWatcher.backendSelection.v1';
const INSTALL_MANIFEST_SCHEMA = 1;
const RELEASE_MANIFEST_SCHEMA = 1;
const MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MILLISECONDS = 120000;
const PATH_BLOCK_START = '# >>> Cluster Watcher VS Code managed PATH >>>';
const PATH_BLOCK_END = '# <<< Cluster Watcher VS Code managed PATH <<<';

/** Convert Node's platform and architecture names to release-manifest names. */
function normalizedTarget(platform = process.platform, architecture = process.arch) {
  const systems = { darwin: 'macos', win32: 'windows', linux: 'linux' };
  const architectures = { x64: 'x86_64', amd64: 'x86_64', arm64: 'aarch64' };
  return {
    system: systems[String(platform).toLowerCase()] || String(platform).toLowerCase(),
    architecture: architectures[String(architecture).toLowerCase()] || String(architecture).toLowerCase(),
  };
}

/** Compare dotted numeric OS versions without converting them to floats. */
function compareVersions(left, right) {
  const a = String(left).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right).split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

/** Return the release entry for this extension host, rejecting unsupported hosts. */
function releaseTarget(manifest, platform = process.platform, architecture = process.arch) {
  if (!manifest || manifest.schema_version !== RELEASE_MANIFEST_SCHEMA || !Array.isArray(manifest.targets)) {
    throw new Error('The extension does not contain valid backend download metadata. Reinstall this extension release.');
  }
  const wanted = normalizedTarget(platform, architecture);
  const target = manifest.targets.find((entry) => (
    entry.system === wanted.system && entry.architecture === wanted.architecture
  ));
  if (!target) {
    throw new Error(`No Cluster Watcher backend is published for ${wanted.system}/${wanted.architecture}.`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(target.artifact || '') || !/^[a-f0-9]{64}$/.test(target.sha256 || '')) {
    throw new Error('The extension backend download metadata is malformed. Reinstall this extension release.');
  }
  if (!Number.isSafeInteger(target.size) || target.size < 1 || target.size > MAX_DOWNLOAD_BYTES) {
    throw new Error('The extension backend download size is invalid. Reinstall this extension release.');
  }
  return target;
}

/** Detect the user-facing OS/libc version relevant to a release target. */
async function hostCompatibilityVersion(platform = process.platform) {
  if (platform === 'win32') return os.release();
  if (platform === 'darwin') {
    return new Promise((resolve, reject) => {
      execFile('/usr/bin/sw_vers', ['-productVersion'], (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr).trim() || 'Could not determine the macOS version.'));
        else resolve(String(stdout).trim());
      });
    });
  }
  if (platform === 'linux') return process.report?.getReport()?.header?.glibcVersionRuntime;
  return undefined;
}

/** Reject a native artifact known not to run on this extension host. */
async function assertHostSupported(target, platform = process.platform, detectedVersion) {
  const version = detectedVersion === undefined ? await hostCompatibilityVersion(platform) : detectedVersion;
  if (target.minimum_version && (!version || compareVersions(version, target.minimum_version) < 0)) {
    throw new Error(`${target.system} ${target.minimum_version} or newer is required (this host reports ${version || 'unknown'}).`);
  }
  const glibcMinimum = /^glibc>=(.+)$/.exec(target.abi || '');
  if (glibcMinimum && (!version || compareVersions(version, glibcMinimum[1]) < 0)) {
    throw new Error(`glibc ${glibcMinimum[1]} or newer is required (this host reports ${version || 'a non-glibc runtime'}).`);
  }
}

/** Return conventional, extension-owned paths on the current extension host. */
function installLayout({ platform = process.platform, homedir = os.homedir(), env = process.env } = {}) {
  let root;
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local');
    root = path.join(localAppData, 'Programs', 'ClusterWatcher', 'vscode-backend');
  } else if (platform === 'darwin') {
    root = path.join(homedir, 'Library', 'Application Support', 'Cluster Watcher', 'vscode-backend');
  } else {
    root = path.join(env.XDG_DATA_HOME || path.join(homedir, '.local', 'share'), 'cluster-watcher', 'vscode-backend');
  }
  const binDir = path.join(root, 'bin');
  return {
    root,
    binDir,
    executable: path.join(binDir, platform === 'win32' ? 'cluster-watcher.exe' : 'cluster-watcher'),
    manifest: path.join(root, 'install-manifest.json'),
  };
}

/** Ensure a managed directory itself is not a symbolic link/reparse point. */
async function ensureSafeDirectory(directory) {
  try {
    const stat = await fsp.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Refusing to use non-directory or symbolic-link path: ${directory}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fsp.mkdir(directory, { recursive: true, mode: 0o755 });
    const stat = await fsp.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe managed directory: ${directory}`);
  }
}

/** Read and strictly validate the extension's on-disk ownership record. */
async function readInstallManifest(layout) {
  let raw;
  try {
    const stat = await fsp.lstat(layout.manifest);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe installation manifest: ${layout.manifest}`);
    raw = await fsp.readFile(layout.manifest, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  let manifest;
  try { manifest = JSON.parse(raw); } catch (_error) { throw new Error(`Invalid installation manifest: ${layout.manifest}`); }
  if (manifest.schema_version !== INSTALL_MANIFEST_SCHEMA
      || manifest.owner !== 'CameronBraunstein.cluster-watcher'
      || path.resolve(manifest.executable || '') !== path.resolve(layout.executable)
      || path.resolve(manifest.bin_dir || '') !== path.resolve(layout.binDir)) {
    throw new Error(`Unrecognized installation manifest: ${layout.manifest}`);
  }
  const systemPath = manifest.system_path || { kind: 'none' };
  if (!['none', 'existing', 'posix-profile', 'windows-user'].includes(systemPath.kind)) {
    throw new Error(`Invalid PATH ownership in installation manifest: ${layout.manifest}`);
  }
  if (systemPath.kind === 'posix-profile') {
    const allowedNames = new Set(['.bashrc', '.bashrc_private', '.zshrc', '.zshrc_private', '.profile', '.profile_private']);
    if (!path.isAbsolute(systemPath.profile || '') || !allowedNames.has(path.basename(systemPath.profile))
        || systemPath.block !== managedPathBlock(layout.binDir)) {
      throw new Error(`Unsafe profile ownership in installation manifest: ${layout.manifest}`);
    }
  }
  return manifest;
}

/** Atomically write a private JSON ownership record. */
async function writeInstallManifest(layout, manifest) {
  const temporary = `${layout.manifest}.new-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const backup = `${layout.manifest}.previous-${process.pid}`;
  await fsp.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    if (process.platform === 'win32' && await fsp.stat(layout.manifest).then(() => true, () => false)) {
      await fsp.rename(layout.manifest, backup);
    }
    await fsp.rename(temporary, layout.manifest);
    await fsp.rm(backup, { force: true }).catch(() => {});
  } catch (error) {
    if (await fsp.stat(backup).then(() => true, () => false)) {
      await fsp.rename(backup, layout.manifest).catch(() => {});
    }
    throw error;
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

/** Execute a candidate binary directly, with no shell, before trusting it. */
function smokeTestExecutable(executable, timeoutMilliseconds = 10000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    let child;
    try { child = spawn(executable, ['--help'], { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (error) { finish(error); return; }
    timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Backend startup check exceeded ${timeoutMilliseconds} ms`));
    }, timeoutMilliseconds);
    child.stderr.on('data', (chunk) => { if (stderr.length < 2000) stderr += String(chunk).slice(0, 2000 - stderr.length); });
    child.once('error', finish);
    child.once('close', (code) => finish(code === 0 ? undefined : new Error(stderr.trim() || `Backend startup check exited with status ${code}`)));
  });
}

/** Download one bounded HTTPS response while calculating its SHA-256 digest. */
async function downloadVerified(url, destination, target, {
  fetchImpl = globalThis.fetch,
  timeoutMilliseconds = DOWNLOAD_TIMEOUT_MILLISECONDS,
  onProgress = () => {},
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('This VS Code build cannot download the Cluster Watcher backend.');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Backend downloads require HTTPS.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
  let handle;
  try {
    const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Backend download returned HTTP ${response.status}`);
    if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('Backend download redirected away from HTTPS.');
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) throw new Error('Backend download is unexpectedly large.');
    handle = await fsp.open(destination, 'wx', 0o700);
    const digest = crypto.createHash('sha256');
    const reader = response.body.getReader();
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      received += chunk.length;
      if (received > MAX_DOWNLOAD_BYTES || received > target.size) throw new Error('Backend download exceeded its declared size.');
      digest.update(chunk);
      await handle.writeFile(chunk);
      onProgress(received, target.size);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (received !== target.size) throw new Error(`Backend download size mismatch (expected ${target.size}, received ${received}).`);
    const actual = digest.digest('hex');
    if (actual !== target.sha256) throw new Error(`Backend checksum mismatch (expected ${target.sha256}, received ${actual}).`);
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('Backend download timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
    if (handle) await handle.close().catch(() => {});
  }
}

/** Install an exact-version release artifact without replacing unowned files. */
async function installBackend({
  releaseManifest,
  extensionVersion,
  layout = installLayout(),
  platform = process.platform,
  architecture = process.arch,
  hostVersion,
  fetchImpl = globalThis.fetch,
  validate = smokeTestExecutable,
  beforeReplace = async () => {},
  onProgress = () => {},
} = {}) {
  if (releaseManifest.version !== extensionVersion) {
    throw new Error(`Backend metadata is for ${releaseManifest.version}, but this extension is ${extensionVersion}. Reinstall the extension.`);
  }
  const target = releaseTarget(releaseManifest, platform, architecture);
  await assertHostSupported(target, platform, hostVersion);
  await ensureSafeDirectory(layout.root);
  await ensureSafeDirectory(layout.binDir);
  const ownership = await readInstallManifest(layout);
  let executableStat;
  try { executableStat = await fsp.lstat(layout.executable); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (executableStat && (!executableStat.isFile() || executableStat.isSymbolicLink())) {
    throw new Error(`Refusing to replace non-file or symbolic-link backend: ${layout.executable}`);
  }
  if (executableStat && !ownership) throw new Error(`Refusing to replace an executable not owned by this extension: ${layout.executable}`);

  const base = new URL(releaseManifest.base_url);
  if (base.protocol !== 'https:' || !base.href.endsWith('/')) throw new Error('Backend metadata has an invalid release URL.');
  const artifactUrl = new URL(encodeURIComponent(target.artifact), base);
  const temporary = path.join(layout.binDir, `.cluster-watcher-download-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const backup = `${layout.executable}.previous-${process.pid}`;
  let replaced = false;
  try {
    await downloadVerified(artifactUrl.href, temporary, target, { fetchImpl, onProgress });
    if (platform !== 'win32') await fsp.chmod(temporary, 0o755);
    await validate(temporary);
    await beforeReplace();
    if (executableStat) await fsp.rename(layout.executable, backup);
    await fsp.rename(temporary, layout.executable);
    replaced = true;
    const manifest = {
      schema_version: INSTALL_MANIFEST_SCHEMA,
      owner: 'CameronBraunstein.cluster-watcher',
      version: releaseManifest.version,
      target: `${target.system}/${target.architecture}`,
      artifact: target.artifact,
      sha256: target.sha256,
      executable: layout.executable,
      bin_dir: layout.binDir,
      installed_at: new Date().toISOString(),
      system_path: ownership?.system_path || { kind: 'none' },
    };
    await writeInstallManifest(layout, manifest);
    await fsp.rm(backup, { force: true }).catch(() => {});
    return manifest;
  } catch (error) {
    if (replaced) await fsp.rm(layout.executable, { force: true }).catch(() => {});
    if (await fsp.stat(backup).then(() => true, () => false)) await fsp.rename(backup, layout.executable).catch(() => {});
    throw error;
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

/** Quote one literal path for a POSIX shell profile. */
function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Select the interactive shell profile, including common site-private files. */
async function preferredProfile(homedir, shell = '') {
  const shellName = path.basename(shell);
  const names = shellName === 'bash' ? ['.bashrc', '.bashrc_private']
    : shellName === 'zsh' ? ['.zshrc', '.zshrc_private'] : ['.profile', '.profile_private'];
  const primary = path.join(homedir, names[0]);
  const privateProfile = path.join(homedir, names[1]);
  try {
    const contents = await fsp.readFile(primary, 'utf8');
    const activeLines = contents.split(/\r?\n/).filter((line) => !/^\s*#/.test(line));
    if (activeLines.some((line) => line.includes(names[1]))) return privateProfile;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return primary;
}

/** Build the exact profile fragment recorded for safe later removal. */
function managedPathBlock(binDir) {
  return `${PATH_BLOCK_START}\nexport PATH=${shellSingleQuote(binDir)}:"$PATH"\n${PATH_BLOCK_END}`;
}

/** Read the Windows user PATH without involving a command shell. */
function defaultWindowsPathAdapter() {
  const runPowerShell = (script, env = process.env) => new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr).trim() || error.message));
      else resolve(String(stdout).replace(/[\r\n]+$/, ''));
    });
  });
  return {
    get: () => runPowerShell("[Environment]::GetEnvironmentVariable('Path','User')"),
    set: (value) => runPowerShell(
      "[Environment]::SetEnvironmentVariable('Path',$env:CLUSTER_WATCHER_PATH_VALUE,'User')",
      { ...process.env, CLUSTER_WATCHER_PATH_VALUE: value },
    ),
  };
}

/** Return whether a PATH list already contains a directory. */
function pathContains(value, directory, delimiter = path.delimiter, caseInsensitive = process.platform === 'win32') {
  const normalize = (item) => {
    const normalized = path.resolve(String(item).trim()).replace(/[\\/]+$/, '');
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  };
  const wanted = normalize(directory);
  return String(value || '').split(delimiter).filter(Boolean).some((item) => normalize(item) === wanted);
}

/** Add only the managed bin directory to the user's persistent PATH. */
async function addManagedPath(layout, {
  platform = process.platform,
  homedir = os.homedir(),
  env = process.env,
  windowsPath = defaultWindowsPathAdapter(),
} = {}) {
  const ownership = await readInstallManifest(layout);
  if (!ownership) throw new Error('Install the managed backend before adding it to PATH.');
  if (ownership.system_path?.kind && ownership.system_path.kind !== 'none') return ownership;
  if (platform === 'win32') {
    const current = await windowsPath.get();
    if (pathContains(current, layout.binDir, ';', true)) {
      ownership.system_path = { kind: 'existing' };
    } else {
      await windowsPath.set([current, layout.binDir].filter(Boolean).join(';'));
      ownership.system_path = { kind: 'windows-user' };
    }
  } else {
    const profile = await preferredProfile(homedir, env.SHELL || '');
    let contents = '';
    try {
      const stat = await fsp.lstat(profile);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing to edit non-file or symbolic-link profile: ${profile}`);
      contents = await fsp.readFile(profile, 'utf8');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const block = managedPathBlock(layout.binDir);
    if (pathContains(env.PATH, layout.binDir, ':', false) || contents.includes(block)) {
      ownership.system_path = contents.includes(block)
        ? { kind: 'posix-profile', profile, block }
        : { kind: 'existing' };
    } else {
      const prefix = contents && !contents.endsWith('\n') ? '\n' : '';
      await fsp.writeFile(profile, `${contents}${prefix}\n${block}\n`, { mode: 0o600 });
      ownership.system_path = { kind: 'posix-profile', profile, block };
    }
  }
  await writeInstallManifest(layout, ownership);
  return ownership;
}

/** Remove only a PATH contribution previously recorded as extension-owned. */
async function removeManagedPath(layout, {
  platform = process.platform,
  windowsPath = defaultWindowsPathAdapter(),
} = {}) {
  const ownership = await readInstallManifest(layout);
  if (!ownership) return undefined;
  const record = ownership.system_path || { kind: 'none' };
  if (record.kind === 'posix-profile') {
    const stat = await fsp.lstat(record.profile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing to edit unsafe profile: ${record.profile}`);
    const contents = await fsp.readFile(record.profile, 'utf8');
    if (!contents.includes(record.block)) {
      throw new Error(`The managed PATH block in ${record.profile} was modified; remove it manually.`);
    }
    const updated = contents.replace(`\n${record.block}\n`, '\n').replace(record.block, '');
    await fsp.writeFile(record.profile, updated, { mode: stat.mode & 0o777 });
  } else if (record.kind === 'windows-user') {
    const current = await windowsPath.get();
    const segments = String(current || '').split(';').filter((item) => item && !pathContains(item, layout.binDir, ';', true));
    await windowsPath.set(segments.join(';'));
  }
  ownership.system_path = { kind: 'none' };
  await writeInstallManifest(layout, ownership);
  return ownership;
}

/** Remove only files proven to belong to this extension; preserve all config. */
async function uninstallBackend(layout, options = {}) {
  let ownership = await readInstallManifest(layout);
  if (!ownership) return false;
  if (ownership.system_path?.kind && !['none', 'existing'].includes(ownership.system_path.kind)) {
    ownership = await removeManagedPath(layout, options);
  }
  let stat;
  try { stat = await fsp.lstat(layout.executable); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`Refusing to remove unsafe backend: ${layout.executable}`);
  if (stat) await fsp.unlink(layout.executable);
  await fsp.unlink(layout.manifest);
  return true;
}

/** Load immutable, exact-version backend metadata embedded in a release VSIX. */
async function loadReleaseManifest(extensionPath) {
  const filename = path.join(extensionPath, 'backend-manifest.json');
  let raw;
  try { raw = await fsp.readFile(filename, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('This development build has no backend manifest. Choose an existing executable, or use a release VSIX.');
    }
    throw error;
  }
  try { return JSON.parse(raw); } catch (_error) { throw new Error('The embedded backend manifest is not valid JSON.'); }
}

/** Coordinate install choices and VS Code UI while keeping the core testable. */
class BackendManager {
  constructor(vscode, context, extensionVersion, { onWillChange = async () => {} } = {}) {
    this.vscode = vscode;
    this.context = context;
    this.extensionVersion = extensionVersion;
    this.onWillChange = onWillChange;
    this.layout = installLayout();
    this.ownership = undefined;
  }

  /** Restore ownership state and terminal integration for this extension host. */
  async initialize() {
    this.ownership = await readInstallManifest(this.layout).catch(() => undefined);
    const state = this.selection();
    if (!state && this.ownership) await this.setSelection({ source: 'managed' });
    this.applyTerminalEnvironment();
  }

  selection() { return this.context.globalState.get(BACKEND_STATE_KEY); }

  async setSelection(value) { await this.context.globalState.update(BACKEND_STATE_KEY, value); }

  /** Resolve the command without silently changing an explicit user choice. */
  executable(configuredExecutable = 'cluster-watcher') {
    const state = this.selection();
    if (state?.source === 'managed') return this.layout.executable;
    if (state?.source === 'external' && state.externalExecutablePath) return state.externalExecutablePath;
    return configuredExecutable;
  }

  /** Make the managed command available in new integrated terminals only. */
  applyTerminalEnvironment() {
    const collection = this.context.environmentVariableCollection;
    collection.delete('PATH');
    if (this.selection()?.source === 'managed' && this.ownership) {
      collection.prepend('PATH', `${this.layout.binDir}${path.delimiter}`);
    }
  }

  /** Whether the selected managed backend must be brought to this VSIX version. */
  managedNeedsUpdate() {
    return this.selection()?.source === 'managed'
      && (!this.ownership || this.ownership.version !== this.extensionVersion);
  }

  /** Require consent before replacing an older selected managed backend. */
  async offerManagedUpdate() {
    const update = 'Update Backend';
    const manage = 'Manage Backend';
    const choice = await this.vscode.window.showInformationMessage(
      `Cluster Watcher ${this.extensionVersion} needs its matching backend before it can run.`,
      update, manage,
    );
    if (choice === update) return this.install(false);
    if (choice === manage) await this.manage();
    return !this.managedNeedsUpdate();
  }

  /** Validate current selection; offer all three first-use choices if missing. */
  async ensureAvailable(configuredExecutable = 'cluster-watcher') {
    if (this.managedNeedsUpdate() && !await this.offerManagedUpdate()) {
      throw new Error('The managed backend must be updated to match this extension before use.');
    }
    const executable = this.executable(configuredExecutable);
    try {
      await smokeTestExecutable(executable);
      return executable;
    } catch (originalError) {
      const changed = await this.offerFirstUse(configuredExecutable, true);
      if (changed) {
        const selected = this.executable(configuredExecutable);
        await smokeTestExecutable(selected);
        return selected;
      }
      throw originalError;
    }
  }

  /** Prompt only when no valid choice has ever been made, unless forced. */
  async offerFirstUse(configuredExecutable = 'cluster-watcher', force = false) {
    if (!force && this.managedNeedsUpdate()) return this.offerManagedUpdate();
    if (!force && this.selection()) return false;
    if (!force) {
      try {
        await smokeTestExecutable(configuredExecutable);
        await this.setSelection({ source: 'external', externalExecutablePath: configuredExecutable });
        return true;
      } catch (_error) { /* Offer installation below. */ }
    }
    const installPath = 'Install and Add to PATH';
    const vscodeOnly = 'Use Only in VS Code';
    const choose = 'Choose Existing Executable';
    const choice = await this.vscode.window.showInformationMessage(
      'Cluster Watcher needs its command-line backend on this extension host.',
      installPath, vscodeOnly, choose,
    );
    if (choice === installPath) return Boolean(await this.install(true));
    if (choice === vscodeOnly) return Boolean(await this.install(false));
    if (choice === choose) return Boolean(await this.chooseExisting());
    return false;
  }

  /** Download and activate the exact backend paired with this extension. */
  async install(addToPath) {
    if (this.installation) return this.installation;
    this.installation = this.runInstall(addToPath).finally(() => { this.installation = undefined; });
    return this.installation;
  }

  /** Perform one serialized download/install transaction. */
  async runInstall(addToPath) {
    const releaseManifest = await loadReleaseManifest(this.context.extensionPath);
    let lastPercent = 0;
    const ownership = await this.vscode.window.withProgress({
      location: this.vscode.ProgressLocation.Notification,
      title: `Installing Cluster Watcher ${this.extensionVersion}`,
      cancellable: false,
    }, async (progress) => installBackend({
      releaseManifest,
      extensionVersion: this.extensionVersion,
      layout: this.layout,
      beforeReplace: this.onWillChange,
      onProgress: (received, total) => {
        const percent = Math.floor((received / total) * 100);
        progress.report({ increment: Math.max(0, percent - lastPercent), message: `${percent}%` });
        lastPercent = percent;
      },
    }));
    this.ownership = ownership;
    if (addToPath) this.ownership = await addManagedPath(this.layout);
    await this.setSelection({ source: 'managed' });
    this.applyTerminalEnvironment();
    const onSystemPath = ['posix-profile', 'windows-user', 'existing'].includes(this.ownership.system_path?.kind);
    const pathMessage = addToPath || onSystemPath
      ? ' It is available to new system and VS Code terminals.'
      : ' It is available to the extension and new VS Code terminals.';
    this.vscode.window.showInformationMessage(`Cluster Watcher ${this.extensionVersion} installed.${pathMessage}`);
    return true;
  }

  /** Validate a user-selected program before switching away from managed. */
  async chooseExisting() {
    const selected = await this.vscode.window.showOpenDialog({
      canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
      title: 'Choose the Cluster Watcher executable',
      openLabel: 'Use Executable',
    });
    if (!selected?.length) return false;
    const executable = selected[0].fsPath;
    await smokeTestExecutable(executable);
    await this.onWillChange();
    await this.setSelection({ source: 'external', externalExecutablePath: executable });
    this.applyTerminalEnvironment();
    this.vscode.window.showInformationMessage(`Using Cluster Watcher at ${executable}.`);
    return true;
  }

  /** Present every reversible backend and PATH transition in one permanent command. */
  async manage() {
    this.ownership = await readInstallManifest(this.layout).catch(() => undefined);
    const selectedManaged = this.selection()?.source === 'managed';
    const items = [];
    if (this.ownership && !selectedManaged) items.push({ label: '$(check) Use Managed Backend', action: 'use-managed' });
    items.push(
      { label: '$(cloud-download) Install or Repair Managed Backend', action: 'install-only' },
      { label: '$(terminal) Install or Repair and Add to PATH', action: 'install-path' },
      { label: '$(file-binary) Choose Existing Executable', action: 'choose' },
    );
    if (this.ownership?.system_path?.kind === 'none') items.push({ label: '$(add) Add Managed Backend to PATH', action: 'add-path' });
    if (['posix-profile', 'windows-user'].includes(this.ownership?.system_path?.kind)) {
      items.push({ label: '$(remove) Remove Managed Backend from PATH', action: 'remove-path' });
    }
    if (this.ownership) items.push({ label: '$(trash) Uninstall Managed Backend', action: 'uninstall' });
    const choice = await this.vscode.window.showQuickPick(items, {
      title: 'Manage Cluster Watcher Backend',
      placeHolder: selectedManaged ? `Managed ${this.ownership?.version || 'backend'} selected` : 'External executable selected',
    });
    if (!choice) return;
    if (choice.action === 'install-only') await this.install(false);
    else if (choice.action === 'install-path') await this.install(true);
    else if (choice.action === 'choose') await this.chooseExisting();
    else if (choice.action === 'use-managed') {
      await smokeTestExecutable(this.layout.executable);
      await this.onWillChange();
      await this.setSelection({ source: 'managed' });
      this.applyTerminalEnvironment();
    } else if (choice.action === 'add-path') {
      this.ownership = await addManagedPath(this.layout);
      this.vscode.window.showInformationMessage('The managed backend was added to your user PATH. Open a new terminal to use it.');
    } else if (choice.action === 'remove-path') {
      this.ownership = await removeManagedPath(this.layout);
      this.vscode.window.showInformationMessage('The extension-owned PATH entry was removed.');
    } else if (choice.action === 'uninstall') {
      const confirmation = await this.vscode.window.showWarningMessage(
        'Uninstall the extension-managed backend? Cluster configuration is preserved.',
        { modal: true }, 'Uninstall Backend',
      );
      if (confirmation !== 'Uninstall Backend') return;
      await this.onWillChange();
      await uninstallBackend(this.layout);
      this.ownership = undefined;
      if (selectedManaged) await this.setSelection(undefined);
      this.applyTerminalEnvironment();
      this.vscode.window.showInformationMessage('The extension-managed backend was removed. Cluster configuration was preserved.');
    }
  }
}

module.exports = {
  BACKEND_STATE_KEY,
  BackendManager,
  MAX_DOWNLOAD_BYTES,
  addManagedPath,
  assertHostSupported,
  compareVersions,
  downloadVerified,
  installBackend,
  installLayout,
  hostCompatibilityVersion,
  loadReleaseManifest,
  managedPathBlock,
  normalizedTarget,
  pathContains,
  preferredProfile,
  readInstallManifest,
  releaseTarget,
  removeManagedPath,
  shellSingleQuote,
  smokeTestExecutable,
  uninstallBackend,
};
