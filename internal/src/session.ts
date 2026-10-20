import { shared } from './shared';

// Generates a UUID v4 without external dependencies
function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// One session ID per page load / app session.
// Attached to every log entry and every recording so you can correlate all events
// from a single user session across frontend and backend.
//
// Kept on the shared handle rather than in a module variable: @zharp/logs and @zharp/apm each
// bundle this file, and a log and the recording of the same page must carry the same ID.
export function getSessionId(): string {
  const handle = shared();
  if (!handle.sessionId) handle.sessionId = uuid();
  return handle.sessionId;
}

export function resetSessionId(): void {
  shared().sessionId = uuid();
}
