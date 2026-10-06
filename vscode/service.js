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
      + 'Upgrade cluster-watcher (re-run install.sh) and restart the service.',
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

/** Quote one argument for the POSIX shell used by the integrated terminal. */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Return executable arguments that select the configured clusters.toml, if any. */
function configArguments(settings) {
  return settings.configPath ? ['--config', settings.configPath] : [];
}

/** Build a shell-quoted ``cluster-watcher`` command line for an integrated terminal. */
function cliCommand(settings, args) {
  return [settings.executable, ...configArguments(settings), ...args].map(shellQuote).join(' ');
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

/** Build the safe loopback service command launched by the extension. */
function serviceCommand(settings) {
  const backend = new URL(settings.backendUrl);
  const loopbackNames = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
  if (backend.protocol !== 'http:' || !loopbackNames.has(backend.hostname)) {
    throw new Error('Starting a service requires an http:// loopback backendUrl');
  }
  const port = backend.port ? Number(backend.port) : 80;
  return cliCommand(settings, [
    'serve', '--host', backend.hostname, '--port', String(port),
    '--timeout', String(settings.sshTimeoutSeconds), '--refresh', String(settings.refreshSeconds),
    '--jobs-api', '--no-browser',
  ]);
}

module.exports = {
  ExecutableValidationError, ServiceResponseError, jobsApiDisabled, responseError, cliCommand, configurationError, resolveConfigPath, runCli, serviceCommand, shellQuote, validateExecutable,
};
