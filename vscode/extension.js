'use strict';

const vscode = require('vscode');
const { JobArchive } = require('./archive');
const { LOG_TAIL_LINES, logDocumentContent, logRequestPath, prependLogPage, virtualLogPath } = require('./logs');
const { jobTransitions, notificationMessage, shouldNotify, statusSummary } = require('./events');
const { scriptRequestPath, scriptSourceMessage, virtualScriptPath } = require('./scripts');
const { jobRef, setDateFormat, renderJobs, renderJobsApiDisabled, renderMessage, renderStatus, renderWelcome, stateGroup } = require('./renderers');
const {
  ExecutableValidationError, jobsApiDisabled, responseError, cliCommand, configurationError, resolveConfigPath, serviceCommand, validateExecutable,
} = require('./service');

const CONFIGURATION_SECTION = 'clusterWatcher';

/** The only commands a webview button may ask the extension to run. */
const WEBVIEW_COMMANDS = new Set([
  'clusterWatcher.archiveJob', 'clusterWatcher.restoreJob', 'clusterWatcher.openLog', 'clusterWatcher.openScript',
  'clusterWatcher.cancelJob',
  'clusterWatcher.startService', 'clusterWatcher.runSetup', 'clusterWatcher.editConfig', 'clusterWatcher.openSettings',
  'clusterWatcher.copyServiceCommand', 'clusterWatcher.refresh',
]);

/** Return the current extension configuration. */
function configuration() {
  const config = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  return {
    executable: config.get('executable', 'cluster-watcher'),
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
}

/** Own a service terminal while allowing attachment to a separately run service. */
class ServiceController {
  constructor(client, refresh) {
    this.client = client;
    this.refresh = refresh;
    this.terminal = undefined;
    this.closeSubscription = vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === this.terminal) {
        this.terminal = undefined;
        void this.refresh();
      }
    });
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
      await this.refresh();
      return;
    }
    if (this.terminal) {
      this.terminal.show();
      return;
    }
    const settings = configuration();
    await validateExecutable(settings.executable);
    this.terminal = vscode.window.createTerminal({ name: 'Cluster Watcher Service' });
    this.terminal.show();
    this.terminal.sendText(serviceCommand(settings), true);
    vscode.window.showInformationMessage('Cluster Watcher is starting; complete any password and OTP prompts in its terminal.');
    setTimeout(() => void this.refresh(), 1000);
  }

  stop() {
    if (!this.terminal) {
      vscode.window.showInformationMessage('The extension did not start the current service, so it was left running.');
      return;
    }
    this.terminal.dispose();
    this.terminal = undefined;
  }

  showTerminal() {
    if (this.terminal) this.terminal.show();
    else vscode.window.showInformationMessage('No Cluster Watcher service terminal is owned by this extension.');
  }

  dispose() {
    this.closeSubscription.dispose();
  }
}

