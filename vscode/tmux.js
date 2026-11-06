'use strict';

const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');

/** A named service session exists but the expected HTTP endpoint is unreachable. */
class StaleServiceSessionError extends Error {
  constructor(name) {
    super(`The tmux session ${name} already exists, but its service is not responding. Inspect it with: tmux attach -t ${name}`);
    this.name = 'StaleServiceSessionError';
    this.sessionName = name;
  }
}

/** Name one tmux session per local backend endpoint, independent of VS Code. */
function serviceSessionName(backendUrl) {
  const endpoint = new URL(backendUrl).origin;
  return `cluster-watcher-${createHash('sha256').update(endpoint).digest('hex').slice(0, 12)}`;
}

/** Execute tmux without a shell or unbounded wait. No credentials enter argv. */
function runTmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else resolve(stdout);
    });
  });
}

/** Check for this exact session, distinguishing a missing tmux program. */
async function hasServiceSession(name, run = runTmux) {
  try {
    await run(['has-session', '-t', `=${name}`]);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('tmux is required to start a persistent Cluster Watcher service. Install tmux on the VS Code extension host.');
    if (error.code === 1) return false;
    throw error;
  }
}

/** Start the dashboard in tmux; never replace an existing session. */
async function startServiceSession(name, command, run = runTmux) {
  if (await hasServiceSession(name, run)) {
    throw new StaleServiceSessionError(name);
  }
  try {
    await run(['new-session', '-d', '-s', name, '--', command]);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('tmux is required to start a persistent Cluster Watcher service. Install tmux on the VS Code extension host.');
    throw new Error(`Could not start tmux session ${name}: ${String(error.stderr || error.message).trim()}`);
  }
}

/** Remove only the named stale session after the user approves a restart. */
async function stopServiceSession(name, run = runTmux) {
  if (!await hasServiceSession(name, run)) return false;
  try {
    await run(['kill-session', '-t', `=${name}`]);
  } catch (error) {
    if (error.code === 1) return false; // The session vanished after our check.
    throw error;
  }
  return true;
}

/** Recover a stale session only after confirmation and a second HTTP probe. */
async function startOrRecoverServiceSession(name, command, probe, confirm, run = runTmux) {
  try {
    await startServiceSession(name, command, run);
    return { outcome: 'started' };
  } catch (error) {
    if (!(error instanceof StaleServiceSessionError)) throw error;
    if (!await confirm(error)) return { outcome: 'cancelled', error };
    if (await probe()) return { outcome: 'attached' };
    await stopServiceSession(name, run);
    await startServiceSession(name, command, run);
    return { outcome: 'started' };
  }
}

module.exports = {
  StaleServiceSessionError, hasServiceSession, runTmux, serviceSessionName,
  startOrRecoverServiceSession, startServiceSession, stopServiceSession,
};
