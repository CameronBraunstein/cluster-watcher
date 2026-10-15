'use strict';

const vscode = require('vscode');
const extensionManifest = require('./package.json');
const { JobArchive } = require('./archive');
const { BackgroundCliProcess } = require('./background');
const { BackendManager } = require('./backend');
const { LOG_TAIL_LINES, logDocumentContent, logRequestPath, prependLogPage, virtualLogPath } = require('./logs');
const { jobTransitions, notificationMessage, shouldNotify, statusSummary } = require('./events');
const { scriptRequestPath, scriptSourceMessage, virtualScriptPath } = require('./scripts');
const { RefreshCoordinator, RefreshFeedback, refreshResultMessage } = require('./refresh');
const { isFailureGroup, jobRef, localTime, setDateFormat, renderJobs, renderJobsApiDisabled, renderLoading, renderServerStatus, renderStatus, renderWelcome, stateGroup } = require('./renderers');
const {
  ExecutableValidationError, backgroundLoginArguments, backgroundServiceArguments, cliArguments,
  jobsApiDisabled, responseError, cliTerminalOptions, configurationError, resolveConfigPath,
  runCli, serviceCommand, validateBackgroundCredentialSupport, validateExecutable,
} = require('./service');

const CONFIGURATION_SECTION = 'clusterWatcher';
let backendManager;

/** The only commands a webview button may ask the extension to run. */
const WEBVIEW_COMMANDS = new Set([
  'clusterWatcher.archiveJob', 'clusterWatcher.restoreJob', 'clusterWatcher.openLog', 'clusterWatcher.openScript',
  'clusterWatcher.cancelJob',
  'clusterWatcher.startService', 'clusterWatcher.runSetup', 'clusterWatcher.editConfig', 'clusterWatcher.openSettings',
  'clusterWatcher.stopService', 'clusterWatcher.openDashboard', 'clusterWatcher.copyServiceCommand',
  'clusterWatcher.refresh', 'clusterWatcher.refreshServer', 'clusterWatcher.login', 'clusterWatcher.manageBackend',
]);

/** Return the current extension configuration. */
function configuration() {
  const config = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  const configuredExecutable = config.get('executable', 'cluster-watcher');
  return {
    executable: backendManager?.executable(configuredExecutable) || configuredExecutable,
    configPath: config.get('configPath', ''),
    backendUrl: config.get('backendUrl', 'http://127.0.0.1:8080/'),
    refreshSeconds: config.get('refreshSeconds', 15),
    sshTimeoutSeconds: config.get('sshTimeoutSeconds', 15),
    autoStart: config.get('autoStart', false),
    notifications: config.get('notifications', 'all'),
    statusBar: config.get('statusBar', true),
    dateFormat: config.get('dateFormat', 'DD.MM.YYYY'),
  };
}

/** Fetch JSON from the configured loopback service with a bounded wait. */
class BackendClient {
  async get(path, timeoutMilliseconds = 12000) {
    return this.request(path, { headers: { Accept: 'application/json' } }, timeoutMilliseconds);
  }

  /**
   * Conditional GET: sends ``If-None-Match`` when an ETag is known and
   * resolves ``{ notModified: true }`` on HTTP 304, otherwise
   * ``{ payload, etag }``. Unchanged data then costs no transfer or render.
   */
  async poll(path, etag, timeoutMilliseconds = 12000) {
    const headers = { Accept: 'application/json' };
    if (etag) headers['If-None-Match'] = etag;
    return this.request(path, { headers }, timeoutMilliseconds, true);
  }

  /** POST a JSON body; the JSON content type is what the service requires for writes. */
  async post(path, body = {}, timeoutMilliseconds = 30000) {
    return this.request(path, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, timeoutMilliseconds);
  }

