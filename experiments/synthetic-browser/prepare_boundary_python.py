"""API-only fixture dependencies, selected from the exact project's locked runtime."""
from pathlib import Path
import re
import subprocess
import sys

root, environment = map(Path, sys.argv[1:])
if not root.is_absolute() or not environment.is_absolute():
    raise ValueError("Absolute backend and isolated environment paths are required")
pin = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
if pin != "5a1bfc38e207913c66eb6120e986147a66410424":
    raise ValueError("Unexpected backend pin")
subprocess.run([sys.executable, "-m", "venv", str(environment)], check=True)
python = environment / "bin/python"
probe = subprocess.run([str(python), "-c", "import fastapi,uvicorn,pydantic,pydantic_settings"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
if probe.returncode:
    if b"ModuleNotFoundError" not in probe.stderr:
        raise RuntimeError("Fixture dependency probe failed for a reason other than missing packages")
    lock = (root / "requirements-production-amd64.txt").read_text()
    packages = []
    for name in ("fastapi", "uvicorn", "pydantic", "pydantic-settings", "python-dotenv"):
        match = re.search(r"^" + re.escape(name) + r"==([^\s\\]+)", lock, re.MULTILINE)
        if not match:
            raise ValueError("Necessary API fixture dependency is missing from the project lock")
        packages.append(name + "==" + match.group(1))
    subprocess.run([str(python), "-m", "pip", "install", "--quiet", *packages], check=True)
subprocess.run([str(python), "-c", "import fastapi,uvicorn,pydantic,pydantic_settings"], check=True)
