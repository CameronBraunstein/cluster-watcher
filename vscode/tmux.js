'use strict';

const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');

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
    throw new Error(`The tmux session ${name} already exists, but its service is not responding. Inspect it with: tmux attach -t ${name}`);
  }
  try {
    await run(['new-session', '-d', '-s', name, '--', command]);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('tmux is required to start a persistent Cluster Watcher service. Install tmux on the VS Code extension host.');
    throw new Error(`Could not start tmux session ${name}: ${String(error.stderr || error.message).trim()}`);
  }
}

module.exports = { hasServiceSession, runTmux, serviceSessionName, startServiceSession };
