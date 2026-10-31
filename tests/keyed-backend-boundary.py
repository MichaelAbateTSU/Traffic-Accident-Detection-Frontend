"""Pinned backend HTTP routes with real receipt storage, but no inference or media access."""

import json
import logging
import socket
import sys
from datetime import datetime, timezone

import uvicorn
from fastapi import FastAPI

from app.api import detect, jobs
from app.core.config import settings
from app.core.security import AuthenticationMiddleware
from app.services.job_store import JobStore

logging.disable(logging.CRITICAL)
settings.api_prefix = "/api"
store = JobStore(database_path=sys.argv[1], start_reaper=False)
detect.job_store = store
jobs.job_store = store


class FakeQueue:
    def __init__(self):
        self.count = 0

    def submit(self, job_id, source, max_frames, model, save_frames):
        self.count += 1
        if "/admission-failure.mp4" in source:
            raise RuntimeError("Synthetic queue admission failure")
        if "/held-job.mp4" in source:
            return
        store.update(job_id, status="complete", completed_at=datetime.now(timezone.utc),
                     frames_processed=max_frames)


queue = FakeQueue()
app = FastAPI()
app.add_middleware(AuthenticationMiddleware)
app.include_router(detect.router, prefix=settings.api_prefix)
app.include_router(jobs.router, prefix=settings.api_prefix)
app.state.model = object()
app.state.detection_queue = queue


@app.get("/__fixture/count")
def count():
    return {"count": queue.count}


sock = socket.socket()
sock.bind(("127.0.0.1", 0))
sock.listen(128)
print(json.dumps({"port": sock.getsockname()[1]}), flush=True)
uvicorn.Server(uvicorn.Config(app, log_level="error")).run(sockets=[sock])
