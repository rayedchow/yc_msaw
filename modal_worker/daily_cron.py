"""Daily procedural-memory build scheduler.

The parent MCP (hosted on Manufact) owns the build harness. This tiny Modal
app is the product's scheduler: once per day (UTC) it calls the parent's
authenticated build endpoint for each configured tenant and waits for the
receipt. It never sees model keys, traces, or memory content — only the
per-tenant build trigger tokens (scope memory:build) in a Modal Secret.

Setup (host/operator):
  modal secret create procmem-daily-trigger \
      PROCMEM_PARENT_URL=https://<slug>.run.mcp-use.com \
      PROCMEM_BUILD_TOKENS=<token-tenant-a>,<token-tenant-b>
  modal deploy modal_worker/daily_cron.py
Manual run of the same function (demo / catch-up):
  modal run modal_worker/daily_cron.py::trigger_daily --day 2026-10-17
"""

import datetime as dt
import json
import os
import time
import urllib.error
import urllib.request

import modal

app = modal.App("procmem-daily")
image = modal.Image.debian_slim(python_version="3.12")
secret = modal.Secret.from_name("procmem-daily-trigger", required_keys=["PROCMEM_PARENT_URL", "PROCMEM_BUILD_TOKENS"])

POLL_SECONDS = 15
MAX_WAIT_SECONDS = 50 * 60
# Catch-up drains missed days (oldest first, <= yesterday) one build at a time.
MAX_CATCHUP_BUILDS = 10


def _request(method: str, url: str, token: str, body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read(1_000_000) or b"{}")
    except urllib.error.HTTPError as err:
        payload = err.read(100_000)
        try:
            return err.code, json.loads(payload or b"{}")
        except json.JSONDecodeError:
            return err.code, {"error": payload.decode(errors="replace")[:500]}


def _run_once(base: str, token: str, day: str) -> dict:
    status, started = _request("POST", f"{base}/v1/builds/daily", token, {"day": day, "catchup": True})
    if status not in (200, 202):
        return {"day": day, "status": "trigger_failed", "http": status, "detail": started}
    build_id = started.get("buildId")
    if not build_id:
        # Nothing to build (no new traces) is a valid, explicit outcome.
        return {"day": day, **started}
    deadline = time.time() + MAX_WAIT_SECONDS
    while time.time() < deadline:
        status, receipt = _request("GET", f"{base}/v1/builds/{build_id}", token)
        if status == 200 and receipt.get("status") not in ("queued", "running"):
            return {"day": started.get("day"), "buildId": build_id, "status": receipt.get("status"), "revisionId": receipt.get("revisionId"), "error": receipt.get("error"), "remainingDays": started.get("remainingDays", [])}
        time.sleep(POLL_SECONDS)
    return {"day": started.get("day"), "buildId": build_id, "status": "still_running_at_scheduler_deadline"}


def _run_for_tenant(base: str, token: str, day: str) -> list[dict]:
    results = []
    for _ in range(MAX_CATCHUP_BUILDS):
        result = _run_once(base, token, day)
        results.append(result)
        # Stop on nothing left, a failure/lease conflict (next run retries), or no further backlog.
        if not result.get("buildId") or result.get("status") not in ("published", "no_change") or not result.get("remainingDays"):
            break
    return results


@app.function(image=image, secrets=[secret], timeout=60 * 60, schedule=modal.Cron("20 0 * * *", timezone="UTC"))
def daily_build():
    """Build yesterday's (UTC) trace cohort for every configured tenant."""
    day = (dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=1)).isoformat()
    return trigger_daily.local(day)


@app.function(image=image, secrets=[secret], timeout=60 * 60)
def trigger_daily(day: str):
    dt.date.fromisoformat(day)  # validate
    base = os.environ["PROCMEM_PARENT_URL"].rstrip("/")
    tokens = [t.strip() for t in os.environ["PROCMEM_BUILD_TOKENS"].split(",") if t.strip()]
    results = [_run_for_tenant(base, token, day) for token in tokens]
    # Receipts carry no tokens; safe to log.
    print(json.dumps({"day": day, "results": results}))
    return results
