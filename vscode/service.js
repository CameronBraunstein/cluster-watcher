'use strict';

const { execFile, spawn } = require('node:child_process');

/** Identify an executable-setting failure so the UI can offer focused help. */
class ExecutableValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExecutableValidationError';
  }
}

/** An HTTP error response from the Cluster Watcher service, keeping its status code. */
class ServiceResponseError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ServiceResponseError';
    this.status = status;
  }
}

/**
 * Turn a failed service response into an actionable error. A plain-text 404
 * comes from a service too old to know the route, so suggest upgrading.
 */
function responseError(status, payload) {
  if (payload && typeof payload.error === 'string') return new ServiceResponseError(payload.error, status);
  if (status === 404) {
    return new ServiceResponseError(
      'The running Cluster Watcher service does not support this request; it is probably an older version. '
      + 'Upgrade cluster-watcher with the installer for this platform and restart the service.',
      status,
    );
  }
  return new ServiceResponseError(`Cluster Watcher returned HTTP ${status}`, status);
}

/** Whether an error means the service is running but was started without --jobs-api. */
function jobsApiDisabled(error) {
  return error instanceof ServiceResponseError && error.status === 404 && /--jobs-api/.test(error.message);
}

/** Build actionable guidance for an invalid executable setting. */
function executableError(executable, detail) {
  return new ExecutableValidationError(
    `Cannot run Cluster Watcher executable "${executable}": ${detail}. `
    + 'Set "clusterWatcher.executable" in VS Code Settings (settings.json) to '
    + '"cluster-watcher" when it is on PATH, or to its absolute executable path. '
    + 'The setting is declared by package.json; do not edit the installed extension package.json.',
  );
}

/** Verify that the configured program resolves and can execute its help command. */
function validateExecutable(executable, timeoutMilliseconds = 5000) {
  if (typeof executable !== 'string' || !executable.trim()) {
    return Promise.reject(executableError(String(executable || ''), 'the value is empty'));
  }
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
    try {
      child = spawn(executable, ['--help'], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      finish(executableError(executable, error.message || String(error)));
      return;
    }
    timer = setTimeout(() => {
      child.kill();
      finish(executableError(executable, `validation did not finish within ${timeoutMilliseconds} ms`));
    }, timeoutMilliseconds);
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 2000) stderr += String(chunk).slice(0, 2000 - stderr.length);
    });
    child.once('error', (error) => {
      const detail = error.code === 'ENOENT' ? 'the command or file was not found' : error.message || String(error);
      finish(executableError(executable, detail));
    });
    child.once('close', (code) => {
      if (code === 0) finish();
      else finish(executableError(executable, stderr.trim() || `the --help check exited with status ${code}`));
    });
  });
}

/**
 * Require the private stdin credential protocol before starting a process that
 * has no terminal. A legacy executable can pass ``--help`` validation but
 * cannot safely answer password or OTP prompts in the extension host.
 */
async function validateBackgroundCredentialSupport(settings, timeoutMilliseconds = 5000, runner = runCli) {
  let result;
  try {
    result = await runner(settings, ['capabilities'], timeoutMilliseconds);
  } catch (error) {
    if (error instanceof ExecutableValidationError) throw error;
    result = { code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
  let payload;
  try { payload = JSON.parse(result.stdout); } catch (_error) { payload = undefined; }
  if (result.code === 0 && payload?.schema_version === 1
      && Array.isArray(payload.capabilities)
      && payload.capabilities.includes('credential-stdin-json')) return;
  throw new ExecutableValidationError(
    `The configured Cluster Watcher executable "${settings.executable}" is too old for secure background SSH login. `
    + 'Update or reinstall the backend that matches this extension, then retry. In a source checkout, run '
    + '`./install.sh --from-source --add-to-path`; otherwise use “Cluster Watcher: Manage Backend Installation”.',
  );
}

/** Quote one argument for a POSIX shell or PowerShell command line. */
function shellQuote(value, platform = process.platform) {
  if (platform === 'win32') return `'${String(value).replaceAll("'", "''")}'`;
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Return executable arguments that select the configured clusters.toml, if any. */
function configArguments(settings) {
  return settings.configPath ? ['--config', settings.configPath] : [];
}

/** Build a direct child-process argument vector without involving a shell. */
function cliArguments(settings, args) {
  return [...configArguments(settings), ...args];
}

/** Build a shell-quoted ``cluster-watcher`` command line for an integrated terminal. */
function cliCommand(settings, args, platform = process.platform) {
  return [settings.executable, ...configArguments(settings), ...args]
    .map((argument) => shellQuote(argument, platform)).join(' ');
}

/** Build a shell-independent integrated terminal running the CLI directly. */
function cliTerminalOptions(name, settings, args) {
  return {
    name,
    shellPath: settings.executable,
    shellArgs: [...configArguments(settings), ...args],
  };
}

/** Run the executable directly (no shell) and resolve with stdout/stderr and exit code. */
function runCli(settings, args, timeoutMilliseconds = 10000) {
  return new Promise((resolve, reject) => {
    execFile(settings.executable, [...configArguments(settings), ...args], { timeout: timeoutMilliseconds }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(executableError(settings.executable, error.code === 'ENOENT' ? 'the command or file was not found' : error.message));
        return;
      }
      resolve({ code: error ? error.code : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Ask the CLI which configuration file it uses (``config --path``). */
async function resolveConfigPath(settings) {
  const result = await runCli(settings, ['config', '--path']);
  const resolved = result.stdout.trim();
  if (result.code !== 0 || !resolved) throw new Error(result.stderr.trim() || 'cluster-watcher config --path did not report a path');
  return resolved;
}

/** Validate the configuration by listing machines; resolve to an error message or null. */
async function configurationError(settings) {
  const result = await runCli(settings, ['list']);
  if (result.code === 0) return null;
  return (result.stderr.trim().split('\n').pop() || `cluster-watcher list exited with status ${result.code}`).replace(/^.*?error: /, '');
}

/** Return safe CLI arguments for the configured loopback service. */
function serviceArguments(settings) {
  const backend = new URL(settings.backendUrl);
  const loopbackNames = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
  if (backend.protocol !== 'http:' || !loopbackNames.has(backend.hostname)) {
    throw new Error('Starting a service requires an http:// loopback backendUrl');
  }
  const port = backend.port ? Number(backend.port) : 80;
  return [
    'serve', '--host', backend.hostname, '--port', String(port),
    '--timeout', String(settings.sshTimeoutSeconds), '--refresh', String(settings.refreshSeconds),
    '--jobs-api', '--no-browser',
  ];
}

/** Add the private stdin credential protocol used by the background extension host. */
function backgroundServiceArguments(settings) {
  return [...serviceArguments(settings), '--credential-stdin-json'];
}

/** Build a background login argument vector for all or one configured machine. */
function backgroundLoginArguments(settings, machine, includeCredentialGroup = false) {
  return [
    'login', ...(machine ? [String(machine), ...(includeCredentialGroup ? [] : ['--only'])] : []),
    '--timeout', String(settings.sshTimeoutSeconds), '--credential-stdin-json',
  ];
}

/** Build the safe loopback service command launched by the extension. */
function serviceCommand(settings) {
  return cliCommand(settings, serviceArguments(settings));
}

module.exports = {
  ExecutableValidationError, ServiceResponseError, backgroundLoginArguments, backgroundServiceArguments,
  cliArguments, jobsApiDisabled, responseError, cliCommand, cliTerminalOptions, configurationError,
  resolveConfigPath, runCli, serviceArguments, serviceCommand, shellQuote,
  validateBackgroundCredentialSupport, validateExecutable,
};
