import json
from pathlib import Path
import tempfile
import unittest
from inference_inventory import InferenceInventory


class DurableInventoryTest(unittest.TestCase):
    def test_restart_and_second_twelve_frame_execution_cannot_hide(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "counts.json"
            first = InferenceInventory(path)
            first.begin()
            for _ in range(12):
                for field in ("yolo_calls", "tracker_calls", "scorer_calls"):
                    first.increment(field)
            first.finish()
            baseline = json.loads(path.read_text())
            restarted = InferenceInventory(path)
            self.assertEqual(json.loads(path.read_text()), baseline)
            restarted.begin()
            entered = json.loads(path.read_text())
            self.assertEqual(entered["yolo_calls"], 12)
            self.assertEqual(entered["inference_invocations"], 2)
            self.assertEqual(entered["in_progress"], 1)
            self.assertNotEqual(entered, baseline)
            for _ in range(12):
                for field in ("yolo_calls", "tracker_calls", "scorer_calls"):
                    restarted.increment(field)
            restarted.finish()
            completed = json.loads(path.read_text())
            # Old process-local accounting would report 12 again and pass.
            self.assertEqual(12, baseline["yolo_calls"])
            self.assertEqual(completed["yolo_calls"], 24)
            self.assertEqual(completed["tracker_calls"], 24)
            self.assertEqual(completed["scorer_calls"], 24)
            self.assertEqual(completed["inference_invocations"], 2)
            self.assertEqual(completed["finished_invocations"], 2)
            self.assertEqual(completed["in_progress"], 0)

    def test_in_progress_genuine_call_is_persisted_before_result(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "counts.json"
            inventory = InferenceInventory(path)
            inventory.begin()
            inventory.increment("yolo_calls")
            progress = json.loads(path.read_text())
            self.assertEqual(progress["inference_invocations"], 1)
            self.assertEqual(progress["yolo_calls"], 1)
            self.assertEqual(progress["finished_invocations"], 0)
            self.assertEqual(progress["in_progress"], 1)


if __name__ == "__main__":
    unittest.main()
