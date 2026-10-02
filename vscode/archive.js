'use strict';

const { jobKey } = require('./renderers');

const JOB_ARCHIVE_STORAGE_KEY = 'clusterWatcher.archivedJobs.v1';

/** Maintain persistent archived and explicitly restored job snapshots. */
class JobArchive {
  constructor(storage) {
    this.storage = storage;
    const saved = storage.get(JOB_ARCHIVE_STORAGE_KEY, {}) || {};
    const toMap = (jobs) => new Map((Array.isArray(jobs) ? jobs : []).map((job) => [jobKey(job), job]));
    this.archived = toMap(saved.jobs);
    this.restored = toMap(saved.restored_jobs);
  }

  /** Merge refreshed records without changing which list owns each job. */
  merge(jobs) {
    let changed = false;
    for (const job of jobs) {
      const key = jobKey(job);
      if (this.archived.has(key)) { this.archived.set(key, { ...this.archived.get(key), ...job }); changed = true; }
      if (this.restored.has(key)) { this.restored.set(key, { ...this.restored.get(key), ...job }); changed = true; }
    }
    return changed ? this.persist() : Promise.resolve();
  }

  /** Return current/restored jobs excluding anything in the archive. */
  activeJobs(currentJobs) {
    const active = new Map(this.restored);
    for (const job of currentJobs) active.set(jobKey(job), job);
    for (const key of this.archived.keys()) active.delete(key);
    return [...active.values()];
  }

  /** Return saved job snapshots in the order they entered the archive. */
  archivedJobs() {
    return [...this.archived.values()];
  }

  /** Move one current or locally restored job into persistent storage. */
  async archiveJob(currentJobs, key) {
    const job = currentJobs.find((candidate) => jobKey(candidate) === key) || this.restored.get(key);
    if (!job) return false;
    this.archived.set(key, { ...job, archived_at: new Date().toISOString() });
    this.restored.delete(key);
    await this.persist();
    return true;
  }

  /** Move one archived snapshot back into the active list. */
  async restoreJob(key) {
    const job = this.archived.get(key);
    if (!job) return false;
    const { archived_at: _archivedAt, ...restored } = job;
    this.archived.delete(key);
    this.restored.set(key, restored);
    await this.persist();
    return true;
  }

  /** Write the versioned archive document to VS Code global state. */
  persist() {
    return this.storage.update(JOB_ARCHIVE_STORAGE_KEY, {
      version: 1,
      jobs: this.archivedJobs(),
      restored_jobs: [...this.restored.values()],
    });
  }
}

module.exports = { JOB_ARCHIVE_STORAGE_KEY, JobArchive };
