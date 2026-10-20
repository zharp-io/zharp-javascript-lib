import { LogEntry } from './types';

// In-memory queue that holds log entries until they are flushed to the API.
// Acts as a buffer so log calls never block the caller — entries are collected
// here and sent in batches by the Transport on a timer.
export class LogQueue {
  private entries: LogEntry[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  push(entry: LogEntry): void {
    // Drop the oldest entry if the queue is full rather than growing unbounded.
    // This can happen if the network is down for a long time.
    if (this.entries.length >= this.maxSize) {
      this.entries.shift();
    }
    this.entries.push(entry);
  }

  // Remove and return up to `count` entries from the front of the queue.
  drain(count: number): LogEntry[] {
    return this.entries.splice(0, count);
  }

  get size(): number {
    return this.entries.length;
  }
}
