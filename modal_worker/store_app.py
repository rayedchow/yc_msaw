"""
Hosted ObjectStore authority on a Modal Volume (see src/store/objects.ts).

Semantics are those of DirectoryObjectStore, the reference implementation:
  - put: immutable create-once objects. Identical bytes for an existing key are
    a no-op; different bytes (on the volume, or for a duplicate key inside one
    batch) are an error. Keys under blobs/ must equal sha256(bytes).
  - get / list: read-only, always after volume.reload().
  - refs: small JSON records {version, value, updatedAt} changed only by
    compare-and-swap on a monotonically increasing version.

Layout (Volume "procmem-memory" mounted at /vol):
  /vol/<ns>/objects/<key>        immutable objects
  /vol/<ns>/refs/<name>.json     ref records
  /vol/<ns>/.tmp/                temp files (outside objects/, never listed)
  /vol/<ns>/.uploads/<id>/<n>    staged multipart parts (outside objects/)

Concurrency (the reason this file exists in its current form):
  Several containers can run at once (max_containers > 1, and during a
  redeploy old and new containers overlap). A Volume is last-commit-wins per
  file, so "reload -> compare -> write -> commit" alone is NOT a CAS. Every
  cas_ref therefore runs inside a cross-container lock held in the Modal Dict
  "procmem-locks":
    acquire  locks.put(key, {token, acquiredAt}, skip_if_exists=True)
             (Modal 1.5.1: atomic insert-if-absent, returns True only if this
             call created the entry), retried with jitter for LOCK_WAIT_S.
    body     volume.reload(); read ref; compare version; write temp + rename;
             volume.commit()  -- bounded well under the 120 s function timeout.
    release  delete the entry only if it still holds our token.
  There is NO stale-lock takeover: a lock is only ever removed by its owner, so
  two writers can never be inside the critical section together. If a holder
  crashes mid-section (container killed) the lock stays and later cas_ref calls
  fail closed with {"error": "ref_locked"}; callers treat that as retryable and
  an operator clears it after confirming no store_op is still running:
      modal app logs procmem-store            # confirm nothing is in flight
      python -c "import modal; d = modal.Dict.from_name('procmem-locks'); \
                 print(d.get('ref:<ns>:<name>')); d.pop('ref:<ns>:<name>')"
  (Dict entries also expire after 7 days of inactivity.) Release is
  get-then-pop because the Dict has no compare-and-delete; this is safe because
  nobody but the owner can remove or replace a held lock (the only exception is
  the manual operator clear above, which must not race a live holder).

  Create-once for non-blob objects uses the same Dict as a claim registry:
  before writing a key that is absent on the volume, the writer claims
  "obj:<ns>:<key>" -> sha256(bytes) with skip_if_exists=True. A concurrent
  writer with different bytes sees a different digest and gets an error
  instead of silently winning a last-commit race. Blobs need no claim (the key
  is the digest, so concurrent writers always write identical bytes). The
  volume stays the content authority; claims only arbitrate concurrent
  creation (an orphaned claim from a crashed writer rejects only *different*
  bytes for that key, i.e. it fails closed).

Invalid input is returned as {"error": "..."} rather than raised.

Deploy: modal deploy modal_worker/store_app.py
"""

import base64
import binascii
import hashlib
import json
import os
import random
import re
import secrets
import shutil
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import modal

APP_NAME = "procmem-store"
VOLUME_NAME = "procmem-memory"
LOCK_DICT_NAME = "procmem-locks"
MOUNT = "/vol"

# Same patterns as NS_RE / KEY_RE / REF_RE in src/store/objects.ts (used with fullmatch).
NS_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,79}")
KEY_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,127}(?:/[a-z0-9][a-z0-9._-]{0,127}){0,7}")
REF_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}(?:/[a-z0-9][a-z0-9._-]{0,63}){0,3}")
PREFIX_RE = re.compile(r"[a-z0-9._/-]{0,1200}")

