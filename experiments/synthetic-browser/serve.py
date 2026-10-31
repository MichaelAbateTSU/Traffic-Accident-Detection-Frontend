"""Measure genuine inference without exposing detections, embeddings or raw logs."""
import functools
import json
from pathlib import Path
import uvicorn
from app import main
from app.services import detection_service as service

counts = {"yolo_calls": 0, "tracker_calls": 0, "scorer_calls": 0, "vehicle_detections": 0}
if Path("/data/inference-counts.json").exists():
    counts.update(json.loads(Path("/data/inference-counts.json").read_text()))


def measure(owner, name, key, length_key=None):
    original = getattr(owner, name)

    @functools.wraps(original)
    def wrapped(*args, **kwargs):
        result = original(*args, **kwargs)
        counts[key] += 1
        if length_key:
            counts[length_key] += len(result)
        return result

    setattr(owner, name, wrapped)


measure(service, "_run_yolo", "yolo_calls", "vehicle_detections")
measure(service.DeepSortTracker, "update", "tracker_calls")
measure(service.AccidentScorer, "update", "scorer_calls")
original_job = service.run_detection_job


def measured_job(*args, **kwargs):
    try:
        return original_job(*args, **kwargs)
    finally:
        Path("/data/inference-counts.json").write_text(json.dumps(counts))


main.run_detection_job = measured_job
uvicorn.run(main.app, host="0.0.0.0", port=8000, workers=1,
            access_log=False, proxy_headers=True, forwarded_allow_ips="172.29.68.3")
