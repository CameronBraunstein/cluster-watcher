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
    await Promise.all([this.refreshJobs(), this.refreshStatus()]);
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
        this.jobsProvider.checked(checkedAt);
        return;
      }
      this.etags.jobs = result.etag;
      // The monitor reads the cancelling set before the provider prunes it.
      this.monitor.update(result.payload, this.jobsProvider.cancelling);
      this.jobsProvider.update(result.payload, checkedAt);
    } catch (error) {
      this.etags.jobs = undefined;
      if (this.isJobsApiDisabled(error)) {
        this.monitor.jobsApiDisabled();
        this.jobsProvider.jobsApiDisabled();
      } else {
        this.monitor.offline();
        this.jobsProvider.error(error);
      }
    }
  }

  /** Poll and render the snapshot endpoint without touching My Jobs. */
  async runStatus() {
    try {
      const result = await this.client.poll('/api/v1/snapshot', this.etags.status);
      const checkedAt = Date.now();
      if (result.notModified) {
        this.statusProvider.checked(checkedAt);
        return;
      }
      this.etags.status = result.etag;
      this.statusProvider.update(result.payload, checkedAt);
    } catch (error) {
      this.etags.status = undefined;
      this.statusProvider.error(error);
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

module.exports = { RefreshCoordinator };
