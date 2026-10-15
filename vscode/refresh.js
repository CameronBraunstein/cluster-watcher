'use strict';

/** Recognize the backend's temporary response before its first Slurm collection. */
function initialCollectionPending(error) {
  return error?.status === 503 && /first cluster status collection has not completed/i.test(error.message || '');
}

/**
 * Coordinate independent jobs and cluster-status polling.
 *
 * Each endpoint has its own in-flight promise and ETag. This lets a view-title
 * refresh update only its view without duplicating a request already started
 * by scheduled or combined polling.
 */
class RefreshCoordinator {
  /**
   * @param {object} client Backend client with a conditional ``poll`` method.
   * @param {object} jobsProvider Provider for the My Jobs webview.
   * @param {object} statusProvider Provider for the Cluster Status webview.
   * @param {object} monitor Job-transition notification monitor.
   * @param {object} options Environment-specific callbacks.
   * @param {(error: unknown) => boolean} options.jobsApiDisabled Detect an intentionally disabled jobs API.
   * @param {() => number} options.refreshSeconds Return the current polling interval in seconds.
   * @param {() => Promise<object>} [options.refreshServer] Refresh local service/session state.
   * @param {() => void} [options.onServiceAvailable] Reveal live views on a successful API response.
   * @param {(callback: Function, delay: number) => unknown} [options.setTimeout] Schedule a first-load retry.
   * @param {(handle: unknown) => void} [options.clearTimeout] Cancel a first-load retry.
   */
  constructor(client, jobsProvider, statusProvider, monitor, options) {
    this.client = client;
    this.jobsProvider = jobsProvider;
    this.statusProvider = statusProvider;
    this.monitor = monitor;
    this.isJobsApiDisabled = options.jobsApiDisabled;
    this.refreshSeconds = options.refreshSeconds;
    this.serverRefresh = options.refreshServer;
    this.onServiceAvailable = options.onServiceAvailable || (() => {});
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    /** ETags of the last data rendered per endpoint, for conditional polling. */
    this.etags = {};
    this.jobsInFlight = undefined;
    this.statusInFlight = undefined;
    this.serverInFlight = undefined;
    this.jobsRetry = undefined;
    this.statusRetry = undefined;
    this.timer = undefined;
    this.disposed = false;
    this.serviceGeneration = 0;
  }

  /** Replace stale offline indicators as soon as a service becomes reachable. */
  serviceReachable() {
    this.serviceGeneration += 1;
    this.jobsProvider.loading();
    this.statusProvider.loading();
    this.monitor.loading();
  }

  /** Retry a known first-collection 503 without waiting for the normal interval. */
  retryFirstCollection(kind) {
    if (this.disposed) return;
    const key = kind === 'jobs' ? 'jobsRetry' : 'statusRetry';
    if (this[key] !== undefined) return;
    this[key] = this.setTimeout(() => {
      this[key] = undefined;
      void (kind === 'jobs' ? this.refreshJobs() : this.refreshStatus());
    }, 1000);
  }

  /** A manual or startup refresh supersedes a scheduled first-load retry. */
  clearFirstCollectionRetry(kind) {
    const key = kind === 'jobs' ? 'jobsRetry' : 'statusRetry';
    if (this[key] === undefined) return;
    this.clearTimeout(this[key]);
    this[key] = undefined;
  }

  /** Refresh both views, reusing any endpoint refresh already in progress. */
  async refresh() {
    const operations = [this.refreshJobs(), this.refreshStatus()];
    if (this.serverRefresh) operations.push(this.refreshServer());
    return Promise.all(operations);
  }

  /** Refresh the extension-managed process and reusable SSH-session inventory. */
  async refreshServer() {
    if (!this.serverRefresh) return { outcome: 'unchanged', checkedAt: Date.now() };
    if (this.serverInFlight) return this.serverInFlight;
    const operation = this.serverRefresh().finally(() => {
      if (this.serverInFlight === operation) this.serverInFlight = undefined;
    });
    this.serverInFlight = operation;
    return operation;
  }

  /** Refresh only My Jobs, coalescing overlapping requests. */
  async refreshJobs() {
    this.clearFirstCollectionRetry('jobs');
    if (this.jobsInFlight) return this.jobsInFlight;
    const operation = this.runJobs().finally(() => {
      if (this.jobsInFlight === operation) this.jobsInFlight = undefined;
    });
    this.jobsInFlight = operation;
    return operation;
  }

