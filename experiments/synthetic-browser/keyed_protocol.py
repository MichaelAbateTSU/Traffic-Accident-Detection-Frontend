"""Exact production keyed protocol checks; retain only temporary nonsecret receipts."""
import http.client
import json
import os
import socket
import ssl
import sys
import time
import threading
import uuid
from pathlib import Path

SOURCE = "https://media.githubusercontent.com/media/accidentbench/accidentbench.github.io/main/assets/videos/synthetic/Town03_head-on_clear_30.mp4"
BODY = {"stream_url": SOURCE, "max_frames": 12, "save_frames": True}
phase = sys.argv[1] if len(sys.argv) > 1 else "initial"
stage = "initialization"
token = os.environ["API_TOKEN"]
context = ssl.create_default_context(cafile=os.environ["TEST_CA_PATH"])


class Connection(http.client.HTTPSConnection):
    def connect(self):
        raw = socket.create_connection(("127.0.0.1", 8453), timeout=10)
        self.sock = context.wrap_socket(raw, server_hostname="api.integration.test")


def request(method, path, key=None, body=None, authorization=token, discard=False):
    connection = Connection("api.integration.test", 8453, context=context, timeout=10)
    headers = {"Authorization": "Bearer " + authorization,
               "Origin": "https://frontend.integration.test:8454"}
    if key:
        headers["Idempotency-Key"] = key
    if body is not None:
        headers["Content-Type"] = "application/json"
    try:
        connection.request(method, path, json.dumps(body) if body is not None else None, headers)
        response = connection.getresponse()
        assert response.getheader("Access-Control-Allow-Origin") == headers["Origin"]
        status = response.status
        if discard:
            # Admission headers arrived, but the client deliberately loses the receipt body.
            connection.close()
            return status, None
        return status, json.loads(response.read())
    finally:
        connection.close()


def lose_entire_response(key):
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    listener.settimeout(15)
    port = listener.getsockname()[1]
    evidence = {}

    def boundary():
        try:
            with listener.accept()[0] as downstream:
                downstream.settimeout(10)
                # Forward the real client body/auth to production HTTPS, but no response bytes.
                upstream = Connection("api.integration.test", 8453, context=context, timeout=10)
                upstream.connect()
                pending = b""
                while b"\r\n\r\n" not in pending:
                    pending += downstream.recv(4096)
                    assert len(pending) < 16384
                headers, body = pending.split(b"\r\n\r\n", 1)
                length = int(next(line.split(b":", 1)[1] for line in headers.split(b"\r\n") if line.lower().startswith(b"content-length:")))
                while len(body) < length:
                    body += downstream.recv(length - len(body))
                upstream.sock.sendall(headers + b"\r\n\r\n" + body)
                response = http.client.HTTPResponse(upstream.sock)
                response.begin()
                assert response.status == 202
                receipt = json.loads(response.read())
                assert receipt["replayed"] is False
                evidence["job_id"] = receipt["job_id"]
                # Confirm durable admission via the real key-only endpoint before disconnect.
                status, found = request("GET", "/detection-submissions/v1", key)
                assert status == 200 and found["job_id"] == receipt["job_id"]
                evidence["admitted"] = True
                upstream.close()
        except Exception as error:
            evidence["error"] = type(error).__name__
        finally:
            listener.close()

    worker = threading.Thread(target=boundary)
    worker.start()
    client = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        client.request("POST", "/detection-submissions/v1", json.dumps(BODY), {
            "Host": "api.integration.test:8453", "Authorization": "Bearer " + token,
            "Origin": "https://frontend.integration.test:8454",
            "Content-Type": "application/json", "Idempotency-Key": key,
        })
        try:
            client.getresponse()
        except http.client.RemoteDisconnected:
            evidence["client_no_status"] = True
        else:
            raise AssertionError("Lost-response client unexpectedly received headers")
    finally:
        client.close()
        worker.join(timeout=20)
    assert not worker.is_alive() and "error" not in evidence
    assert evidence["admitted"] and evidence["client_no_status"]
    return evidence["job_id"]


try:
    result_file = Path(os.environ["RESULT_FILE"])
    if phase == "initial":
        key = f"v1.{int(time.time())}.{uuid.uuid4()}"
        expired_key = f"v1.{int(time.time()) - 90000}.{uuid.uuid4()}"
        stage = "bad_auth"
        assert request("GET", "/detection-submissions/v1", key, authorization="invalid-test-token")[0] == 401
        stage = "unknown_key_only"
        status, payload = request("GET", "/detection-submissions/v1", key)
        assert status == 404 and payload["detail"]["code"] == "idempotency_key_unknown"
        stage = "lost_admission_response"
        admitted_job_id = lose_entire_response(key)
        stage = "key_only_reconciliation"
        status, receipt = request("GET", "/detection-submissions/v1", key)
        assert status == 200 and receipt["replayed"] is True
        job_id = receipt["job_id"]
        assert job_id == admitted_job_id
        stage = "identical_retry"
        status, retry = request("POST", "/detection-submissions/v1", key, BODY)
        assert status == 200 and retry["replayed"] and retry["job_id"] == job_id
        stage = "differing_body"
        status, conflict = request("POST", "/detection-submissions/v1", key, BODY | {"max_frames": 11})
        assert status == 409 and conflict["detail"]["code"] == "idempotency_key_conflict"
        stage = "expired_key"
        for method, body in [("GET", None), ("POST", BODY)]:
            status, expired = request(method, "/detection-submissions/v1", expired_key, body)
            assert status == 410 and expired["detail"]["code"] == "idempotency_key_expired"
    else:
        saved = json.loads(result_file.read_text())
        key, job_id = saved["key"], saved["job"]["job_id"]
        stage = "restart_receipt_recovery"
        status, receipt = request("GET", "/detection-submissions/v1", key)
        assert status == 200 and receipt["replayed"] and receipt["job_id"] == job_id
        status, retry = request("POST", "/detection-submissions/v1", key, BODY)
        assert status == 200 and retry["replayed"] and retry["job_id"] == job_id
    stage = "terminal_real_inference"
    deadline = time.monotonic() + 120
    while True:
        status, job = request("GET", "/jobs/" + job_id)
        assert status == 200
        if job["status"] in ("complete", "failed"):
            break
        assert time.monotonic() < deadline
        time.sleep(0.5)
    assert job["status"] == "complete" and job["frames_processed"] == 12 and len(job["frames"]) == 12
    status, listing = request("GET", "/jobs")
    assert status == 200 and len(listing["data"]) == 1 and listing["data"][0]["job_id"] == job_id
    if phase == "initial":
        result_file.write_text(json.dumps({"key": key, "job": job}))
    else:
        assert job == saved["job"]
    print(json.dumps({
        "phase": phase, "job_status": job["status"], "frames_processed": job["frames_processed"],
        "peak_heuristic_score": job["peak_confidence"], "event_count": len(job["events"]),
        "job_count": 1, "job_id_stable": True, "bad_auth_rejected": phase == "initial",
        "key_only_unknown_404": phase == "initial", "client_received_no_status_headers_or_body": phase == "initial",
        "boundary_confirmed_durable_admission_before_disconnect": phase == "initial",
        "same_key_retry_replayed": True, "differing_body_conflict_409": phase == "initial",
        "expired_get_post_410": phase == "initial", "result_identical_after_restart": phase == "recovery",
        "temporary_ca_https_verified": True, "real_camera_hosts_contacted": 0,
    }))
except Exception as error:
    print(json.dumps({"phase": phase, "status": "protocol_check_failed", "stage": stage, "error_type": type(error).__name__}))
    sys.exit(1)