MAX_CALL_BYTES = 16 * 1024 * 1024  # base64 characters accepted per put / upload_part call
MAX_OBJECT_BYTES = 32 * 1024 * 1024  # MAX_OBJECT_BYTES in src/store/objects.ts
MAX_PARTS = 64
UPLOAD_ID_RE = re.compile(r"[0-9a-f]{32}")
UPLOAD_TTL_S = 24 * 3600
MAX_RESPONSE_BYTES = 6 * 1024 * 1024  # raw bytes inlined per get; the rest comes back as "remaining"
INLINE_MAX_BYTES = 6 * 1024 * 1024  # larger objects are returned via get_range
MAX_RANGE_BYTES = 6 * 1024 * 1024
MAX_KEYS_PER_CALL = 2000
MAX_LIST = 10_000
MAX_REF_VALUE_BYTES = 256 * 1024
LOCK_WAIT_S = 10.0

app = modal.App(APP_NAME)
volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)
locks = modal.Dict.from_name(LOCK_DICT_NAME, create_if_missing=True)
image = modal.Image.debian_slim(python_version="3.12")


class StoreError(Exception):
    pass


class RefLocked(Exception):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _ns_dir(ns) -> str:
    if not isinstance(ns, str) or not NS_RE.fullmatch(ns):
        raise StoreError(f"Invalid namespace {json.dumps(ns)}")
    return os.path.join(MOUNT, ns)


def _check_key(key) -> str:
    if (
        not isinstance(key, str)
        or len(key) > 400
        or not KEY_RE.fullmatch(key)
        or any(s in (".", "..") or s.endswith(".tmp") for s in key.split("/"))
    ):
        raise StoreError(f"Invalid object key {json.dumps(key)}")
    return key


def _check_ref(name) -> str:
    if not isinstance(name, str) or not REF_RE.fullmatch(name) or any(s in (".", "..") for s in name.split("/")):
        raise StoreError(f"Invalid ref name {json.dumps(name)}")
    return name


def _obj_path(ns_dir: str, key: str) -> str:
    return os.path.join(ns_dir, "objects", *key.split("/"))


def _ref_path(ns_dir: str, name: str) -> str:
    return os.path.join(ns_dir, "refs", *name.split("/")) + ".json"


def _as_int(v):
    """JSON numbers may arrive as floats depending on the client encoder; accept integral ones."""
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def _read(path: str):
    try:
        with open(path, "rb") as f:
            return f.read()
    except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
        return None


def _atomic_write(ns_dir: str, path: str, data: bytes) -> None:
    """Temp file (outside objects/) + fsync + rename, so readers never observe partial content."""
    tmp_dir = os.path.join(ns_dir, ".tmp")
    os.makedirs(tmp_dir, exist_ok=True)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = os.path.join(tmp_dir, uuid.uuid4().hex)
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _read_ref(ns_dir: str, name: str):
    raw = _read(_ref_path(ns_dir, name))
    return json.loads(raw.decode("utf-8")) if raw is not None else None


# ---------------------------------------------------------------- ops


def _decode_b64(key: str, b64) -> bytes:
    try:
        return base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        raise StoreError(f"Invalid base64 for {key}")


def _create_objects(ns: str, ns_dir: str, batch: dict) -> dict:
    """Create-once write of validated {key: bytes}. Caller has already run volume.reload()."""
    # Check every object before writing any, so a conflicting batch writes nothing.
    to_write = []
    existing = 0
    for key, data in batch.items():
        current = _read(_obj_path(ns_dir, key))
        if current is None:
            to_write.append((key, data))
        elif current == data:
            existing += 1
        else:
            raise StoreError(f"Immutable object {key} already exists with different content")

    # Claim absent non-blob keys so a concurrent container cannot create them with other bytes.
    claims = [(key, hashlib.sha256(data).hexdigest()) for key, data in to_write if not key.startswith("blobs/")]

    def claim(item):
        key, digest = item
        ckey = f"obj:{ns}:{key}"
        if locks.put(ckey, digest, skip_if_exists=True):
            return None
        holder = locks.get(ckey)
        return None if holder == digest else key

    if claims:
        with ThreadPoolExecutor(max_workers=min(16, len(claims))) as pool:
            lost = [k for k in pool.map(claim, claims) if k is not None]
        if lost:
            raise StoreError(f"Immutable object {lost[0]} is being created concurrently with different content")

    for key, data in to_write:
        _atomic_write(ns_dir, _obj_path(ns_dir, key), data)
    if to_write:
        volume.commit()
    return {"created": len(to_write), "existing": existing}


