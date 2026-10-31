"""Fixture-only tests: real SQLite locks, not backend/browser integration evidence."""
import json
from pathlib import Path
import sqlite3
import tempfile
import time
from types import SimpleNamespace
import unittest

from admission_failure_fault import install_admission_failure_fault


class AdmissionFaultTest(unittest.TestCase):
    def test_real_writer_blocks_terminal_write_then_releases(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / "jobs.sqlite3"
            connection = sqlite3.connect(database, timeout=0)
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("CREATE TABLE jobs (id TEXT PRIMARY KEY, payload TEXT)")
            connection.execute("CREATE TABLE submission_receipts (job_id TEXT)")
            connection.execute("INSERT INTO jobs VALUES (?, ?)", ("original", '{"status":"pending"}'))
            connection.execute("INSERT INTO submission_receipts VALUES ('original')")
            connection.commit()
            calls = []

            class Queue:
                def submit(self, job_id, *args):
                    calls.append(job_id)

            store = SimpleNamespace(get=lambda job_id: SimpleNamespace(status="pending"))
            control = root / "control"
            cleanup = install_admission_failure_fault(store, Queue, str(database), control)
            try:
                with self.assertRaisesRegex(RuntimeError, "admission rejection"):
                    Queue().submit("original")
                state = json.loads((control / "state.json").read_text())
                self.assertTrue(state["writer_locked"])
                self.assertEqual(state["receipt_count"], 1)
                with self.assertRaises(sqlite3.OperationalError):
                    connection.execute("UPDATE jobs SET payload = ?", ('{"status":"failed"}',))
                connection.rollback()
                self.assertEqual(json.loads(connection.execute("SELECT payload FROM jobs").fetchone()[0]),
                                 {"status": "pending"})
                Queue().submit("later")
                self.assertEqual(calls, ["later"])
            finally:
                cleanup()
            self.assertTrue(json.loads((control / "state.json").read_text())["released"])
            connection.execute("UPDATE jobs SET payload = ?", ('{"status":"failed"}',))
            connection.commit()
            self.assertEqual(json.loads(connection.execute("SELECT payload FROM jobs").fetchone()[0]),
                             {"status": "failed"})
            connection.close()

    def test_invalid_bound_rejected(self):
        with self.assertRaises(ValueError):
            install_admission_failure_fault(None, None, "", "", maximum_hold_seconds=91)

    def test_writer_releases_at_bound_without_control_command(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / "jobs.sqlite3"
            with sqlite3.connect(database) as connection:
                connection.execute("PRAGMA journal_mode=WAL")
                connection.execute("CREATE TABLE jobs (id TEXT PRIMARY KEY, payload TEXT)")
                connection.execute("CREATE TABLE submission_receipts (job_id TEXT)")
                connection.execute("INSERT INTO jobs VALUES ('original', '{\"status\":\"pending\"}')")
                connection.execute("INSERT INTO submission_receipts VALUES ('original')")

            class Queue:
                def submit(self, job_id, *args):
                    raise AssertionError("Rejected job must not reach executor")

            control = root / "control"
            cleanup = install_admission_failure_fault(
                SimpleNamespace(get=lambda job_id: SimpleNamespace(status="pending")),
                Queue, str(database), control, maximum_hold_seconds=0.05,
            )
            try:
                with self.assertRaisesRegex(RuntimeError, "admission rejection"):
                    Queue().submit("original")
                deadline = time.monotonic() + 2
                while not json.loads((control / "state.json").read_text())["released"]:
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(0.025)
                self.assertFalse(json.loads((control / "state.json").read_text())["release_requested"])
            finally:
                cleanup()


if __name__ == "__main__":
    unittest.main()
