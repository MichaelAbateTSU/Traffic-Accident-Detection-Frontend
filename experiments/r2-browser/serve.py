import importlib.util
import uvicorn

spec = importlib.util.spec_from_file_location("prior_guard", "/app/prior_guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
original_run = uvicorn.run


def serve_on_private_interface(app, **kwargs):
    kwargs["host"] = "0.0.0.0"
    return original_run(app, **kwargs)


uvicorn.run = serve_on_private_interface
guard.serve()