def op_put(p: dict) -> dict:
    ns = p.get("ns")
    ns_dir = _ns_dir(ns)
    objects = p.get("objects")
    if not isinstance(objects, list) or len(objects) > MAX_KEYS_PER_CALL:
        raise StoreError(f"objects must be a list of at most {MAX_KEYS_PER_CALL} items")
    total = 0
    batch: dict = {}  # key -> bytes, deduplicated
    for o in objects:
        if not isinstance(o, dict) or not isinstance(o.get("b64"), str):
            raise StoreError("each object needs {key, b64}")
        total += len(o["b64"])
        if total > MAX_CALL_BYTES:
            raise StoreError(f"put payload exceeds {MAX_CALL_BYTES} bytes per call; use multipart upload")
        key = _check_key(o.get("key"))
        data = _decode_b64(key, o["b64"])
        if key.startswith("blobs/") and hashlib.sha256(data).hexdigest() != key[len("blobs/"):]:
            raise StoreError(f"Blob digest mismatch for {key}")
        prior = batch.get(key)
        if prior is not None and prior != data:
            raise StoreError(f"Conflicting duplicate key {key} in one batch")
        batch[key] = data
    volume.reload()
    return _create_objects(ns, ns_dir, batch)


# ------------------------------------------------ multipart upload
#
# Objects whose base64 exceeds one call are uploaded as parts staged under
# /vol/<ns>/.uploads/<upload_id>/<index> (outside objects/, so never listed or
# readable as objects). upload_commit assembles the parts, verifies the size
# and the whole-object sha256 (which for blobs/ must equal the key), then runs
# the same create-once path as put. Staged parts are deleted on commit success
# or failure, and by upload_abort; abandoned uploads (client died) are inert
# garbage and are swept after UPLOAD_TTL_S by later commits.


def _upload_dir(ns_dir: str, upload_id) -> str:
    if not isinstance(upload_id, str) or not UPLOAD_ID_RE.fullmatch(upload_id):
        raise StoreError("upload_id must be 32 lowercase hex characters")
    return os.path.join(ns_dir, ".uploads", upload_id)


def _remove_upload(path: str) -> bool:
    if not os.path.isdir(path):
        return False
    shutil.rmtree(path, ignore_errors=True)
    return True


def _sweep_uploads(ns_dir: str) -> int:
    root = os.path.join(ns_dir, ".uploads")
    swept = 0
    try:
        entries = list(os.scandir(root))
    except FileNotFoundError:
        return 0
    cutoff = time.time() - UPLOAD_TTL_S
    for e in entries:
        try:
            if e.is_dir() and e.stat().st_mtime < cutoff:
                shutil.rmtree(e.path, ignore_errors=True)
                swept += 1
        except OSError:
            pass
    return swept


def op_upload_part(p: dict) -> dict:
    ns_dir = _ns_dir(p.get("ns"))
    up = _upload_dir(ns_dir, p.get("upload_id"))
    index = _as_int(p.get("index"))
    if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < MAX_PARTS:
        raise StoreError(f"index must be an integer in [0, {MAX_PARTS})")
    b64 = p.get("b64")
    if not isinstance(b64, str) or len(b64) > MAX_CALL_BYTES:
        raise StoreError(f"part must be base64 of at most {MAX_CALL_BYTES} characters")
    data = _decode_b64(f"part {index}", b64)
    os.makedirs(up, exist_ok=True)
    _atomic_write(ns_dir, os.path.join(up, f"{index:04d}"), data)
    volume.commit()
    return {"index": index, "bytes": len(data)}


