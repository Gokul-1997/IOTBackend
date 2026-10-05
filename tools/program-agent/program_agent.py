#!/usr/bin/env python3
"""
STM MEXA - Program Transfer agent for the device at a machine.

Reference implementation of docs/PROGRAM_TRANSFER_DEVICE_API.md: the device
asks the server for work over HTTPS, writes new programs to the CNC (saving
the one it replaces as a BACKUP first), uploads programs it is asked for, and
reports what is on the controller. Python 3.8+, standard library only.

Configuration - environment variables, or KEY=VALUE lines in the file named
by --config (default /etc/mexa/program-agent.env, readable by root only):

    MEXA_URL            https://stmapi.stmcnc.com      (on-premise: the customer's server)
    MEXA_DEVICE_TOKEN   mxd_...                        (from Program Transfer > Device)
    MEXA_CA_FILE        optional CA bundle for an on-premise server with its own certificate
    CNC_DIR             only for FolderController, the stand-in CNC used for testing

Talking to the real controller is the one part to write for your device:
replace FolderController with a class that has the same four methods and
uses FOCAS (Fanuc) or the controller's FTP on the machine LAN.

    python3 program_agent.py                 run forever
    python3 program_agent.py --once          one poll, then exit (for testing)
    python3 program_agent.py --backup-all    upload every program on the CNC as BACKUP, then exit
"""
import argparse
import hashlib
import json
import os
import ssl
import sys
import time
import uuid
import urllib.error
import urllib.request

AGENT_VERSION = "1.0.0"
STATE_FILE = os.environ.get("MEXA_STATE_FILE", "/var/lib/mexa/program-agent.state")


# ---------------------------------------------------------------- the CNC

class FolderController:
    """A folder standing in for the CNC's program memory - for testing only."""

    def __init__(self, folder):
        self.folder = folder
        os.makedirs(folder, exist_ok=True)

    def _path(self, name):
        if os.path.basename(name) != name or name in ("", ".", ".."):
            raise ValueError("bad program name: %r" % name)
        return os.path.join(self.folder, name)

    def list_programs(self):
        out = []
        for name in sorted(os.listdir(self.folder)):
            p = os.path.join(self.folder, name)
            if os.path.isfile(p):
                st = os.stat(p)
                out.append({"name": name, "size": st.st_size,
                            "modified": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_mtime))})
        return out

    def read(self, name):
        """The program's bytes, or None when the controller does not have it."""
        try:
            with open(self._path(name), "rb") as f:
                return f.read()
        except FileNotFoundError:
            return None

    def write(self, name, data):
        tmp = self._path(name) + ".part"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, self._path(name))


# ---------------------------------------------------------------- the server

class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__("%s %s: %s" % (status, code, message))
        self.status, self.code = status, code


class Api:
    def __init__(self, url, token, ca_file=None):
        self.base = url.rstrip("/") + "/api/device/v1"
        self.token = token
        self.ctx = ssl.create_default_context(cafile=ca_file) if ca_file else ssl.create_default_context()
        if url.startswith("http://") and not url.startswith(("http://127.0.0.1", "http://localhost")):
            print("WARNING: plain http - the token travels unencrypted. Use https.", file=sys.stderr)

    def _call(self, method, path, body=None, headers=None, raw=False, timeout=60):
        h = {"Authorization": "Bearer " + self.token, "X-Agent-Version": AGENT_VERSION, **(headers or {})}
        req = urllib.request.Request(self.base + path, data=body, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=self.ctx) as r:
                data = r.read()
                if raw:
                    return r.status, dict(r.headers), data
                return r.status, (json.loads(data) if data else None)
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read() or b"{}")
            except ValueError:
                err = {}
            raise ApiError(e.code, err.get("code", "HTTP_%d" % e.code), err.get("message", e.reason))

    def _json(self, method, path, payload):
        return self._call(method, path, json.dumps(payload).encode(), {"Content-Type": "application/json"})

    def ping(self):
        return self._call("GET", "/ping")[1]

    def next_job(self):
        status, body = self._call("GET", "/jobs/next")
        return None if status == 204 else body["job"]

    def job_file(self, job_id):
        _, headers, data = self._call("GET", "/jobs/%d/file" % job_id, raw=True)
        return headers.get("X-Sha256") or headers.get("x-sha256"), data

    def upload(self, data, type_, program_name, job_id=None, note=None):
        """One upload for every program read off the CNC; `type_` is the tag: BACKUP or FETCHED."""
        boundary = uuid.uuid4().hex
        fields = {"type": type_, "program_name": program_name, "sha256": hashlib.sha256(data).hexdigest()}
        if job_id is not None:
            fields["job_id"] = str(job_id)
        if note:
            fields["note"] = note
        parts = []
        for k, v in fields.items():
            parts.append(("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n" % (boundary, k, v)).encode())
        parts.append(("--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\n"
                      "Content-Type: application/octet-stream\r\n\r\n" % (boundary, program_name)).encode())
        parts.append(data)
        parts.append(("\r\n--%s--\r\n" % boundary).encode())
        _, body = self._call("POST", "/files", b"".join(parts),
                             {"Content-Type": "multipart/form-data; boundary=" + boundary}, timeout=300)
        return body["file"]

    def result(self, job_id, status, message=None):
        return self._json("POST", "/jobs/%d/result" % job_id, {"status": status, "message": message})[1]

    def report_controller(self, files):
        return self._json("PUT", "/controller-files", {"files": files})[1]


