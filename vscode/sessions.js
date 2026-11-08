'use strict';

/** Describe remaining whole hours and minutes as a compact clock label. */
function sessionTimeLeft(seconds) {
  const totalMinutes = Math.floor(Math.max(0, Number(seconds)) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `🕒 ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')} left`;
}

/** Format each SSH session separately for rendering with visual separators. */
function sessionDialogEntries(inventory = {}) {
  const rows = (Array.isArray(inventory.machines) ? inventory.machines : [])
    .map((session) => {
      const name = String(session.name || 'Unknown cluster');
      const username = String(session.username || 'Unknown account');
      const host = String(session.host || 'Unknown host');
      let remaining = 'closed';
      if (session.session_open && session.control_persist_seconds == null) remaining = 'no idle limit';
      else if (session.session_open && session.estimated_remaining_seconds != null
          && Number.isFinite(Number(session.estimated_remaining_seconds))) {
        remaining = sessionTimeLeft(session.estimated_remaining_seconds);
      } else if (session.session_open) remaining = 'remaining time unknown';
      return { name, username, host, remaining };
    });
  return rows.map(({ name, username, host, remaining }) => `${name}: ${username}@${host}\n${remaining}`);
}

/** Format SSH inventory as plain, selectable text for the sidebar dialog. */
function sessionDialogText(inventory) {
  return sessionDialogEntries(inventory).join('\n\n') || 'No SSH sessions are available.';
}

module.exports = { sessionDialogEntries, sessionDialogText };