def op_upload_commit(p: dict) -> dict:
    ns = p.get("ns")
    ns_dir = _ns_dir(ns)
    up = _upload_dir(ns_dir, p.get("upload_id"))
    try:
        key = _check_key(p.get("key"))
        parts = _as_int(p.get("parts"))
        size = _as_int(p.get("size"))
        digest = p.get("sha256")
        if not isinstance(parts, int) or isinstance(parts, bool) or not 1 <= parts <= MAX_PARTS:
            raise StoreError(f"parts must be an integer in [1, {MAX_PARTS}]")
        if not isinstance(size, int) or isinstance(size, bool) or not 0 <= size <= MAX_OBJECT_BYTES:
            raise StoreError(f"size must be an integer in [0, {MAX_OBJECT_BYTES}]")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise StoreError("sha256 must be 64 lowercase hex characters")
        if key.startswith("blobs/") and digest != key[len("blobs/"):]:
            raise StoreError(f"Blob digest mismatch for {key}")
        volume.reload()
        chunks = []
        total = 0
        for i in range(parts):
            chunk = _read(os.path.join(up, f"{i:04d}"))
            if chunk is None:
                raise StoreError(f"upload is missing part {i}")
            total += len(chunk)
            if total > size:
                raise StoreError("assembled upload is larger than declared size")
            chunks.append(chunk)
        data = b"".join(chunks)
        if len(data) != size:
            raise StoreError(f"assembled upload has {len(data)} bytes, declared {size}")
        if hashlib.sha256(data).hexdigest() != digest:
            raise StoreError(f"Digest mismatch for multipart upload of {key}")
        result = _create_objects(ns, ns_dir, {key: data})
    except BaseException:
        if _remove_upload(up):
            volume.commit()
        raise
    _remove_upload(up)
    result["swept"] = _sweep_uploads(ns_dir)
    volume.commit()
    return result


def op_upload_abort(p: dict) -> dict:
    ns_dir = _ns_dir(p.get("ns"))
    up = _upload_dir(ns_dir, p.get("upload_id"))
    volume.reload()
    removed = _remove_upload(up)
    if removed:
        volume.commit()
    return {"removed": removed}