# ---------------------------------------------------------------- the jobs

def remember(job_id):
    """The job under way, kept on disk: after a restart it is reported, never redone."""
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, "w") as f:
            f.write("" if job_id is None else str(job_id))
    except OSError as e:
        print("could not write %s: %s" % (STATE_FILE, e), file=sys.stderr)


def unfinished():
    try:
        with open(STATE_FILE) as f:
            v = f.read().strip()
            return int(v) if v else None
    except (OSError, ValueError):
        return None


def do_send(api, cnc, job):
    name = job["program_name"]
    sha, data = api.job_file(job["id"])
    if hashlib.sha256(data).hexdigest() != (sha or job["file"]["sha256"]) or len(data) != job["file"]["size"]:
        return "FAILED", "The program arrived damaged (size or SHA-256 differ). Send it again."

    current = cnc.read(name)
    if current is not None:
        if not job["overwrite"]:
            return "FAILED", "%s is already on the controller. Send again and confirm the overwrite." % name
        # nothing is overwritten that has not been kept: the backup must be on the server first
        api.upload(current, "BACKUP", name, job_id=job["id"], note="Before overwrite by job %d" % job["id"])

    cnc.write(name, data)
    if cnc.read(name) != data:
        return "FAILED", "The controller did not keep %s as sent (read-back differs)." % name
    return "DONE", None


def do_fetch(api, cnc, job):
    data = cnc.read(job["program_name"])
    if data is None:
        return "FAILED", "%s is not on the controller." % job["program_name"]
    api.upload(data, "FETCHED", job["program_name"], job_id=job["id"])   # completes the job on the server
    return None, None


NETWORK = (urllib.error.URLError, TimeoutError, ConnectionError)


def handle(api, cnc, job):
    remember(job["id"])
    try:
        status, message = (do_send if job["action"] == "SEND" else do_fetch)(api, cnc, job)
    except ApiError as e:
        if e.status in (401, 403):
            raise
        status, message = "FAILED", "The server refused a step: %s" % e
    except NETWORK:
        raise                                    # stays remembered; settle_unfinished() reports it
    except Exception as e:                       # the CNC said no: tell the person who asked
        status, message = "FAILED", "Controller error: %s" % e
    if status:
        api.result(job["id"], status, message)
    remember(None)
    print("job %s %s %s: %s" % (job["id"], job["action"], job["program_name"], status or "DONE"))


def settle_unfinished(api):
    """A job cut off by a restart or a network drop: say so, never redo it."""
    stuck = unfinished()
    if not stuck:
        return
    try:
        api.result(stuck, "FAILED", "The device lost the connection or restarted during this job. "
                                    "Check the program on the controller, then send again.")
    except ApiError as e:
        if e.status in (401, 403):
            raise
        print("previous job %s: %s" % (stuck, e))   # already finished, or timed out on the server
    remember(None)


def connect(api, once):
    """The first ping: a refused token stops the agent; anything else is retried."""
    wait = 10
    while True:
        try:
            return api.ping()
        except ApiError as e:
            if e.status in (401, 403):
                print("stopped: %s" % e, file=sys.stderr)
                return None
            print("server: %s" % e, file=sys.stderr)
        except NETWORK as e:
            print("network: %s" % e, file=sys.stderr)
        if once:
            return None
        time.sleep(wait)
        wait = min(wait * 2, 300)


def run(api, cnc, once=False):
    info = connect(api, once)
    if info is None:
        return 2
    poll = max(5, int(info.get("poll_seconds", 15)))
    print("connected as machine %s, polling every %ss" % (info["machine"]["serial"], poll))

    last_report = 0
    backoff = poll
    while True:
        try:
            settle_unfinished(api)
            if time.time() - last_report > 300:          # the "On the machine" list, every 5 minutes
                api.report_controller(cnc.list_programs())
                last_report = time.time()
            job = api.next_job()
            while job:                                   # drain the queue, then wait
                handle(api, cnc, job)
                last_report = 0
                job = api.next_job()
            backoff = poll
        except ApiError as e:
            if e.status in (401, 403):
                print("stopped: %s" % e, file=sys.stderr)
                return 2
            print("server: %s" % e, file=sys.stderr)
            backoff = min(backoff * 2, 300)
        except NETWORK as e:                             # network down: keep trying, slower
            print("network: %s" % e, file=sys.stderr)
            backoff = min(backoff * 2, 300)
        if once:
            return 0
        time.sleep(backoff)


def load_config(path):
    if path and os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--config", default="/etc/mexa/program-agent.env")
    p.add_argument("--once", action="store_true")
    p.add_argument("--backup-all", action="store_true")
    a = p.parse_args()
    load_config(a.config)

    url, token = os.environ.get("MEXA_URL"), os.environ.get("MEXA_DEVICE_TOKEN")
    if not url or not token:
        sys.exit("Set MEXA_URL and MEXA_DEVICE_TOKEN.")
    api = Api(url, token, os.environ.get("MEXA_CA_FILE"))
    cnc = FolderController(os.environ.get("CNC_DIR", "./cnc"))

    if a.backup_all:
        for prog in cnc.list_programs():
            api.upload(cnc.read(prog["name"]), "BACKUP", prog["name"], note="Scheduled backup")
            print("backed up", prog["name"])
        return 0
    return run(api, cnc, once=a.once)


if __name__ == "__main__":
    sys.exit(main())
