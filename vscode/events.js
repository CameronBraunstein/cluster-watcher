'use strict';

const { isFailureGroup, jobKey, jobRef, stateGroup } = require('./renderers');

const ACTIVE_GROUPS = new Set(['RUNNING', 'PENDING']);
const FINISHED_GROUPS = new Set(['COMPLETED', 'FAILED_EARLY', 'FAILED_TIMEOUT', 'CANCELLED']);
const NOTIFICATION_MODES = new Set(['all', 'failures', 'off']);

/**
 * Compare one jobs payload with the previous refresh's state groups.
 *
 * ``previous`` maps job keys to state groups, or is ``null`` on the first
 * refresh, which establishes a baseline without reporting anything (so
 * reloading VS Code does not replay a day of completions). Returns the new
 * map and the jobs that moved from running/pending to a finished group.
 */
function jobTransitions(previous, jobs) {
  const states = new Map();
  const finished = [];
  for (const job of jobs || []) {
    const key = jobKey(job);
    const group = stateGroup(job.state);
    states.set(key, group);
    if (previous && ACTIVE_GROUPS.has(previous.get(key)) && FINISHED_GROUPS.has(group)) {
      finished.push({ job, group });
    }
  }
  return { states, finished };
}

/**
 * Decide whether a finished job deserves a notification under the
 * ``clusterWatcher.notifications`` mode. Jobs the user ended from the sidebar
 * (``cancelling`` holds their ``cluster/job_id`` refs) are never reported.
 */
function shouldNotify(mode, transition, cancelling = new Set()) {
  const effective = NOTIFICATION_MODES.has(mode) ? mode : 'all';
  if (effective === 'off') return false;
  if (transition.group === 'CANCELLED' && cancelling.has(jobRef(transition.job))) return false;
  return effective === 'all' || isFailureGroup(transition.group);
}

/** Return the notification sentence for one finished job. */
function notificationMessage({ job, group }) {
  const identifier = String(job.job_id || job.id || '');
  const label = job.name && job.name !== identifier ? `"${job.name}" (${identifier})` : identifier;
  const outcome = group === 'COMPLETED' ? 'completed' : group === 'CANCELLED' ? 'was cancelled' : `failed (${job.state}${job.exit_code ? `, exit ${job.exit_code}` : ''})`;
  return `Job ${label} on ${job.cluster} ${outcome}.`;
}

/** Build the status-bar text and tooltip for the current jobs payload. */
function statusSummary(jobs) {
  let running = 0;
  let pending = 0;
  for (const job of jobs || []) {
    const group = stateGroup(job.state);
    if (group === 'RUNNING') running += 1;
    else if (group === 'PENDING') pending += 1;
  }
  const text = running || pending ? `$(server-process) ${running} running · ${pending} pending` : '$(server-process) no active jobs';
  return { text, tooltip: `Cluster Watcher: ${running} running and ${pending} pending job(s). Click to show My Jobs.` };
}

module.exports = { jobTransitions, notificationMessage, shouldNotify, statusSummary };