  async request(path, init, timeoutMilliseconds, conditional = false) {
    const base = new URL(configuration().backendUrl);
    const url = new URL(path.replace(/^\//, ''), base.href.endsWith('/') ? base : `${base.href}/`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (conditional && response.status === 304) return { notModified: true };
      let payload;
      try {
        payload = await response.json();
      } catch (_error) {
        throw responseError(response.status, null);
      }
      if (!response.ok) throw responseError(response.status, payload);
      return conditional ? { payload, etag: response.headers.get('etag') || undefined } : payload;
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('Cluster Watcher service request timed out');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async isClusterWatcherService() {
    try {
      const payload = await this.get('/api/v1/snapshot', 2500);
      return Boolean(payload && payload.schema_version);
    } catch (error) {
      // A 503 during the initial collection is still our service. Probe the
      // unversioned status route and accept its characteristic JSON response.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      try {
        const base = new URL(configuration().backendUrl);
        const response = await fetch(
          new URL('api/status', base.href.endsWith('/') ? base : `${base.href}/`),
          { signal: controller.signal, headers: { Accept: 'application/json' } },
        );
        const payload = await response.json();
        return Boolean(payload && ('updated_at' in payload || 'refresh_seconds' in payload));
      } catch (_probeError) {
        return false;
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  /** Return process identity, falling back gracefully for an older backend. */
  async serviceInfo() {
    try {
      return await this.get('/api/v1/service', 2500);
    } catch (error) {
      if (await this.isClusterWatcherService()) return {};
      throw error;
    }
  }
}

/** Own a background service while allowing attachment to a separately run service. */
class ServiceController {
  constructor(client, refresh, manager, provider, onReachable = () => {}, onAvailabilityChange = () => {}) {
    this.client = client;
    this.refresh = refresh;
    this.manager = manager;
    this.provider = provider;
    this.onReachable = onReachable;
    this.onAvailabilityChange = onAvailabilityChange;
    this.process = undefined;
    this.loginProcess = undefined;
    this.stopping = false;
    this.authenticationCancelled = false;
    this.lifecycle = {
      state: 'offline', owned: false, url: configuration().backendUrl,
      pid: undefined, startedAt: undefined, activity: undefined, error: undefined, recentLines: [],
    };
    this.sessions = undefined;
    this.sessionsError = undefined;
  }

  /** Publish lifecycle changes immediately to the Server Status view. */
  publish(changes = {}) {
    const wasReachable = ['running', 'attached'].includes(this.lifecycle.state);
    this.lifecycle = { ...this.lifecycle, ...changes, url: configuration().backendUrl };
    // Stopping still has a reachable service until the shutdown finishes.
    this.onAvailabilityChange(['running', 'attached', 'stopping'].includes(this.lifecycle.state));
    if (!wasReachable && ['running', 'attached'].includes(this.lifecycle.state)) this.onReachable();
    this.provider.updateServer(this.lifecycle, this.sessions, this.sessionsError);
  }

  /** Ask VS Code for one secret; cancellation is returned to the child explicitly. */
  async requestCredential(request, serviceStartup = false) {
    this.publish({
      ...(serviceStartup ? { state: 'authenticating' } : {}),
      activity: request.prompt,
    });
    const value = await vscode.window.showInputBox({
      title: request.kind === 'otp' ? 'Cluster Watcher one-time code' : 'Cluster Watcher password',
      prompt: request.prompt,
      password: true,
      ignoreFocusOut: true,
      placeHolder: request.kind === 'otp' ? 'Enter the current one-time code' : 'Enter the SSH password',
      validateInput: (candidate) => candidate ? undefined : 'A value is required',
    });
    if (serviceStartup && value === undefined) this.authenticationCancelled = true;
    this.publish({
      ...(serviceStartup && value !== undefined ? { state: 'starting' } : {}),
      activity: value === undefined ? 'Authentication cancelled' : 'Continuing authentication…',
    });
    return value;
  }

  /** Update the bounded diagnostic tail shown in Server Status. */
  processOutput(_line, recentLines) {
    this.publish({ recentLines });
  }

  async start() {
    if (await this.client.isClusterWatcherService()) {
      // A service started by hand may lack the jobs API that My Jobs needs.
      const missingJobsApi = await this.client.get('/api/v1/jobs').then(() => false, jobsApiDisabled);
      if (missingJobsApi) {
        const choice = await vscode.window.showWarningMessage(
          `A Cluster Watcher service is already running at ${configuration().backendUrl}, but without --jobs-api, so My Jobs cannot work. `
          + 'Stop it (Ctrl-C in its terminal), then start the service again from here or with the copied command.',
          'Copy Restart Command',
        );
        if (choice) await vscode.commands.executeCommand('clusterWatcher.copyServiceCommand');
      } else {
        vscode.window.showInformationMessage('Cluster Watcher attached to the existing local service.');
      }
      this.publish({ state: 'attached', owned: false, pid: undefined, startedAt: undefined, activity: undefined, error: undefined });
      await this.refresh();
      return;
    }
    if (this.process) {
      vscode.window.showInformationMessage('Cluster Watcher is already starting in the background.');
      return;
    }
    const configured = vscode.workspace.getConfiguration(CONFIGURATION_SECTION).get('executable', 'cluster-watcher');
    await this.manager.ensureAvailable(configured);
    const settings = configuration();
    await validateExecutable(settings.executable);
    await validateBackgroundCredentialSupport(settings);
    this.stopping = false;
    this.authenticationCancelled = false;
    this.publish({
      state: 'starting', owned: true, pid: undefined, startedAt: new Date().toISOString(),
      activity: 'Starting the service and checking reusable SSH sessions…', error: undefined, recentLines: [],
    });
    const owned = new BackgroundCliProcess(
      settings.executable,
      cliArguments(settings, backgroundServiceArguments(settings)),
      {
        onStart: (pid) => this.publish({ pid }),
        onCredential: (request) => this.requestCredential(request, true),
        onOutput: (line, recentLines) => this.processOutput(line, recentLines),
        onProtocolError: (error) => this.publish({ state: 'error', error: error.message }),
        onExit: (result) => this.serviceExited(owned, result),
      },
    );
    this.process = owned;
    owned.start();
    void this.waitUntilReady(owned);
  }

  /** Poll cheaply while authentication is in progress, then refresh all views. */
  async waitUntilReady(owned) {
    while (this.process === owned && !owned.settled) {
      if (await this.client.isClusterWatcherService()) {
        this.publish({ state: 'running', owned: true, activity: undefined, error: undefined });
        await this.refresh();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /** Record an owned service's exit without treating an intentional stop as failure. */
  serviceExited(owned, result) {
    if (this.process !== owned) return;
    this.process = undefined;
    const expected = this.stopping || (result.code === 130 && this.authenticationCancelled);
    this.stopping = false;
    this.authenticationCancelled = false;
    const diagnostic = result.error?.message
      || this.lifecycle.error
      || [...result.recentLines].reverse().find((line) => line.stream === 'stderr')?.text
      || (result.code != null ? `Process exited with status ${result.code}` : `Process ended with ${result.signal || 'an unknown signal'}`);
    this.publish(expected
      ? { state: 'offline', owned: false, pid: undefined, startedAt: undefined, activity: undefined, error: undefined }
      : { state: 'error', owned: false, pid: undefined, startedAt: undefined, activity: undefined, error: diagnostic });
    void this.refresh();
  }

  async stop() {
    if (!this.process) {
      if (this.lifecycle.state !== 'attached') {
        vscode.window.showInformationMessage('The Cluster Watcher service is not running.');
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        'Stop the existing Cluster Watcher service? Other dashboards and clients using it will be disconnected.',
        { modal: true },
        'Stop service',
      );
      if (choice !== 'Stop service') return;
      this.publish({ state: 'stopping', activity: 'Stopping the existing service…', error: undefined });
      try {
        await this.client.post('/api/v1/shutdown', {}, 5000);
      } catch (error) {
        this.publish({ state: 'attached', activity: undefined, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      this.publish({ state: 'offline', owned: false, pid: undefined, startedAt: undefined, activity: undefined, error: undefined });
      vscode.window.showInformationMessage('Cluster Watcher service stopped.');
      await this.refresh();
      return;
    }
    this.stopping = true;
    this.publish({ state: 'stopping', activity: 'Stopping the background service…' });
    this.process.stop();
  }

  /** Stop only a service owned by the extension before replacing its executable. */
  async stopForBackendChange() {
    if (!this.process) return;
    const completion = this.process.completion;
    await this.stop();
    await Promise.race([completion, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }

  /** Re-open one or all closed sessions through the same background secret protocol. */
  async login(machine, includeCredentialGroup = false) {
    if (this.loginProcess) {
      vscode.window.showInformationMessage('A Cluster Watcher login is already in progress.');
      return;
    }
    if (this.process && ['starting', 'authenticating'].includes(this.lifecycle.state)) {
      vscode.window.showInformationMessage('The background service is already authenticating SSH sessions.');
      return;
    }
    const configured = vscode.workspace.getConfiguration(CONFIGURATION_SECTION).get('executable', 'cluster-watcher');
    await this.manager.ensureAvailable(configured);
    const settings = configuration();
    await validateExecutable(settings.executable);
    await validateBackgroundCredentialSupport(settings);
    this.publish({
      activity: machine
        ? `Logging in to ${machine}${includeCredentialGroup ? ' and its credential group' : ''}…`
        : 'Logging in to closed SSH sessions…',
      error: undefined,
    });
    const login = new BackgroundCliProcess(
      settings.executable,
      cliArguments(settings, backgroundLoginArguments(
        settings, typeof machine === 'string' ? machine : undefined, Boolean(includeCredentialGroup),
      )),
      {
        onCredential: (request) => this.requestCredential(request, false),
        onOutput: (line, recentLines) => this.processOutput(line, recentLines),
        onProtocolError: (error) => this.publish({ error: error.message }),
      },
    );
    this.loginProcess = login;
    login.start();
    const result = await login.completion;
    if (this.loginProcess === login) this.loginProcess = undefined;
    const diagnostic = result.error?.message
      || [...result.recentLines].reverse().find((line) => line.stream === 'stderr')?.text;
    this.publish({ activity: undefined, ...(result.code && result.code !== 130 ? { error: diagnostic || `Login exited with status ${result.code}` } : {}) });
    if (result.code === 0) vscode.window.showInformationMessage('Cluster Watcher SSH sessions are open.');
    else if (result.code === 130) vscode.window.showInformationMessage('Cluster Watcher login was cancelled.');
    else vscode.window.showErrorMessage(`Cluster Watcher login failed: ${diagnostic || `exit status ${result.code}`}`);
    await this.refresh();
  }

  /** Inspect service reachability and SSH masters without opening new sessions. */
  async refreshStatus() {
    const checkedAt = Date.now();
    const settings = configuration();
    const [serviceResult, inventoryResult] = await Promise.allSettled([
      this.client.serviceInfo(),
      runCli(settings, ['sessions', '--json', '--timeout', '2'], 60000),
    ]);
    const reachable = serviceResult.status === 'fulfilled';
    this.onAvailabilityChange(reachable);
    const serviceInfo = reachable && serviceResult.value && typeof serviceResult.value === 'object'
      ? serviceResult.value : {};
    if (inventoryResult.status === 'rejected') {
      this.sessionsError = inventoryResult.reason?.message || String(inventoryResult.reason);
      this.provider.updateServer(this.lifecycle, this.sessions, this.sessionsError, checkedAt);
    } else {
      const inventory = inventoryResult.value;
      if (inventory.code === 0) {
        try {
          this.sessions = JSON.parse(inventory.stdout);
          this.sessionsError = undefined;
        } catch (_error) {
          this.sessionsError = 'cluster-watcher sessions returned invalid JSON';
        }
      } else {
        this.sessionsError = inventory.stderr.trim() || `cluster-watcher sessions exited with status ${inventory.code}`;
      }
    }
    if (reachable) {
      this.publish({
        state: this.process ? 'running' : 'attached', owned: Boolean(this.process),
        pid: serviceInfo.pid ?? (this.process ? this.lifecycle.pid : undefined),
        startedAt: serviceInfo.started_at ?? (this.process ? this.lifecycle.startedAt : undefined),
        activity: this.loginProcess ? this.lifecycle.activity : undefined, error: undefined,
      });
    } else if (!this.process && this.lifecycle.state !== 'error') {
      this.publish({ state: 'offline', owned: false, pid: undefined, startedAt: undefined, activity: undefined });
    } else {
      this.provider.updateServer(this.lifecycle, this.sessions, this.sessionsError, checkedAt);
    }
    return { outcome: 'updated', checkedAt };
  }

  dispose() {
    this.loginProcess?.stop();
    this.process?.stop();
  }
}

/** Report startup failures and link executable errors directly to Settings. */
async function reportStartError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof ExecutableValidationError)) {
    vscode.window.showErrorMessage(message);
    return;
  }
  const action = await vscode.window.showErrorMessage(message, 'Manage Backend');
  if (action === 'Manage Backend') {
    await vscode.commands.executeCommand('clusterWatcher.manageBackend');
  }
}

/** Present one generated sidebar document and retain it across visibility changes. */
class SidebarProvider {
  constructor(kind) {
    this.kind = kind;
    this.view = undefined;
    /** Remembered open/closed state of collapsible sections, keyed by disclosure key. */
    this.disclosures = {};
    /** The last data received from the service, and whether the view currently shows it. */
    this.payload = undefined;
    this.hasSuccessfulData = false;
    this.loadingState = false;
    this.errorState = undefined;
    this.showingData = false;
    this.updatedAt = undefined;
    this.checkedAt = undefined;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.onDidDispose(() => { if (this.view === view) this.view = undefined; });
    // Freshness is rendered below the native heading, not beside its title.
    this.view.description = undefined;
    // Command URIs stay disabled: buttons post a message and receive() enforces WEBVIEW_COMMANDS.
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message) => this.receive(message));
    if (this.loadingState || (!this.hasSuccessfulData && !this.errorState)) {
      view.webview.html = renderLoading(this.title(), this.freshness(), !this.loadingState);
    } else if (this.errorState?.kind === 'offline') {
      view.webview.html = renderWelcome(this.title(), this.errorState.detail, this.freshness());
    } else if (this.errorState?.kind === 'jobs-api-off') {
      view.webview.html = renderJobsApiDisabled(this.title(), restartCommandText(), this.freshness());
    } else this.render();
  }

  /**
   * A refresh found the service's data unchanged (HTTP 304): keep the page,
   * which advances its own times, and tell it when the check happened.
   */
  checked(at) {
    this.checkedAt = at;
    this.loadingState = false;
    this.errorState = undefined;
    if (!this.view) return;
    if (!this.showingData && this.payload) this.render();
    else void this.view.webview.postMessage({ type: 'checked', at });
  }

  /**
   * Handle webview messages: run allow-listed button commands, remember
   * disclosure toggles so the next refresh renders them unchanged, copy job
   * IDs, and explain unresolvable dependency links.
   */
  receive(message) {
    if (message?.type === 'command') {
      if (WEBVIEW_COMMANDS.has(message.command)) {
        void vscode.commands.executeCommand(message.command, ...(Array.isArray(message.args) ? message.args : []));
      }
    } else if (message?.type === 'disclosure' && typeof message.key === 'string') {
      this.disclosures[message.key] = Boolean(message.open);
    } else if (message?.type === 'copy' && typeof message.text === 'string') {
      void vscode.env.clipboard.writeText(message.text).then(
        () => vscode.window.setStatusBarMessage(`Copied job ID ${message.text}`, 2500),
      );
    } else if (message?.type === 'missingJob' && typeof message.ref === 'string') {
      vscode.window.showInformationMessage(`Job ${message.ref} could not be found in My Jobs; it may be older than 24 hours or belong to another user.`);
    }
  }

  title() {
    return this.kind === 'jobs' ? 'My Jobs' : 'Cluster Status';
  }

  /** Return timestamps rendered immediately below this view's native heading. */
  freshness() {
    return { updatedAt: this.updatedAt };
  }

  /** Record when the current payload changed and when the request completed. */
  recordRefresh(payload, checkedAt) {
    this.payload = payload;
    this.hasSuccessfulData = true;
    this.loadingState = false;
    this.errorState = undefined;
    this.updatedAt = payload.generated_at || payload.updated_at;
    this.checkedAt = checkedAt;
  }

  update(payload, checkedAt = Date.now()) {
    this.recordRefresh(payload, checkedAt);
    this.render();
  }

  /** Show first-load progress while the service is reachable but has no data. */
  loading() {
    if (this.loadingState || (this.showingData && this.hasSuccessfulData)) return;
    this.loadingState = true;
    this.errorState = undefined;
    this.showingData = false;
    if (this.view) this.view.webview.html = renderLoading(this.title(), this.freshness());
  }

  render() {
    if (!this.view || !this.payload) return;
    this.showingData = true;
    this.view.webview.html = renderStatus(this.payload, this.disclosures, this.freshness());
  }

  error(error) {
    this.loadingState = false;
    this.showingData = false;
    const detail = error instanceof Error ? error.message : String(error);
    this.errorState = { kind: 'offline', detail };
    if (!this.view) return;
    this.view.webview.html = renderWelcome(this.title(), detail, this.freshness());
  }

  /** Explain that the service runs without the jobs API and how to restart it. */
  jobsApiDisabled() {
    this.loadingState = false;
    this.showingData = false;
    this.errorState = { kind: 'jobs-api-off' };
    if (!this.view) return;
    this.view.webview.html = renderJobsApiDisabled(this.title(), restartCommandText(), this.freshness());
  }
}

/** Keep native My Jobs and Cluster Status headings compact while offline. */
class OfflineSidebarProvider extends SidebarProvider {
  constructor(kind) {
    super(kind);
    this.errorState = { kind: 'offline', detail: '' };
  }
}

/** Render service ownership and reusable SSH masters in its own sidebar view. */
class ServerSidebarProvider extends SidebarProvider {
  constructor() {
    super('server');
    this.service = { state: 'offline', owned: false, recentLines: [] };
    this.sessions = undefined;
    this.sessionsError = undefined;
  }

  title() {
    return 'Server Status';
  }

  resolveWebviewView(view) {
    this.view = view;
    view.onDidDispose(() => { if (this.view === view) this.view = undefined; });
    this.view.description = undefined;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message) => this.receive(message));
    this.render();
  }

  updateServer(service, sessions, sessionsError, checkedAt = Date.now()) {
    this.service = { ...service };
    this.sessions = sessions;
    this.sessionsError = sessionsError;
    this.updatedAt = sessions?.generated_at || new Date(checkedAt).toISOString();
    this.checkedAt = checkedAt;
    this.render();
  }

  render() {
    if (!this.view) return;
    this.showingData = true;
    this.view.webview.html = renderServerStatus({
      service: this.service,
      sessions: this.sessions,
      sessionsError: this.sessionsError,
    }, this.freshness());
  }
}

/** Persist archived jobs and render active/archived cards independently. */
class JobsSidebarProvider extends SidebarProvider {
  constructor(storage) {
    super('jobs');
    this.archiveStore = new JobArchive(storage);
    this.payload = { jobs: [] };
    /** ``cluster/job_id`` refs whose End Job request succeeded but that Slurm still lists as active. */
    this.cancelling = new Set();
  }

  update(payload, checkedAt = Date.now()) {
    this.recordRefresh(payload, checkedAt);
    const stillActive = new Set((payload.jobs || [])
      .filter((job) => ['RUNNING', 'PENDING'].includes(stateGroup(job.state)))
      .map(jobRef));
    for (const ref of this.cancelling) if (!stillActive.has(ref)) this.cancelling.delete(ref);
    void this.archiveStore.merge(payload.jobs || []);
    this.render();
  }

  /** Mark a job as ending until a refresh shows it has left the queue. */
  markCancelling(cluster, jobId) {
    this.cancelling.add(`${cluster}/${jobId}`);
    this.render();
  }

  render() {
    if (!this.view) return;
    if (this.loadingState) {
      this.view.webview.html = renderLoading(this.title(), this.freshness());
      return;
    }
    this.showingData = true;
    this.view.webview.html = renderJobs({
      ...this.payload,
      jobs: this.archiveStore.activeJobs(this.payload.jobs || []),
      archived_jobs: this.archiveStore.archivedJobs(),
    }, this.disclosures, this.cancelling, this.freshness());
  }

  async archive(key) {
    const changed = await this.archiveStore.archiveJob(this.payload.jobs || [], key);
    if (!changed) return false;
    this.render();
    return true;
  }

  async restore(key) {
    const changed = await this.archiveStore.restoreJob(key);
    if (!changed) return false;
    this.render();
    return true;
  }
}

/** Expose bounded remote log tails as read-only VS Code text documents. */
class JobLogDocumentProvider {
  constructor(client) {
    this.client = client;
    this.documents = new Map();
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChange = this.changeEmitter.event;
  }

  provideTextDocumentContent(uri) {
    const record = this.documents.get(uri.toString());
    return record ? logDocumentContent(record) : '';
  }

  /** Fetch one bounded stream and reveal it in a fresh virtual editor. */
  async open(cluster, jobId, stream) {
    const payload = await this.client.get(logRequestPath(cluster, jobId, stream));
    const uri = vscode.Uri.from({
      scheme: 'cluster-watcher-log',
      path: virtualLogPath(cluster, jobId, stream),
      query: `updated=${Date.now()}`,
    });
    this.documents.set(uri.toString(), {
      ...payload,
      cluster,
      jobId,
      stream,
      loadedLines: Number(payload.lines) || 0,
      moreBefore: Boolean(payload.more_before ?? payload.truncated),
    });
    while (this.documents.size > 50) this.documents.delete(this.documents.keys().next().value);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    if (payload.more_before ?? payload.truncated) {
      vscode.window.showInformationMessage(`${payload.path || `${jobId}.${stream}`} has older output; use the editor's Load 2,000 Older Lines button to retrieve it.`);
    }
  }

  /** Prepend one older bounded page to an open virtual log document. */
  async loadMore(uri) {
    if (!uri || uri.scheme !== 'cluster-watcher-log') throw new Error('Open a Cluster Watcher log document first');
    const record = this.documents.get(uri.toString());
    if (!record) throw new Error('That Cluster Watcher log document is no longer available');
    if (!record.moreBefore) {
      vscode.window.showInformationMessage('The complete log is already loaded.');
      return;
    }
    const page = await this.client.get(logRequestPath(record.cluster, record.jobId, record.stream, record.loadedLines));
    const updated = prependLogPage(record, page);
    this.documents.set(uri.toString(), updated);
    this.changeEmitter.fire(uri);
    vscode.window.showInformationMessage(
      updated.moreBefore
        ? `Loaded ${updated.loadedLines} lines; older output is still available.`
        : `Loaded the complete log (${updated.loadedLines} lines).`,
    );
  }

  dispose() {
    this.changeEmitter.dispose();
  }
}

/** Show a running/pending summary in the status bar and notify when jobs finish. */
class JobMonitor {
  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.item.command = 'clusterWatcher.jobs.focus';
    /** Previous refresh's job states; null until the first successful refresh. */
    this.states = null;
    /** Jobs from the latest payload, retained so a 304 check can update the hover timestamp. */
    this.jobs = [];
    this.viewState = 'initial';
  }

  /** Process one jobs payload; ``cancelling`` suppresses jobs the user ended. */
  update(payload, cancelling, refreshedAt) {
    this.viewState = 'data';
    const jobs = payload.jobs || [];
    this.jobs = jobs;
    const { states, finished } = jobTransitions(this.states, jobs);
    this.states = states;
    const settings = configuration();
    for (const transition of finished) {
      if (shouldNotify(settings.notifications, transition, cancelling)) void this.notify(transition);
    }
    const summary = statusSummary(jobs, refreshedAt);
    this.item.text = summary.text;
    this.item.tooltip = summary.tooltip;
    this.item.backgroundColor = undefined;
    this.show(settings);
  }

  /** Update the hover timestamp after an unchanged conditional jobs response. */
  checked(refreshedAt) {
    this.viewState = 'data';
    const summary = statusSummary(this.jobs, refreshedAt);
    this.item.text = summary.text;
    this.item.tooltip = summary.tooltip;
    this.item.backgroundColor = undefined;
    this.show(configuration());
  }

  /** Distinguish a running service without --jobs-api from an unreachable one. */
  jobsApiDisabled() {
    this.viewState = 'disabled';
    this.item.text = '$(warning) Cluster Watcher: jobs API off';
    this.item.tooltip = 'The Cluster Watcher service is running without --jobs-api. Click to show My Jobs for the fix.';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.show(configuration());
  }

  /** Reflect an unreachable service without forgetting the known job states. */
  offline() {
    this.viewState = 'offline';
    this.item.text = '$(debug-disconnect) Cluster Watcher offline';
    this.item.tooltip = 'The Cluster Watcher service is not reachable. Click to show My Jobs.';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.show(configuration());
  }

  /** Replace an obsolete offline banner while the first jobs fetch is pending. */
  loading() {
    if (this.viewState === 'data' || this.viewState === 'loading') return;
    this.viewState = 'loading';
    this.item.text = '$(sync~spin) Cluster Watcher loading…';
    this.item.tooltip = 'The service is running; waiting for the first jobs update.';
    this.item.backgroundColor = undefined;
    this.show(configuration());
  }

  show(settings) {
    if (settings.statusBar) this.item.show();
    else this.item.hide();
  }

  async notify(transition) {
    const { job, group } = transition;
    const message = notificationMessage(transition);
    const show = isFailureGroup(group)
      ? vscode.window.showWarningMessage
      : vscode.window.showInformationMessage;
    const choice = await show(message, 'Open .out', 'Open .err');
    if (choice) {
      await vscode.commands.executeCommand('clusterWatcher.openLog', job.cluster, String(job.job_id || job.id), choice === 'Open .out' ? 'out' : 'err');
    }
  }

  dispose() {
    this.item.dispose();
  }
}

/** Expose job batch scripts as read-only, shell-highlighted VS Code documents. */
class JobScriptDocumentProvider {
  constructor(client) {
    this.client = client;
    this.documents = new Map();
  }

  provideTextDocumentContent(uri) {
    return this.documents.get(uri.toString()) ?? '';
  }

  /** Fetch one job's script, open it, and say whether it is the exact submitted copy. */
  async open(cluster, jobId) {
    const payload = await this.client.get(scriptRequestPath(cluster, jobId), 30000);
    const uri = vscode.Uri.from({
      scheme: 'cluster-watcher-script',
      path: virtualScriptPath(cluster, jobId),
      query: `updated=${Date.now()}`,
    });
    this.documents.set(uri.toString(), payload.content || '');
    while (this.documents.size > 50) this.documents.delete(this.documents.keys().next().value);
    const document = await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(uri), 'shellscript');
    await vscode.window.showTextDocument(document, { preview: false });
    const message = scriptSourceMessage(payload);
    if (payload.source === 'file') vscode.window.showWarningMessage(message);
    else vscode.window.setStatusBarMessage(message, 6000);
  }
}

/** Confirm with a modal dialog, then cancel one job through the loopback service. */
async function cancelJob(client, jobsProvider, coordinator, cluster, jobId, name) {
  const label = name && name !== jobId ? `"${name}" (${jobId})` : jobId;
  const choice = await vscode.window.showWarningMessage(
    `End job ${label} on ${cluster}?`,
    { modal: true, detail: 'This runs scancel for the job. It cannot be undone, and any unsaved progress in the job is lost.' },
    'End Job',
  );
  if (choice !== 'End Job') return;
  await client.post(`/api/v1/jobs/${encodeURIComponent(cluster)}/${encodeURIComponent(jobId)}/cancel`);
  jobsProvider.markCancelling(cluster, jobId);
  vscode.window.showInformationMessage(`Cancellation requested for job ${jobId} on ${cluster}.`);
  void coordinator.refreshJobs();
}

/** Return the shell command that starts a correctly configured service. */
function restartCommandText() {
  try {
    return serviceCommand(configuration());
  } catch (_error) {
    return 'cluster-watcher serve --jobs-api --no-browser';
  }
}

/** Copy the service start command so a hand-started service can be replaced. */
async function copyServiceCommand() {
  await vscode.env.clipboard.writeText(restartCommandText());
  vscode.window.showInformationMessage('Copied the Cluster Watcher service command. Stop the running service first, then run it in a terminal.');
}

/** Run ``cluster-watcher setup`` in a terminal, since the wizard is interactive. */
async function runSetup() {
  const configured = vscode.workspace.getConfiguration(CONFIGURATION_SECTION).get('executable', 'cluster-watcher');
  await backendManager.ensureAvailable(configured);
  const settings = configuration();
  await validateExecutable(settings.executable);
  const terminal = vscode.window.createTerminal(cliTerminalOptions('Cluster Watcher Setup', settings, ['setup']));
  terminal.show();
}

/** Open the CLI's configuration file in an editor tab, offering setup when it is missing. */
async function editConfig() {
  const configured = vscode.workspace.getConfiguration(CONFIGURATION_SECTION).get('executable', 'cluster-watcher');
  await backendManager.ensureAvailable(configured);
  const path = await resolveConfigPath(configuration());
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(path));
  } catch (_error) {
    const choice = await vscode.window.showInformationMessage(`No configuration exists at ${path}.`, 'Run Setup Wizard');
    if (choice) await runSetup();
    return;
  }
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path)), { preview: false });
}

