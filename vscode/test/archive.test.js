'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JobArchive } = require('../archive');
const { jobKey } = require('../renderers');

class MemoryStorage {
  constructor(document = undefined) {
    this.document = document;
  }

  get(_key, fallback) {
    return this.document || fallback;
  }

  async update(_key, document) {
    this.document = document;
  }
}

function job(id, state = 'COMPLETED') {
  return {
    cluster: 'cluster_1', job_id: id, name: `job-${id}`, state,
    submit_at: `2026-10-01T10:00:0${id}Z`,
  };
}

test('archived jobs persist, disappear from active jobs, and can be restored', async () => {
  const storage = new MemoryStorage();
  const archive = new JobArchive(storage);
  const jobs = [job('1'), job('2')];

  assert.equal(await archive.archiveJob(jobs, jobKey(jobs[0])), true);
  assert.deepEqual(archive.activeJobs(jobs).map((item) => item.job_id), ['2']);
  assert.deepEqual(archive.archivedJobs().map((item) => item.job_id), ['1']);

  const reopened = new JobArchive(storage);
  assert.deepEqual(reopened.archivedJobs().map((item) => item.job_id), ['1']);
  assert.equal(await reopened.restoreJob(jobKey(jobs[0])), true);
  assert.deepEqual(reopened.activeJobs([]).map((item) => item.job_id), ['1']);
});

test('a refresh updates the archived snapshot without unarchiving it', async () => {
  const storage = new MemoryStorage();
  const archive = new JobArchive(storage);
  const original = job('3', 'RUNNING');
  await archive.archiveJob([original], jobKey(original));

  await archive.merge([{ ...original, state: 'COMPLETED', elapsed_seconds: 30 }]);

  assert.equal(archive.archivedJobs()[0].state, 'COMPLETED');
  assert.equal(archive.activeJobs([original]).length, 0);
});
