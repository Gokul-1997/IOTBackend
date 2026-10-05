#!/usr/bin/env python3
"""
STM MEXA Program Transfer - the smallest working device loop, to read and copy.

1. In the web app: Program Transfer > choose the machine > set its Program path
   (where programs live on the machine, e.g. //CNC_MEM/USER/PATH1/) > Link a
   device > Create token. Put the two lines it shows in the environment:
       export MEXA_URL=https://stmapi.stmcnc.com
       export MEXA_DEVICE_TOKEN=mxd_...
2. Replace the three functions under "your machine" with your FOCAS / FTP code.
   As they stand they use a folder on this computer, so the sample runs as is.
3. python3 minimal_device.py

For production use program_agent.py next to this file: same calls, plus
retries, a refused token stopping the loop, and a job cut off by a restart
reported instead of redone.
"""
import hashlib
import json
import os
import time
import urllib.request
import uuid

API = os.environ.get("MEXA_URL", "https://stmapi.stmcnc.com").rstrip("/") + "/api/device/v1"
TOKEN = os.environ.get("MEXA_DEVICE_TOKEN", "mxd_paste-your-token-here")


# ── your machine: replace these three with FOCAS / FTP code ─────────────────
def list_machine(path):
    """The programs in the machine's program path: [{name, size}]."""
    os.makedirs(path, exist_ok=True)
    return [{"name": n, "size": os.path.getsize(os.path.join(path, n))} for n in sorted(os.listdir(path))]


def read_from_machine(path, name):
    """The program's bytes, or None when the machine does not have it."""
    p = os.path.join(path, name)
    return open(p, "rb").read() if os.path.exists(p) else None


def save_on_machine(path, name, data):
    """Save the program in the machine's program path (replacing one of the same name)."""
    os.makedirs(path, exist_ok=True)
    with open(os.path.join(path, name), "wb") as f:
        f.write(data)


# ── the API ──────────────────────────────────────────────────────────────────
def call(method, url, body=None, content_type=None):
    headers = {"Authorization": "Bearer " + TOKEN}
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(API + url, data=body, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.status, r.read()


def send_json(method, url, payload):
    return call(method, url, json.dumps(payload).encode(), "application/json")


def upload(data, tag, name, job_id=None):
    """POST /files: every program going from the machine to the server.
    tag BACKUP = what is on the machine; FETCHED = a program a user asked for."""
    b = uuid.uuid4().hex
    fields = {"type": tag, "program_name": name, "sha256": hashlib.sha256(data).hexdigest()}
    if job_id:
        fields["job_id"] = str(job_id)
    body = b"".join(('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n' % (b, k, v)).encode()
                    for k, v in fields.items())
    body += ('--%s\r\nContent-Disposition: form-data; name="file"; filename="%s"\r\n\r\n' % (b, name)).encode()
    body += data + ("\r\n--%s--\r\n" % b).encode()
    return call("POST", "/files", body, "multipart/form-data; boundary=" + b)


# ── the loop ─────────────────────────────────────────────────────────────────
_, body = call("GET", "/ping")                             # 1. check the token
info = json.loads(body)
print("machine", info["machine"]["serial"], "- program path", info["machine"]["program_path"])
last_list = 0

while True:
    if time.time() - last_list > 300:                      # 7. what is on the machine, every 5 min
        path = json.loads(call("GET", "/ping")[1])["machine"]["program_path"]
        send_json("PUT", "/controller-files", {"files": list_machine(path)})
        last_list = time.time()

    status, body = call("GET", "/jobs/next")               # 2. anything to do?
    if status == 204:
        time.sleep(info["poll_seconds"])
        continue
    job = json.loads(body)["job"]
    path, name = job["program_path"], job["program_name"]  # where on the machine, and what
    try:
        if job["action"] == "SEND":                        # 3. a NEW PROGRAM for the machine
            _, data = call("GET", "/jobs/%d/file" % job["id"])
            if hashlib.sha256(data).hexdigest() != job["file"]["sha256"]:
                raise RuntimeError("The program arrived damaged. Send it again.")
            old = read_from_machine(path, name)
            if old is not None:
                if not job["overwrite"]:
                    raise RuntimeError("%s is already on the machine." % name)
                upload(old, "BACKUP", name, job["id"])     # 4. BACKUP first - raises if it fails
            save_on_machine(path, name, data)
            send_json("POST", "/jobs/%d/result" % job["id"], {"status": "DONE"})       # 5.
        else:                                              # 6. FETCH: a user asked for a program
            data = read_from_machine(path, name)
            if data is None:
                raise RuntimeError("%s is not on the machine." % name)
            upload(data, "FETCHED", name, job["id"])       # this finishes the job
        print("job", job["id"], job["action"], name, "done")
        last_list = 0                                      # report the new list straight away
    except Exception as e:
        send_json("POST", "/jobs/%d/result" % job["id"], {"status": "FAILED", "message": str(e)})   # 5.
        print("job", job["id"], job["action"], name, "failed:", e)
