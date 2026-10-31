"""Measure genuine inference without exposing detections, embeddings or raw logs."""
import functools
import json
import os
import time
from pathlib import Path
import uvicorn
from app import main
from app.services import detection_service as service

counts = {"yolo_calls": 0, "tracker_calls": 0, "scorer_calls": 0, "vehicle_detections": 0}


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
        if os.environ.get("SYNTHETIC_DETAIL_GATE") == "1":
            deadline = time.monotonic() + 15
            while not Path("/tmp/synthetic-detail-gate-release").exists() and time.monotonic() < deadline:
                time.sleep(0.025)
        return original_job(*args, **kwargs)
    finally:
        Path("/data/inference-counts.json").write_text(json.dumps(counts))


main.run_detection_job = measured_job
cleanup_admission_fault = None
if os.environ.get("SYNTHETIC_ADMISSION_FAULT") == "1" or Path("/data/admission-fault-enable").exists():
    from admission_failure_fault import install_admission_failure_fault
    cleanup_admission_fault = install_admission_failure_fault(
        main.job_store, main.DetectionQueue, "/data/jobs.sqlite3",
        "/tmp/synthetic-admission-fault",
    )
try:
    uvicorn.run(main.app, host="0.0.0.0", port=8000, workers=1,
                access_log=False, proxy_headers=True, forwarded_allow_ips="172.29.68.3")
finally:
    if cleanup_admission_fault is not None:
        cleanup_admission_fault()
