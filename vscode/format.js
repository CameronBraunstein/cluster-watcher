'use strict';

/** Escape untrusted API text before inserting it into a webview document. */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

/**
 * Format a non-negative duration compactly. Self-contained, because the
 * webview script embeds its source to keep countdowns current.
 */
function formatDuration(value) {
  if (value == null || !Number.isFinite(Number(value))) return '?';
  let seconds = Math.max(0, Math.floor(Number(value)));
  if (seconds === 0) return 'now';
  const days = Math.floor(seconds / 86400); seconds %= 86400;
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  if (days) return `${days}d${hours ? ` ${hours}h` : ''}`;
  if (hours) return `${hours}h${minutes ? ` ${minutes}m` : ''}`;
  if (minutes) return `${minutes}m`;
  return '<1m';
}

module.exports = { escapeHtml, formatDuration };
