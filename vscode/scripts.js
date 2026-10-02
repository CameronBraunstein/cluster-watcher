'use strict';

/** Build the loopback API path for one job's batch script. */
function scriptRequestPath(cluster, jobId) {
  return `/api/v1/jobs/${encodeURIComponent(cluster)}/${encodeURIComponent(jobId)}/script`;
}

/** Build a safe virtual-document path; `.sh` lets VS Code pick shell highlighting. */
function virtualScriptPath(cluster, jobId) {
  const safe = (value) => String(value).replace(/[^A-Za-z0-9_.-]/g, '_');
  return `/${safe(cluster)}/${safe(jobId)}.sbatch.sh`;
}

/**
 * Describe where a script came from. Only a `file` result can differ from what
 * was submitted, because Slurm kept no copy of the finished job's script.
 */
function scriptSourceMessage(payload) {
  const truncated = payload.truncated ? ' It was cut off at 1 MiB.' : '';
  if (payload.source === 'file') {
    return `Job ${payload.job_id}: Slurm kept no copy of the submitted script, so this is the current file ${payload.path}; it may have been edited since the job was submitted.${truncated}`;
  }
  const holder = payload.source === 'accounting' ? 'Slurm accounting' : 'the Slurm controller';
  return `Job ${payload.job_id}: exact script as submitted, from ${holder}.${truncated}`;
}

module.exports = { scriptRequestPath, scriptSourceMessage, virtualScriptPath };
