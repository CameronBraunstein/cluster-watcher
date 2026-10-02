'use strict';

const LOG_TAIL_LINES = 2000;

/** Build the bounded loopback API path for one Slurm job log page. */
function logRequestPath(cluster, jobId, stream, before = 0) {
  if (!['err', 'out'].includes(stream)) throw new Error('Log stream must be err or out');
  if (!Number.isInteger(before) || before < 0) throw new Error('Log offset must be a non-negative integer');
  return `/api/v1/jobs/${encodeURIComponent(cluster)}/${encodeURIComponent(jobId)}/log?stream=${stream}&tail=${LOG_TAIL_LINES}&before=${before}`;
}

/** Build a safe virtual-document path without trusting remote path syntax. */
function virtualLogPath(cluster, jobId, stream) {
  if (!['err', 'out'].includes(stream)) throw new Error('Log stream must be err or out');
  const safe = (value) => String(value).replace(/[^A-Za-z0-9_.-]/g, '_');
  return `/${safe(cluster)}/${safe(jobId)}.${stream}`;
}

/** Label partial and incrementally expanded read-only log documents. */
function logDocumentContent(payload) {
  const content = payload.content || '';
  const loaded = Number(payload.loadedLines ?? payload.lines) || 0;
  const moreBefore = Boolean(payload.moreBefore ?? payload.more_before ?? payload.truncated);
  if (!moreBefore && loaded <= LOG_TAIL_LINES) return content;
  const path = payload.path || `job.${payload.stream || 'log'}`;
  const status = moreBefore
    ? `showing the newest ${loaded} lines of ${path}; use "Load 2,000 Older Lines" to continue`
    : `showing all ${loaded} lines of ${path}`;
  return `[Cluster Watcher: ${status}]\n\n${content}`;
}

/** Prepend one older API page while retaining the virtual document metadata. */
function prependLogPage(record, page) {
  return {
    ...record,
    content: `${page.content || ''}${record.content || ''}`,
    loadedLines: (Number(record.loadedLines) || 0) + (Number(page.lines) || 0),
    moreBefore: Boolean(page.more_before ?? page.truncated),
    path: page.path || record.path,
  };
}

module.exports = { LOG_TAIL_LINES, logDocumentContent, logRequestPath, prependLogPage, virtualLogPath };
