"""Synthetic-only saved-frame experiment; media is temporary and never uploaded."""
import json
import os
from pathlib import Path
import resource
import secrets
import shutil
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
SOURCE = "https://media.githubusercontent.com/media/accidentbench/accidentbench.github.io/main/assets/videos/synthetic/Town03_head-on_clear_30.mp4"
BACKEND = "21cb418e673fc944bbe2ca41bddf6d11b04c4b63"
FRONTEND = "3549bcf1f2cccaac95acfdcb865e9a2d87e2d9dd"
CADDY = "caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d"
environment = os.environ.copy()
environment["API_TOKEN"] = secrets.token_urlsafe(48)
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
stage = "initialization"
browser = None


def command(*args, capture=False, check=True, timeout=30):
    return subprocess.run(
        args, env=environment, check=check, timeout=timeout, text=True,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def docker(*args, **kwargs):
    return command("docker", *args, **kwargs)


def container_json(script):
    result = docker("exec", "r2-browser-api", "python", "-c", script, capture=True)
    return json.loads(result.stdout)


try:
    assert not command("swapon", "--noheadings", "--show", capture=True).stdout.strip(), "Swap must be disabled"
    with tempfile.TemporaryDirectory(prefix="r2-browser-", dir="/dev/shm", ignore_cleanup_errors=True) as temporary:
        temp = Path(temporary)
        environment["RESULT_FILE"] = str(temp / "result.json")
        stage = "temporary_https_setup"
        command("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                "-keyout", str(temp / "server.key"), "-out", str(temp / "server.crt"),
                "-days", "1", "-subj", "/CN=api.integration.test",
                "-addext", "subjectAltName=DNS:api.integration.test,DNS:frontend.integration.test")
        (temp / "Caddyfile").write_text("""{
  admin off
  auto_https off
}
https://api.integration.test:8453 {
  tls /certs/server.crt /certs/server.key
  reverse_proxy r2-browser-api:8000
}
https://frontend.integration.test:8454 {
  tls /certs/server.crt /certs/server.key
  root * /frontend
  try_files {path} /index.html
  file_server
}
""")
        stage = "isolated_production_start"
        docker("network", "create", "--internal", "--subnet", "172.29.68.0/24", "r2-browser-private")
        docker("network", "create", "r2-browser-internet")
        docker("create", "--name", "r2-browser-egress", "--network", "r2-browser-private",
               "--ip", "172.29.68.4", "--read-only", "--cap-drop", "ALL",
               "--security-opt", "no-new-privileges", "--cpus", "0.25",
               "--memory", "128m", "--memory-swap", "128m", "--pids-limit", "32",
               "--ulimit", "core=0", "--log-driver", "none",
               "--tmpfs", "/metrics:size=1m,mode=1777",
               "--mount", f"type=bind,source={Path.cwd() / 'backend/deploy/egress_proxy.py'},target=/app/egress_proxy.py,readonly",
               "--mount", f"type=bind,source={ROOT / 'proxy.py'},target=/app/proxy.py,readonly",
               "-e", "STREAM_HOSTS=media.githubusercontent.com",
               "-e", "JOB_TIMEOUT_SECONDS=120", "traffic-live-egress", "python", "/app/proxy.py")
        docker("network", "connect", "r2-browser-internet", "r2-browser-egress")
        docker("start", "r2-browser-egress")
        docker("volume", "create", "synthetic-browser-data")
        docker("run", "--rm", "--network", "none", "--user", "0",
               "-v", "synthetic-browser-data:/data", "traffic-live-smoke",
               "chown", "10001:10001", "/data")
        docker("run", "-d", "--name", "r2-browser-api", "--network", "r2-browser-private",
               "--ip", "172.29.68.2", "--add-host", "egress:172.29.68.4", "--read-only",
               "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--cpus", "2",
               "--memory", "4g", "--memory-swap", "4g", "--pids-limit", "128",
               "--ulimit", "core=0", "--log-driver", "none", "--no-healthcheck",
               "-v", "synthetic-browser-data:/data",
               "--tmpfs", "/tmp:size=256m,mode=1777",
               "--mount", f"type=bind,source={ROOT / 'serve.py'},target=/app/browser_serve.py,readonly",
               "-e", "API_TOKEN", "-e", "ENVIRONMENT=production",
               "-e", "CORS_ORIGINS=https://frontend.integration.test:8454",
               "-e", "APPROVED_STREAM_URLS=" + json.dumps([SOURCE]),
               "-e", "JOB_DATABASE_PATH=/data/jobs.sqlite3", "-e", "OUTPUT_DIR=/data/artifacts",
               "-e", "MAX_CONCURRENT_JOBS=1", "-e", "JOB_ARTIFACT_RETENTION_COUNT=9",
               "-e", "EXPERIMENTAL_SCORER_SOURCE_FPS=",
               "-e", "JOB_TIMEOUT_SECONDS=120", "-e", "INFERENCE_THREADS=2",
               "-e", "DEEPSORT_EMBEDDER_BATCH_SIZE=1",
               "-e", "http_proxy=http://egress:3128", "-e", "https_proxy=http://egress:3128",
               "-e", "no_proxy=127.0.0.1,localhost", "traffic-live-smoke",
               "python", "browser_serve.py")
        docker("create", "--name", "r2-browser-https", "--network", "r2-browser-private",
               "--ip", "172.29.68.3",
               "-p", "127.0.0.1:8453:8453", "-p", "127.0.0.1:8454:8454",
               "--user", f"{os.getuid()}:{os.getgid()}",
               "--read-only", "--cap-drop", "ALL", "--cap-add", "NET_BIND_SERVICE",
               "--security-opt", "no-new-privileges",
               "--memory", "128m", "--memory-swap", "128m", "--pids-limit", "64",
               "--log-driver", "none", "--ulimit", "core=0",
               "--tmpfs", "/data:size=4m,mode=1777", "--tmpfs", "/config:size=4m,mode=1777",
               "--mount", f"type=bind,source={temp},target=/certs,readonly",
               "--mount", f"type=bind,source={temp / 'Caddyfile'},target=/etc/caddy/Caddyfile,readonly",
               "--mount", f"type=bind,source={Path.cwd() / 'frontend/dist'},target=/frontend,readonly",
               CADDY)
        docker("network", "connect", "r2-browser-internet", "r2-browser-https")
        docker("start", "r2-browser-https")
        state = json.loads(docker("inspect", "r2-browser-api", capture=True).stdout)[0]
        assert state["HostConfig"]["ReadonlyRootfs"]
        assert state["HostConfig"]["LogConfig"]["Type"] == "none"
        assert not state["HostConfig"]["PortBindings"]
        assert set(state["NetworkSettings"]["Networks"]) == {"r2-browser-private"}
        assert json.loads(docker("network", "inspect", "r2-browser-private", capture=True).stdout)[0]["Internal"]
        stage = "production_health"
        for attempt in range(60):
            probe = docker("exec", "r2-browser-api", "python", "-c",
                           "import urllib.request,json; print(json.load(urllib.request.urlopen('http://127.0.0.1:8000/health'))['model_loaded'])",
                           capture=True, check=False)
            if probe.stdout.strip() == "True":
                break
            time.sleep(1)
        else:
            raise RuntimeError("Production model startup blocked")
        stage = "trusted_test_https_health"
        https_health = command(
            "curl", "--noproxy", "*", "--fail", "--silent",
            "--connect-timeout", "3", "--max-time", "5",
            "--cacert", str(temp / "server.crt"),
            "--resolve", "api.integration.test:8453:127.0.0.1",
            "https://api.integration.test:8453/health", capture=True,
        )
        assert json.loads(https_health.stdout)["model_loaded"]
        print(json.dumps({"temporary_ca_https_health_verified": True}), flush=True)
        stage = "source_hash_through_production_proxy"
        source_check = container_json("""
import hashlib,json,socket,urllib.request
source='https://media.githubusercontent.com/media/accidentbench/accidentbench.github.io/main/assets/videos/synthetic/Town03_head-on_clear_30.mp4'
try:
    connection=socket.create_connection(('1.1.1.1',443),timeout=2)
except OSError:
    pass
else:
    connection.close()
    raise AssertionError('Direct API egress unexpectedly allowed')
opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':'http://egress:3128'}))
digest=hashlib.sha256(); count=0
with opener.open(source,timeout=20) as response:
    assert response.geturl()==source
    while True:
        chunk=response.read(65536)
        if not chunk: break
        digest.update(chunk); count+=len(chunk)
        assert count<10000000
assert digest.hexdigest()=='6a81466e01f812d70789916d055688bcd98dd230e8b24718d8312236220c3831'
print(json.dumps({'source_sha256':digest.hexdigest(),'source_bytes':count,'direct_api_egress_blocked':True}))
""")
        print(json.dumps(source_check), flush=True)
        stage = "actual_browser"
        browser = subprocess.Popen([
            "/opt/google/chrome/chrome", "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
            "--disable-gpu", "--no-proxy-server", "--ignore-certificate-errors",
            "--disable-background-networking", "--disable-breakpad", "--disable-crash-reporter",
            "--no-first-run", "--no-default-browser-check",
            "--disk-cache-size=0", "--media-cache-size=0",
            "--host-resolver-rules=MAP frontend.integration.test 127.0.0.1, MAP api.integration.test 127.0.0.1",
            "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9225",
            f"--user-data-dir={temp / 'chrome-profile'}", "about:blank",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=environment)
        for attempt in range(120):
            readiness = command(
                "curl", "--noproxy", "*", "--fail", "--silent", "--max-time", "1", "http://127.0.0.1:9225/json/version",
                check=False, capture=True,
            )
            if readiness.returncode == 0:
                break
            time.sleep(0.2)
        else:
            os.set_blocking(browser.stderr.fileno(), False)
            diagnostic = (browser.stderr.read(65536) or b"").decode(errors="replace")
            categories = {
                "disk_full": "No space left on device",
                "sandbox_unavailable": "No usable sandbox",
                "permission_denied": "Permission denied",
                "namespace_failure": "Failed to move to new namespace",
                "root_sandbox": "Running as root without --no-sandbox",
            }
            print(json.dumps({
                "chrome_startup_exit_code": browser.poll(),
                "devtools_probe_exit_code": readiness.returncode,
                "startup_failure_categories": [key for key, phrase in categories.items() if phrase in diagnostic],
                "ram_temp_free_bytes": shutil.disk_usage(temp).free,
            }), flush=True)
            raise RuntimeError("Chrome debugging endpoint unavailable")
        result = command(
            shutil.which("node"), str(ROOT / "browser.mjs"), capture=True, check=False, timeout=240,
        )
        safe = json.loads(result.stdout)
        print(json.dumps(safe | {
            "frontend_revision": FRONTEND, "backend_revision": BACKEND,
            "experiment_revision": os.environ["EXPERIMENT_REVISION"],
            "browser_test_certificate_errors_ignored": True,
            "public_deployment": False, "source": "ACCIDENT Town03_head-on_clear_30 synthetic, CC BY-NC-SA 4.0",
            "scorer_mode": "legacy",
        }), flush=True)
        stage = "genuine_execution_inventory"
        inventory = container_json("""
import json
from pathlib import Path
counts=json.loads(Path('/data/inference-counts.json').read_text())
artifact_files=sum(p.is_file() for p in Path('/data/artifacts').rglob('*'))
from app.core.config import settings
assert settings.experimental_scorer_source_fps is None
assert artifact_files==36
print(json.dumps({'temporary_artifact_files':artifact_files,**counts}))
""")
        print(json.dumps(inventory), flush=True)
        if safe.get("job_status") == "complete":
            for key in ["yolo_calls", "tracker_calls", "scorer_calls"]:
                assert inventory[key] == 12
        if result.returncode:
            raise RuntimeError("Browser synthetic smoke did not complete")
        proxy_counts = json.loads(docker(
            "exec", "r2-browser-egress", "cat", "/metrics/counts.json", capture=True,
        ).stdout)
        assert proxy_counts["successful_connections"] >= 2
        print(json.dumps({"normal_proxy_successful_connections": proxy_counts["successful_connections"]}), flush=True)
        stage = "durable_volume_restart"
        docker("restart", "r2-browser-api")
        for attempt in range(60):
            readiness = command("curl", "--noproxy", "*", "--fail", "--silent",
                                "--cacert", str(temp / "server.crt"),
                                "--resolve", "api.integration.test:8453:127.0.0.1",
                                "https://api.integration.test:8453/health", capture=True, check=False)
            if readiness.returncode==0 and json.loads(readiness.stdout)["model_loaded"]:
                break
            time.sleep(1)
        else:
            raise RuntimeError("Restart health failed")
        recovery = command(shutil.which("node"), str(ROOT / "browser.mjs"), "recovery",
                           capture=True, check=False, timeout=120)
        print(json.dumps(json.loads(recovery.stdout)), flush=True)
        assert recovery.returncode==0
except Exception as error:
    evidence = {"status": "bounded_experiment_blocked", "stage": stage, "error_type": type(error).__name__}
    if isinstance(error, subprocess.CalledProcessError):
        evidence["command_exit_code"] = error.returncode
    print(json.dumps(evidence), flush=True)
    raise SystemExit(1)
finally:
    if browser:
        browser.terminate()
        try:
            browser.wait(timeout=10)
        except subprocess.TimeoutExpired:
            browser.kill()
            browser.wait(timeout=5)
    docker("rm", "-f", "-v", "r2-browser-https", "r2-browser-api", "r2-browser-egress", check=False)
    docker("network", "rm", "r2-browser-private", "r2-browser-internet", check=False)
    docker("volume", "rm", "synthetic-browser-data", check=False)
    if "temp" in globals() and temp.exists():
        shutil.rmtree(temp)
    assert not docker("ps", "-a", "--filter", "name=r2-browser-", "--format", "{{.Names}}", capture=True).stdout.strip()
    assert not docker("volume", "ls", "--filter", "name=synthetic-browser-data", "--format", "{{.Name}}", capture=True).stdout.strip()
    print(json.dumps({"temporary_services_removed": True, "temporary_media_volume_destroyed": True}), flush=True)
