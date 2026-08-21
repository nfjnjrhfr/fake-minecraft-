'use strict';

const fs = require('fs');
const path = require('path');

const SCAN_INTERVAL_MS = 350;

/**
 * A dependency-free directory watcher. `fs.watch` is inconsistent across
 * platforms and network drives, so the bridge takes a cheap fingerprint of the
 * mapped directories on an interval instead. Projects synced to Studio are
 * small enough that this costs almost nothing.
 */
class Watcher {
  constructor(directories, onChange, intervalMs = SCAN_INTERVAL_MS) {
    this.directories = directories;
    this.onChange = onChange;
    this.intervalMs = intervalMs;
    this.fingerprint = null;
    this.timer = null;
  }

  start() {
    this.fingerprint = this.scan();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Call after writing files yourself, so the write does not echo back. */
  resync() {
    this.fingerprint = this.scan();
  }

  tick() {
    const next = this.scan();
    if (next !== this.fingerprint) {
      this.fingerprint = next;
      this.onChange();
    }
  }

  scan() {
    const parts = [];
    for (const dir of this.directories) {
      this.scanInto(dir, parts);
    }
    return parts.join('|');
  }

  scanInto(dir, parts) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      parts.push(dir + ' missing');
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        parts.push(full + ' dir');
        this.scanInto(full, parts);
        continue;
      }

      try {
        const stat = fs.statSync(full);
        parts.push(full + ' ' + stat.size + ' ' + stat.mtimeMs);
      } catch (err) {
        // The file vanished mid-scan; the next tick will pick up the change.
      }
    }
  }
}

module.exports = { Watcher };
