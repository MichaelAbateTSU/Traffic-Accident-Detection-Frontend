"""One test-only enqueue rejection after durable reservation and a real WAL writer lock."""
import json
from pathlib import Path
import sqlite3
import threading
import time


def install_admission_failure_fault(store, queue_class, database_path, control_directory,
                                    *, maximum_hold_seconds=90):
    if not 0 < maximum_hold_seconds <= 90:
        raise ValueError("Admission fault hold must be bounded to at most 90 seconds")
    control = Path(control_directory)
    control.mkdir(mode=0o700, parents=True, exist_ok=False)
    state_path = control / "state.json"
    release_path = control / "release"
    original_submit = queue_class.submit
    guard = threading.Lock()
    used = False
    state = {"fault_count": 0, "writer_locked": False, "released": False}
    threads = []

    def write_state():
        temporary = control / "state.next"
        temporary.write_text(json.dumps(state))
        temporary.replace(state_path)

    write_state()

    def submit(queue, job_id, *args):
        nonlocal used
        with guard:
            if used:
                return original_submit(queue, job_id, *args)
            used = True
        ready = threading.Event()
        outcome = {}

        def hold_writer():
            try:
                with sqlite3.connect(database_path, timeout=0.25) as writer:
                    writer.execute("BEGIN IMMEDIATE")
                    row = writer.execute("SELECT payload FROM jobs WHERE id = ?", (job_id,)).fetchone()
                    if row is None or json.loads(row[0])["status"] != "pending":
                        raise AssertionError("Fault requires a durably reserved pending job")
                    receipt_count = writer.execute(
                        "SELECT count(*) FROM submission_receipts WHERE job_id = ?", (job_id,),
                    ).fetchone()[0]
                    if receipt_count != 1 or store.get(job_id).status != "pending":
                        raise AssertionError("Fault requires one durable keyed receipt")
                    state.update(job_id=job_id, persisted_status="pending",
                                 receipt_count=receipt_count, fault_count=1, writer_locked=True)
                    write_state()
                    ready.set()
                    deadline = time.monotonic() + maximum_hold_seconds
                    while not release_path.exists() and time.monotonic() < deadline:
                        time.sleep(0.025)
                    state["release_requested"] = release_path.exists()
                    writer.rollback()
                    state.update(writer_locked=False, released=True)
                    write_state()
            except Exception as error:
                outcome["error"] = error
                state["fixture_error"] = type(error).__name__
                write_state()
                ready.set()

        thread = threading.Thread(target=hold_writer, name="synthetic-sqlite-writer", daemon=True)
        threads.append(thread)
        thread.start()
        if not ready.wait(3):
            release_path.touch()
            raise AssertionError("Admission fixture writer did not become ready")
        if "error" in outcome:
            raise AssertionError("Admission fixture could not establish the writer lock") from outcome["error"]
        # The unchanged route catches this and calls the unchanged durable fail_job().
        raise RuntimeError("Test-only executor admission rejection")

    queue_class.submit = submit

    def cleanup():
        release_path.touch()
        for thread in threads:
            thread.join(timeout=4)
            if thread.is_alive():
                raise AssertionError("Admission fixture writer did not stop")
        queue_class.submit = original_submit
        if "fixture_error" in state:
            raise AssertionError("Admission fixture failed: " + state["fixture_error"])

    return cleanup
