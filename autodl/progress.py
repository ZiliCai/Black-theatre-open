"""Model bytes already on disk, plus throughput across all concurrent transfers."""
import time
from collections import deque

from ranges import saved_size


class DownloadProgress:
    # The worker serializes calls with its state-file lock.
    def __init__(self, files, pending):
        self.total = sum(spec['bytes'] for spec in files.values())
        self.sizes = {path: spec['bytes'] for path, spec in pending}
        self.saved = {path: saved_size(path.with_suffix(path.suffix + '.part'), spec) for path, spec in pending}
        self.cached = self.total - sum(self.sizes.values())
        self.samples = deque([(time.monotonic(), self.count())])
        self.updated = time.time()

    def count(self):
        return self.cached + sum(self.saved.values())

    def record(self, path, size):
        now = time.monotonic()
        size = min(self.sizes[path], max(0, size))
        previous = self.saved[path]
        if size != previous:
            self.updated = time.time()
        self.saved[path] = size
        if size < previous:
            self.samples.clear()
        self.samples.append((now, self.count()))
        while len(self.samples) > 1 and self.samples[0][0] < now - 60:
            self.samples.popleft()

    def snapshot(self):
        saved = self.count()
        start, baseline = self.samples[0]
        elapsed = time.monotonic() - start
        rate = (saved - baseline) / elapsed if elapsed >= 5 and time.time() - self.updated < 45 else 0
        return {'total': self.total, 'saved': saved, 'rate': max(0, round(rate)), 'updated': self.updated}