/** Validate the configuration after it is saved from VS Code and report problems. */
async function validateSavedConfig(document) {
  if (document.uri.scheme !== 'file' || !document.fileName.endsWith('.toml')) return;
  const settings = configuration();
  let path;
  try { path = await resolveConfigPath(settings); } catch (_error) { return; }
  if (document.uri.fsPath !== vscode.Uri.file(path).fsPath) return;
  const problem = await configurationError(settings).catch((error) => error.message);
  if (problem) vscode.window.showErrorMessage(`Cluster Watcher configuration is invalid: ${problem}`);
  else vscode.window.setStatusBarMessage('Cluster Watcher configuration is valid; restart the service to apply it.', 4000);
}

/** Show an error from a command callback without an unhandled rejection. */
function reportError(error) {
  if (error instanceof ExecutableValidationError) return reportStartError(error);
  vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
}

/** Activate the Cluster Watcher sidebar and service commands. */
function activate(context) {
  setDateFormat(configuration().dateFormat);
  let serviceAvailable;
  const setServiceAvailable = (available) => {
    if (serviceAvailable === available) return;
    serviceAvailable = available;
    void vscode.commands.executeCommand('setContext', 'clusterWatcher.serviceAvailable', available);
  };
  setServiceAvailable(false);
  const client = new BackendClient();
  const jobsProvider = new JobsSidebarProvider(context.globalState);
  const statusProvider = new SidebarProvider('status');
  const offlineJobsProvider = new OfflineSidebarProvider('jobs');
  const offlineStatusProvider = new OfflineSidebarProvider('status');
  const serverProvider = new ServerSidebarProvider();
  const monitor = new JobMonitor();
  let controller;
  const coordinator = new RefreshCoordinator(client, jobsProvider, statusProvider, monitor, {
    jobsApiDisabled,
    refreshSeconds: () => configuration().refreshSeconds,
    onServiceAvailable: () => setServiceAvailable(true),
    refreshServer: () => controller
      ? controller.refreshStatus()
      : Promise.resolve({ outcome: 'unchanged', checkedAt: Date.now() }),
  });
  const refreshFeedback = new RefreshFeedback(
    (key, value) => vscode.commands.executeCommand('setContext', key, value),
  );
  const manualRefresh = (contextKey, refresh) => refreshFeedback.run(contextKey, async () => {
    const result = await refresh();
    const message = result?.outcome === 'error'
      ? undefined
      : refreshResultMessage(result, localTime(result.checkedAt, true));
    if (message) void vscode.window.showInformationMessage(message);
    return result;
  });
  const refreshJobsWithFeedback = () => manualRefresh(
    'clusterWatcher.refreshingJobs', () => coordinator.refreshJobs(),
  );
  const refreshStatusWithFeedback = () => manualRefresh(
    'clusterWatcher.refreshingStatus', () => coordinator.refreshStatus(),
  );
  const refreshServerWithFeedback = () => manualRefresh(
    'clusterWatcher.refreshingServer', () => coordinator.refreshServer(),
  );
  backendManager = new BackendManager(vscode, context, extensionManifest.version, {
    onWillChange: () => controller?.stopForBackendChange(),
  });
  controller = new ServiceController(
    client, () => coordinator.refresh(), backendManager, serverProvider,
    () => coordinator.serviceReachable(), setServiceAvailable,
  );
  const logProvider = new JobLogDocumentProvider(client);
  const scriptProvider = new JobScriptDocumentProvider(client);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('clusterWatcher.jobs', jobsProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider('clusterWatcher.status', statusProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider('clusterWatcher.jobsOffline', offlineJobsProvider),
    vscode.window.registerWebviewViewProvider('clusterWatcher.statusOffline', offlineStatusProvider),
    vscode.window.registerWebviewViewProvider('clusterWatcher.server', serverProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider('cluster-watcher-log', logProvider),
    vscode.workspace.registerTextDocumentContentProvider('cluster-watcher-script', scriptProvider),
    vscode.commands.registerCommand('clusterWatcher.startService', async () => {
      try { await controller.start(); } catch (error) { await reportStartError(error); }
    }),
    vscode.commands.registerCommand('clusterWatcher.stopService', () => controller.stop().catch(reportError)),
    vscode.commands.registerCommand('clusterWatcher.refresh', () => coordinator.refresh()),
    vscode.commands.registerCommand('clusterWatcher.refreshJobs', refreshJobsWithFeedback),
    vscode.commands.registerCommand('clusterWatcher.refreshJobsBusy', refreshJobsWithFeedback),
    vscode.commands.registerCommand('clusterWatcher.refreshStatus', refreshStatusWithFeedback),
    vscode.commands.registerCommand('clusterWatcher.refreshStatusBusy', refreshStatusWithFeedback),
    vscode.commands.registerCommand('clusterWatcher.refreshServer', refreshServerWithFeedback),
    vscode.commands.registerCommand('clusterWatcher.refreshServerBusy', refreshServerWithFeedback),
    vscode.commands.registerCommand('clusterWatcher.openDashboard', () => vscode.env.openExternal(vscode.Uri.parse(configuration().backendUrl))),
    vscode.commands.registerCommand('clusterWatcher.archiveJob', async (key) => {
      if (!await jobsProvider.archive(String(key))) vscode.window.showWarningMessage('That job is no longer available to archive.');
    }),
    vscode.commands.registerCommand('clusterWatcher.restoreJob', async (key) => {
      if (!await jobsProvider.restore(String(key))) vscode.window.showWarningMessage('That archived job could not be found.');
    }),
    vscode.commands.registerCommand('clusterWatcher.copyServiceCommand', () => copyServiceCommand()),
    vscode.commands.registerCommand('clusterWatcher.runSetup', () => runSetup().catch(reportError)),
    vscode.commands.registerCommand(
      'clusterWatcher.login',
      (machine, includeCredentialGroup) => controller.login(machine, includeCredentialGroup).catch(reportError),
    ),
    vscode.commands.registerCommand('clusterWatcher.editConfig', () => editConfig().catch(reportError)),
    vscode.commands.registerCommand('clusterWatcher.manageBackend', () => backendManager.manage().catch(reportError)),
    vscode.commands.registerCommand('clusterWatcher.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', CONFIGURATION_SECTION)),
    vscode.workspace.onDidSaveTextDocument((document) => void validateSavedConfig(document)),
    vscode.commands.registerCommand('clusterWatcher.cancelJob', async (cluster, jobId, name) => {
      try { await cancelJob(client, jobsProvider, coordinator, String(cluster), String(jobId), String(name || '')); }
      catch (error) { vscode.window.showErrorMessage(`Could not end job ${jobId}: ${error instanceof Error ? error.message : String(error)}`); }
    }),
    vscode.commands.registerCommand('clusterWatcher.openLog', async (cluster, jobId, stream) => {
      try { await logProvider.open(String(cluster), String(jobId), String(stream)); }
      catch (error) { vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
    }),
    vscode.commands.registerCommand('clusterWatcher.openScript', async (cluster, jobId) => {
      try { await scriptProvider.open(String(cluster), String(jobId)); }
      catch (error) { vscode.window.showErrorMessage(`Could not open the script for job ${jobId}: ${error instanceof Error ? error.message : String(error)}`); }
    }),
    vscode.commands.registerCommand('clusterWatcher.loadMoreLog', async (uri) => {
      try {
        const target = uri || vscode.window.activeTextEditor?.document.uri;
        await logProvider.loadMore(target);
      } catch (error) { vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${CONFIGURATION_SECTION}.dateFormat`)) {
        // Unchanged data is answered with 304, so redraw the pages here.
        setDateFormat(configuration().dateFormat);
        for (const provider of [jobsProvider, statusProvider, serverProvider]) if (provider.showingData) provider.render();
      }
      if (event.affectsConfiguration(CONFIGURATION_SECTION)) {
        coordinator.schedule();
        void coordinator.refresh();
      }
    }),
    controller,
    coordinator,
    monitor,
    logProvider,
  );
  coordinator.schedule();
  void coordinator.refresh();
  const initialization = backendManager.initialize();
  if (configuration().autoStart) {
    void initialization.then(() => controller.start()).catch(reportStartError);
  } else {
    void initialization.then(async () => {
      await controller.refreshStatus();
      if (await client.isClusterWatcherService()) return;
      const configured = vscode.workspace.getConfiguration(CONFIGURATION_SECTION).get('executable', 'cluster-watcher');
      await backendManager.offerFirstUse(configured);
    }).catch(reportError);
  }
}

/** VS Code disposes all registered resources through the extension context. */
function deactivate() {}

module.exports = { activate, deactivate };
