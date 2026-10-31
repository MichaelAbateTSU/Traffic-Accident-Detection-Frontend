"""Count successful connections without changing public-IP validation or tunneling."""
import json
import os
from pathlib import Path
import threading
import egress_proxy

lock = threading.Lock()
count = 0
original = egress_proxy.connect_public


def measured_connect(*args, **kwargs):
    global count
    connection = original(*args, **kwargs)
    with lock:
        count += 1
        Path("/metrics/counts.json").write_text(json.dumps({"successful_connections": count}))
    return connection


egress_proxy.connect_public = measured_connect
hosts = {h.strip().lower() for h in os.environ["STREAM_HOSTS"].split(",") if h.strip()}
with egress_proxy.ProxyServer(("0.0.0.0", 3128), hosts, job_timeout_seconds=120) as server:
    server.serve_forever()
