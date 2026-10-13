'use strict';

const { spawn } = require('node:child_process');

const CREDENTIAL_PROMPT_PREFIX = 'CLUSTER_WATCHER_AUTH_PROMPT ';
const MAX_RECENT_LINES = 40;

/** Parse one authenticated-backend prompt without mistaking diagnostics for protocol traffic. */
function parseCredentialPrompt(line) {
  if (!String(line).startsWith(CREDENTIAL_PROMPT_PREFIX)) return undefined;
  let request;
  try { request = JSON.parse(String(line).slice(CREDENTIAL_PROMPT_PREFIX.length)); }
  catch (_error) { throw new Error('Cluster Watcher emitted a malformed credential request'); }
  if (!request || request.version !== 1 || !Number.isSafeInteger(request.request_id)
      || !['password', 'otp'].includes(request.kind) || typeof request.prompt !== 'string') {
    throw new Error('Cluster Watcher emitted an unsupported credential request');
  }
  return request;
}

/** Split arbitrary child-process chunks into complete lines while retaining the tail. */
class LineDecoder {
  constructor(onLine) {
    this.onLine = onLine;
    this.pending = '';
  }

  push(chunk) {
    this.pending += String(chunk);
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop();
    for (const line of lines) this.onLine(line);
  }

  flush() {
    if (this.pending) this.onLine(this.pending);
    this.pending = '';
  }
}

/** Retain a small diagnostic tail without ever retaining credential responses. */
function appendRecentLine(lines, stream, line, maximum = MAX_RECENT_LINES) {
  if (!line || String(line).startsWith(CREDENTIAL_PROMPT_PREFIX)) return lines;
  lines.push({ stream, text: String(line) });
  if (lines.length > maximum) lines.splice(0, lines.length - maximum);
  return lines;
}

/**
 * Own one directly spawned CLI process and bridge its secret requests to a UI
 * callback. The response travels only through stdin, never argv or env.
 */
class BackgroundCliProcess {
  constructor(executable, args, callbacks = {}, spawnImpl = spawn) {
    this.executable = executable;
    this.args = args;
    this.callbacks = callbacks;
    this.spawnImpl = spawnImpl;
    this.child = undefined;
    this.recentLines = [];
    this.promptQueue = Promise.resolve();
    this.settled = false;
    this.completion = new Promise((resolve) => { this.resolveCompletion = resolve; });
  }

  /** Spawn without a shell or terminal, with private stdin and captured diagnostics. */
  start() {
    if (this.child) return this;
    try {
      this.child = this.spawnImpl(this.executable, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
      });
    } catch (error) {
      this.finish(null, null, error);
      return this;
    }
    const stdout = new LineDecoder((line) => this.handleLine('stdout', line));
    const stderr = new LineDecoder((line) => this.handleLine('stderr', line));
    this.child.stdin.on?.('error', (error) => {
      if (!this.settled) this.callbacks.onProtocolError?.(new Error(`Credential input pipe failed: ${error.message}`));
    });
    this.child.stdout.on('data', (chunk) => stdout.push(chunk));
    this.child.stderr.on('data', (chunk) => stderr.push(chunk));
    this.child.once('error', (error) => this.finish(null, null, error));
    this.child.once('close', (code, signal) => {
      stdout.flush();
      stderr.flush();
      this.finish(code, signal);
    });
    this.callbacks.onStart?.(this.child.pid);
    return this;
  }

  handleLine(stream, line) {
    let request;
    try { request = parseCredentialPrompt(line); }
    catch (error) {
      this.callbacks.onProtocolError?.(error);
      this.stop();
      return;
    }
    if (request) {
      this.promptQueue = this.promptQueue.then(() => this.answerPrompt(request));
      return;
    }
    appendRecentLine(this.recentLines, stream, line);
    this.callbacks.onOutput?.({ stream, text: line }, [...this.recentLines]);
  }

  async answerPrompt(request) {
    let value;
    try { value = await this.callbacks.onCredential?.(request); }
    catch (_error) { value = undefined; }
    if (!this.child?.stdin?.writable) return;
    const response = value === undefined
      ? { request_id: request.request_id, cancel: true }
      : { request_id: request.request_id, value: String(value) };
    try { this.child.stdin.write(`${JSON.stringify(response)}\n`); }
    catch (error) { this.callbacks.onProtocolError?.(new Error(`Credential input pipe failed: ${error.message}`)); }
  }

  /** Ask the child to stop; ownership never extends to an attached service. */
  stop() {
    if (this.child && this.child.exitCode == null && !this.child.killed) this.child.kill('SIGTERM');
  }

  finish(code, signal, error) {
    if (this.settled) return;
    this.settled = true;
    const result = { code, signal, error, recentLines: [...this.recentLines] };
    this.callbacks.onExit?.(result);
    this.resolveCompletion(result);
  }
}

module.exports = {
  BackgroundCliProcess, CREDENTIAL_PROMPT_PREFIX, LineDecoder, MAX_RECENT_LINES,
  appendRecentLine, parseCredentialPrompt,
};
