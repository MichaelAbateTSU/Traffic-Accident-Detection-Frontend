import importlib.util

spec = importlib.util.spec_from_file_location("prior_guard", "/app/prior_guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
guard.serve()
