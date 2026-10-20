// Generates a UUID v4 without external dependencies
function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// One session ID per page load / app session.
// Attached to every log entry so you can correlate all events
// from a single user session across frontend and backend.
let _sessionId: string | null = null;

export function getSessionId(): string {
  if (!_sessionId) _sessionId = uuid();
  return _sessionId;
}

export function resetSessionId(): void {
  _sessionId = uuid();
}