  /** Refresh only Cluster Status, coalescing overlapping requests. */
  async refreshStatus() {
    this.clearFirstCollectionRetry('status');
    if (this.statusInFlight) return this.statusInFlight;
    const operation = this.runStatus().finally(() => {
      if (this.statusInFlight === operation) this.statusInFlight = undefined;
    });
    this.statusInFlight = operation;
    return operation;
  }

  /** Poll and render the jobs endpoint without touching Cluster Status. */
  async runJobs() {
    const generation = this.serviceGeneration;
    try {
      const result = await this.client.poll('/api/v1/jobs', this.etags.jobs);
      const checkedAt = Date.now();
      this.onServiceAvailable();
      if (result.notModified) {
        this.monitor.checked(checkedAt);
        this.jobsProvider.checked(checkedAt);
        return { outcome: 'unchanged', checkedAt };
      }
      this.etags.jobs = result.etag;
      // The monitor reads the cancelling set before the provider prunes it.
      this.monitor.update(result.payload, this.jobsProvider.cancelling, checkedAt);
      this.jobsProvider.update(result.payload, checkedAt);
      return { outcome: 'updated', checkedAt };
    } catch (error) {
      this.etags.jobs = undefined;
      const collecting = initialCollectionPending(error);
      if (collecting || generation !== this.serviceGeneration) {
        if (collecting) this.onServiceAvailable();
        this.monitor.loading();
        this.jobsProvider.loading();
        this.retryFirstCollection('jobs');
        return { outcome: 'loading', checkedAt: Date.now() };
      }
      if (this.isJobsApiDisabled(error)) {
        this.monitor.jobsApiDisabled();
        this.jobsProvider.jobsApiDisabled();
      } else {
        this.monitor.offline();
        this.jobsProvider.error(error);
      }
      return { outcome: 'error', checkedAt: Date.now(), error };
    }
  }

  /** Poll and render the snapshot endpoint without touching My Jobs. */
  async runStatus() {
    const generation = this.serviceGeneration;
    try {
      const result = await this.client.poll('/api/v1/snapshot', this.etags.status);
      const checkedAt = Date.now();
      this.onServiceAvailable();
      if (result.notModified) {
        this.statusProvider.checked(checkedAt);
        return { outcome: 'unchanged', checkedAt };
      }
      this.etags.status = result.etag;
      this.statusProvider.update(result.payload, checkedAt);
      return { outcome: 'updated', checkedAt };
    } catch (error) {
      this.etags.status = undefined;
      const collecting = initialCollectionPending(error);
      if (collecting || generation !== this.serviceGeneration) {
        if (collecting) this.onServiceAvailable();
        this.statusProvider.loading();
        this.retryFirstCollection('status');
        return { outcome: 'loading', checkedAt: Date.now() };
      }
      this.statusProvider.error(error);
      return { outcome: 'error', checkedAt: Date.now(), error };
    }
  }

  /** Restart scheduled combined polling using the current interval setting. */
  schedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.refresh(), this.refreshSeconds() * 1000);
  }

  /** Stop scheduled polling. */
  dispose() {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.clearFirstCollectionRetry('jobs');
    this.clearFirstCollectionRetry('status');
  }
}

/**
 * Keep manual-refresh feedback visible long enough to be perceived.
 *
 * Calls for the same context key share one operation, so rapid clicks cannot
 * end the spinner early or start duplicate refreshes.
 */
class RefreshFeedback {
  constructor(setContext, options = {}) {
    this.setContext = setContext;
    this.minimumMilliseconds = options.minimumMilliseconds ?? 550;
    this.now = options.now || (() => Date.now());
    this.delay = options.delay || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.inFlight = new Map();
  }

  /** Run an action while its context key selects a spinning title icon. */
  async run(contextKey, action) {
    const existing = this.inFlight.get(contextKey);
    if (existing) return existing;
    const startedAt = this.now();
    const operation = (async () => {
      await this.setContext(contextKey, true);
      try {
        return await action();
      } finally {
        const remaining = this.minimumMilliseconds - (this.now() - startedAt);
        if (remaining > 0) await this.delay(remaining);
        await this.setContext(contextKey, false);
      }
    })();
    this.inFlight.set(contextKey, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(contextKey) === operation) this.inFlight.delete(contextKey);
    }
  }
}

/** Return the notification for a successful manual endpoint check. */
function refreshResultMessage(result, formattedAt) {
  if (result?.outcome === 'updated') return `Refreshed at: ${formattedAt}`;
  if (result?.outcome === 'unchanged') return `Checked, but no updates at: ${formattedAt}`;
  return undefined;
}

module.exports = { RefreshCoordinator, RefreshFeedback, initialCollectionPending, refreshResultMessage };
