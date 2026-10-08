'use strict';

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
   */
  constructor(client, jobsProvider, statusProvider, monitor, options) {
    this.client = client;
    this.jobsProvider = jobsProvider;
    this.statusProvider = statusProvider;
    this.monitor = monitor;
    this.isJobsApiDisabled = options.jobsApiDisabled;
    this.refreshSeconds = options.refreshSeconds;
    /** ETags of the last data rendered per endpoint, for conditional polling. */
    this.etags = {};
    this.jobsInFlight = undefined;
    this.statusInFlight = undefined;
    this.timer = undefined;
  }

  /** Refresh both views, reusing any endpoint refresh already in progress. */
  async refresh() {
    return Promise.all([this.refreshJobs(), this.refreshStatus()]);
  }

  /** Refresh only My Jobs, coalescing overlapping requests. */
  async refreshJobs() {
    if (this.jobsInFlight) return this.jobsInFlight;
    const operation = this.runJobs().finally(() => {
      if (this.jobsInFlight === operation) this.jobsInFlight = undefined;
    });
    this.jobsInFlight = operation;
    return operation;
  }

  /** Refresh only Cluster Status, coalescing overlapping requests. */
  async refreshStatus() {
    if (this.statusInFlight) return this.statusInFlight;
    const operation = this.runStatus().finally(() => {
      if (this.statusInFlight === operation) this.statusInFlight = undefined;
    });
    this.statusInFlight = operation;
    return operation;
  }

  /** Poll and render the jobs endpoint without touching Cluster Status. */
  async runJobs() {
    try {
      const result = await this.client.poll('/api/v1/jobs', this.etags.jobs);
      const checkedAt = Date.now();
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
    try {
      const result = await this.client.poll('/api/v1/snapshot', this.etags.status);
      const checkedAt = Date.now();
      if (result.notModified) {
        this.statusProvider.checked(checkedAt);
        return { outcome: 'unchanged', checkedAt };
      }
      this.etags.status = result.etag;
      this.statusProvider.update(result.payload, checkedAt);
      return { outcome: 'updated', checkedAt };
    } catch (error) {
      this.etags.status = undefined;
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
    if (this.timer) clearInterval(this.timer);
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

module.exports = { RefreshCoordinator, RefreshFeedback, refreshResultMessage };