def op_get(p: dict) -> dict:
    """Inline objects up to the response budget; objects above INLINE_MAX_BYTES are
    reported in "large" as {size, sha256} and must be fetched with get_range."""
    ns_dir = _ns_dir(p.get("ns"))
    keys = p.get("keys")
    if not isinstance(keys, list) or len(keys) > MAX_KEYS_PER_CALL:
        raise StoreError(f"keys must be a list of at most {MAX_KEYS_PER_CALL} items")
    keys = [_check_key(k) for k in keys]
    volume.reload()
    out, large, remaining, size = {}, {}, [], 0
    for key in dict.fromkeys(keys):
        if remaining:
            remaining.append(key)
            continue
        path = _obj_path(ns_dir, key)
        try:
            st = os.stat(path)
        except (FileNotFoundError, NotADirectoryError):
            continue
        if not os.path.isfile(path):
            continue
        if st.st_size > INLINE_MAX_BYTES:
            data = _read(path)
            if data is not None:
                large[key] = {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            continue
        # Always return at least one object so the caller makes progress.
        if (out or large) and size + st.st_size > MAX_RESPONSE_BYTES:
            remaining.append(key)
            continue
        data = _read(path)
        if data is None:
            continue
        size += len(data)
        out[key] = base64.b64encode(data).decode("ascii")
    return {"objects": out, "large": large, "remaining": remaining}


def op_get_range(p: dict) -> dict:
    ns_dir = _ns_dir(p.get("ns"))
    key = _check_key(p.get("key"))
    offset = _as_int(p.get("offset"))
    length = _as_int(p.get("length"))
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        raise StoreError("offset must be a non-negative integer")
    if not isinstance(length, int) or isinstance(length, bool) or not 1 <= length <= MAX_RANGE_BYTES:
        raise StoreError(f"length must be an integer in [1, {MAX_RANGE_BYTES}]")
    volume.reload()
    path = _obj_path(ns_dir, key)
    try:
        with open(path, "rb") as f:
            total = os.fstat(f.fileno()).st_size
            f.seek(offset)
            data = f.read(length)
    except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
        return {"found": False}
    return {"found": True, "size": total, "offset": offset, "b64": base64.b64encode(data).decode("ascii")}


def op_list(p: dict) -> dict:
    ns_dir = _ns_dir(p.get("ns"))
    prefix = p.get("prefix", "")
    if (
        not isinstance(prefix, str)
        or not PREFIX_RE.fullmatch(prefix)
        or prefix.startswith("/")
        or any(s in (".", "..") for s in prefix.split("/")[:-1])
        or "//" in prefix
    ):
        raise StoreError(f"Invalid list prefix {json.dumps(prefix)}")
    after = p.get("after")
    if after is not None and not isinstance(after, str):
        raise StoreError("after must be a string")
    limit = _as_int(p.get("limit", MAX_LIST))
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 0:
        raise StoreError("limit must be a non-negative integer")
    limit = min(limit, MAX_LIST)

    volume.reload()
    base = os.path.join(ns_dir, "objects")
    prefix_dir = prefix[: prefix.rfind("/")] if "/" in prefix else ""
    start = os.path.join(base, *prefix_dir.split("/")) if prefix_dir else base
    found = []
    for dirpath, _dirnames, filenames in os.walk(start):
        rel = os.path.relpath(dirpath, base)
        rel = "" if rel == "." else rel.replace(os.sep, "/")
        for name in filenames:
            key = f"{rel}/{name}" if rel else name
            if key.startswith(prefix) and (after is None or key > after):
                found.append(key)
    found.sort()
    return {"keys": found[:limit]}


def op_get_ref(p: dict) -> dict:
    ns_dir = _ns_dir(p.get("ns"))
    name = _check_ref(p.get("name"))
    volume.reload()
    return {"ref": _read_ref(ns_dir, name)}


def _acquire(lock_key: str) -> str:
    token = secrets.token_hex(16)
    deadline = time.monotonic() + LOCK_WAIT_S
    delay = 0.05
    while True:
        if locks.put(lock_key, {"token": token, "acquiredAt": _now()}, skip_if_exists=True):
            return token
        if time.monotonic() >= deadline:
            holder = locks.get(lock_key)
            since = holder.get("acquiredAt") if isinstance(holder, dict) else None
            raise RefLocked(since)
        time.sleep(delay * (0.5 + random.random()))
        delay = min(delay * 1.6, 0.5)


def _release(lock_key: str, token: str) -> None:
    holder = locks.get(lock_key)
    if isinstance(holder, dict) and holder.get("token") == token:
        locks.pop(lock_key, None)


def op_cas_ref(p: dict) -> dict:
    ns = p.get("ns")
    ns_dir = _ns_dir(ns)
    name = _check_ref(p.get("name"))
    expected = _as_int(p.get("expected_version"))
    if expected is not None and (not isinstance(expected, int) or isinstance(expected, bool) or expected < 1):
        raise StoreError("expected_version must be a positive integer or null")
    if "value" not in p:
        raise StoreError("value is required")
    value = p.get("value")
    try:
        if len(json.dumps(value, separators=(",", ":"))) > MAX_REF_VALUE_BYTES:
            raise StoreError(f"ref value exceeds {MAX_REF_VALUE_BYTES} bytes")
    except (TypeError, ValueError):
        raise StoreError("ref value must be JSON")

    lock_key = f"ref:{ns}:{name}"
    try:
        token = _acquire(lock_key)
    except RefLocked as e:
        return {
            "error": "ref_locked",
            "detail": f"ref {ns}/{name} is locked by another writer (held since {e.args[0]}); retry later",
            "lock_key": lock_key,
        }
    try:
        volume.reload()
        current = _read_ref(ns_dir, name)
        current_version = current.get("version") if isinstance(current, dict) else None
        if current_version != expected:
            return {"ok": False, "current": current}
        nxt = {"version": (current_version or 0) + 1, "value": value, "updatedAt": _now()}
        _atomic_write(ns_dir, _ref_path(ns_dir, name), json.dumps(nxt, separators=(",", ":")).encode("utf-8"))
        volume.commit()
        return {"ok": True, "current": nxt}
    finally:
        _release(lock_key, token)


OPS = {
    "put": op_put,
    "get": op_get,
    "get_range": op_get_range,
    "upload_part": op_upload_part,
    "upload_commit": op_upload_commit,
    "upload_abort": op_upload_abort,
    "list": op_list,
    "get_ref": op_get_ref,
    "cas_ref": op_cas_ref,
}


@app.function(
    image=image,
    volumes={MOUNT: volume},
    timeout=120,
    max_containers=4,
    scaledown_window=120,
    cpu=0.25,
    memory=1024,
)
def store_op(op: str, payload: dict) -> dict:
    handler = OPS.get(op) if isinstance(op, str) else None
    if handler is None:
        return {"error": f"Unknown op {json.dumps(op) if isinstance(op, str) else type(op).__name__}"}
    if not isinstance(payload, dict):
        return {"error": "payload must be an object"}
    try:
        return handler(payload)
    except StoreError as e:
        return {"error": str(e)}
