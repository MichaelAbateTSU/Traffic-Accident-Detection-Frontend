"""Durable test-only invocation/progress evidence; genuine model functions stay intact."""
import json
import os
from pathlib import Path
import threading


class InferenceInventory:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        empty = dict.fromkeys((
            "inference_invocations", "finished_invocations", "in_progress",
            "yolo_calls", "tracker_calls", "scorer_calls", "vehicle_detections",
        ), 0)
        self.counts = json.loads(self.path.read_text()) if self.path.exists() else empty
        if (set(self.counts) != set(empty) or
                any(type(value) is not int or value < 0 for value in self.counts.values())):
            raise ValueError("Invalid durable inference inventory")
        self._persist()

    def _persist(self):
        temporary = self.path.with_suffix(".next")
        with temporary.open("w") as output:
            json.dump(self.counts, output)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(self.path)
        descriptor = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def increment(self, field, count=1):
        with self.lock:
            self.counts[field] += count
            self._persist()

    def begin(self):
        with self.lock:
            self.counts["inference_invocations"] += 1
            self.counts["in_progress"] += 1
            self._persist()

    def finish(self):
        with self.lock:
            if self.counts["in_progress"] < 1:
                raise AssertionError("Inference finish without a recorded invocation")
            self.counts["finished_invocations"] += 1
            self.counts["in_progress"] -= 1
            self._persist()