/** Report startup failures and link executable errors directly to Settings. */
async function reportStartError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof ExecutableValidationError)) {
    vscode.window.showErrorMessage(message);
    return;
  }
  const action = await vscode.window.showErrorMessage(message, 'Open Executable Setting');
  if (action === 'Open Executable Setting') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'clusterWatcher.executable');
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
    this.showingData = false;
  }

  resolveWebviewView(view) {
    this.view = view;
    // Command URIs stay disabled: buttons post a message and receive() enforces WEBVIEW_COMMANDS.
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message) => this.receive(message));
    if (this.payload) this.render();
    else view.webview.html = renderMessage(this.title(), 'Connecting to the local Cluster Watcher service…');
  }

  /**
   * A refresh found the service's data unchanged (HTTP 304): keep the page,
   * which advances its own times, and tell it when the check happened.
   */
  checked(at) {
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
      vscode.window.showInformationMessage(`Job ${message.ref} is not listed in My Jobs; it may be older than 24 hours or belong to another user.`);
    }
  }

  title() {
    return this.kind === 'jobs' ? 'My Jobs' : 'Cluster Status';
  }

  update(payload) {
    this.payload = payload;
    this.render();
  }

  render() {
    if (!this.view || !this.payload) return;
    this.showingData = true;
    this.view.webview.html = renderStatus(this.payload, this.disclosures);
  }

  error(error) {
    this.showingData = false;
    if (!this.view) return;
    const detail = error instanceof Error ? error.message : String(error);
    this.view.webview.html = renderWelcome(this.title(), detail);
  }

  /** Explain that the service runs without the jobs API and how to restart it. */
  jobsApiDisabled() {
    this.showingData = false;
    if (!this.view) return;
    this.view.webview.html = renderJobsApiDisabled(this.title(), restartCommandText());
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

  resolveWebviewView(view) {
    super.resolveWebviewView(view);
    this.render();
  }

  update(payload) {
    this.payload = payload;
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
    this.showingData = true;
    this.view.webview.html = renderJobs({
      ...this.payload,
      jobs: this.archiveStore.activeJobs(this.payload.jobs || []),
      archived_jobs: this.archiveStore.archivedJobs(),
    }, this.disclosures, this.cancelling);
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
  }

  /** Process one jobs payload; ``cancelling`` suppresses jobs the user ended. */
  update(payload, cancelling) {
    const jobs = payload.jobs || [];
    const { states, finished } = jobTransitions(this.states, jobs);
    this.states = states;
    const settings = configuration();
    for (const transition of finished) {
      if (shouldNotify(settings.notifications, transition, cancelling)) void this.notify(transition);
    }
    const summary = statusSummary(jobs);
    this.item.text = summary.text;
    this.item.tooltip = summary.tooltip;
    this.item.backgroundColor = undefined;
    this.show(settings);
  }

  /** Distinguish a running service without --jobs-api from an unreachable one. */
  jobsApiDisabled() {
    this.item.text = '$(warning) Cluster Watcher: jobs API off';
    this.item.tooltip = 'The Cluster Watcher service is running without --jobs-api. Click to show My Jobs for the fix.';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.show(configuration());
  }

  /** Reflect an unreachable service without forgetting the known job states. */
  offline() {
    this.item.text = '$(debug-disconnect) Cluster Watcher offline';
    this.item.tooltip = 'The Cluster Watcher service is not reachable. Click to show My Jobs.';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.show(configuration());
  }

  show(settings) {
    if (settings.statusBar) this.item.show();
    else this.item.hide();
  }

  async notify(transition) {
    const { job, group } = transition;
    const message = notificationMessage(transition);
    const show = group === 'FAILED' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
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

/** Refresh both views together without overlapping API requests. */
class RefreshCoordinator {
  constructor(client, jobsProvider, statusProvider, monitor) {
    this.client = client;
    this.jobsProvider = jobsProvider;
    this.statusProvider = statusProvider;
    this.monitor = monitor;
    /** ETags of the last data rendered per endpoint, for conditional polling. */
    this.etags = {};
    this.inFlight = undefined;
    this.timer = undefined;
  }

  async refresh() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  async run() {
    const [jobs, status] = await Promise.allSettled([
      this.client.poll('/api/v1/jobs', this.etags.jobs),
      this.client.poll('/api/v1/snapshot', this.etags.status),
    ]);
    const checkedAt = Date.now();
    if (jobs.status === 'fulfilled' && jobs.value.notModified) {
      this.jobsProvider.checked(checkedAt);
    } else if (jobs.status === 'fulfilled') {
      this.etags.jobs = jobs.value.etag;
      // The monitor reads the cancelling set before the provider prunes it.
      this.monitor.update(jobs.value.payload, this.jobsProvider.cancelling);
      this.jobsProvider.update(jobs.value.payload);
    } else if (jobsApiDisabled(jobs.reason)) {
      this.etags.jobs = undefined;
      this.monitor.jobsApiDisabled();
      this.jobsProvider.jobsApiDisabled();
    } else {
      this.etags.jobs = undefined;
      this.monitor.offline();
      this.jobsProvider.error(jobs.reason);
    }
    if (status.status === 'fulfilled' && status.value.notModified) {
      this.statusProvider.checked(checkedAt);
    } else if (status.status === 'fulfilled') {
      this.etags.status = status.value.etag;
      this.statusProvider.update(status.value.payload);
    } else {
      this.etags.status = undefined;
      this.statusProvider.error(status.reason);
    }
  }

  schedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.refresh(), configuration().refreshSeconds * 1000);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
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
  void coordinator.refresh();
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
  const settings = configuration();
  await validateExecutable(settings.executable);
  const terminal = vscode.window.createTerminal({ name: 'Cluster Watcher Setup' });
  terminal.show();
  terminal.sendText(cliCommand(settings, ['setup']), true);
}

/** Open the CLI's configuration file in an editor tab, offering setup when it is missing. */
async function editConfig() {
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
  const client = new BackendClient();
  const jobsProvider = new JobsSidebarProvider(context.globalState);
  const statusProvider = new SidebarProvider('status');
  const monitor = new JobMonitor();
  const coordinator = new RefreshCoordinator(client, jobsProvider, statusProvider, monitor);
  const controller = new ServiceController(client, () => coordinator.refresh());
  const logProvider = new JobLogDocumentProvider(client);
  const scriptProvider = new JobScriptDocumentProvider(client);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('clusterWatcher.jobs', jobsProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider('clusterWatcher.status', statusProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider('cluster-watcher-log', logProvider),
    vscode.workspace.registerTextDocumentContentProvider('cluster-watcher-script', scriptProvider),
    vscode.commands.registerCommand('clusterWatcher.startService', async () => {
      try { await controller.start(); } catch (error) { await reportStartError(error); }
    }),
    vscode.commands.registerCommand('clusterWatcher.stopService', () => controller.stop()),
    vscode.commands.registerCommand('clusterWatcher.refresh', () => coordinator.refresh()),
    vscode.commands.registerCommand('clusterWatcher.openDashboard', () => vscode.env.openExternal(vscode.Uri.parse(configuration().backendUrl))),
    vscode.commands.registerCommand('clusterWatcher.showServiceTerminal', () => controller.showTerminal()),
    vscode.commands.registerCommand('clusterWatcher.archiveJob', async (key) => {
      if (!await jobsProvider.archive(String(key))) vscode.window.showWarningMessage('That job is no longer available to archive.');
    }),
    vscode.commands.registerCommand('clusterWatcher.restoreJob', async (key) => {
      if (!await jobsProvider.restore(String(key))) vscode.window.showWarningMessage('That archived job could not be found.');
    }),
    vscode.commands.registerCommand('clusterWatcher.copyServiceCommand', () => copyServiceCommand()),
    vscode.commands.registerCommand('clusterWatcher.runSetup', () => runSetup().catch(reportError)),
    vscode.commands.registerCommand('clusterWatcher.editConfig', () => editConfig().catch(reportError)),
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
        for (const provider of [jobsProvider, statusProvider]) if (provider.showingData) provider.render();
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
  if (configuration().autoStart) void controller.start().catch(reportStartError);
}

/** VS Code disposes all registered resources through the extension context. */
function deactivate() {}

module.exports = { activate, deactivate };
