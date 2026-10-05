#!/bin/sh
# STM MEXA Program Transfer - every call the machine's device makes, with curl.
#
# 1. In the web app: Program Transfer > choose the machine > set its Program path
#    (where the device saves programs on the machine, e.g. //CNC_MEM/USER/PATH1/)
#    > Link a device > Create token. Copy the token (it is shown once).
# 2. Put it below, run the lines one at a time and watch the answers.

URL=https://stmapi.stmcnc.com/api/device/v1        # on-premise: the customer's server
TOKEN=mxd_paste-your-token-here
AUTH="Authorization: Bearer $TOKEN"

# ── 1. Check the token. The answer says which machine this is and its program path.
curl -s -H "$AUTH" $URL/ping
# {"device_id":3,"machine":{"serial":"VMC-1","ip_address":"192.168.200.3",
#  "program_path":"//CNC_MEM/USER/PATH1/"},"server_time":"…","poll_seconds":15}

# ── 2. Ask for work, every 15 seconds. HTTP 204 with no body = nothing to do.
curl -s -w '\nHTTP %{http_code}\n' -H "$AUTH" $URL/jobs/next
# {"job":{"id":11,"action":"SEND","program_name":"O1234.nc",
#  "program_path":"//CNC_MEM/USER/PATH1/","target_file":"//CNC_MEM/USER/PATH1/O1234.nc",
#  "overwrite":true,"requested_by":"Priya",
#  "file":{"size":2048,"sha256":"9f2c…","url":"/api/device/v1/jobs/11/file"}}}

# ── 3. NEW PROGRAM (server -> machine). action SEND: download it ...
curl -s -H "$AUTH" -o O1234.nc $URL/jobs/11/file
sha256sum O1234.nc            # must equal job.file.sha256 - if not, do not use it
#    ... then save it on the machine at target_file (your FOCAS / FTP code).

# ── 4. BACKUP (machine -> server). Before overwriting, upload what is on the
#    machine now, with the SEND job's id. Only overwrite once this answers 201.
curl -s -H "$AUTH" \
  -F type=BACKUP -F job_id=11 -F program_name=O1234.nc \
  -F sha256=$(sha256sum O1234-on-machine.nc | cut -d' ' -f1) \
  -F file=@O1234-on-machine.nc \
  $URL/files
#    A backup on your own schedule (nightly, say) needs no job_id:
curl -s -H "$AUTH" -F type=BACKUP -F program_name=O2001.nc -F file=@O2001.nc $URL/files
# {"file":{"id":41,"kind":"BACKUP","program_name":"O1234.nc",
#  "stored_as":"company-5/192.168.200.3/20261005-103020_BACKUP_O1234.nc","size":1990,…}}

# ── 5. Say how the job went. FAILED must say why: the person who asked reads it.
curl -s -H "$AUTH" -H 'Content-Type: application/json' -d '{"status":"DONE"}' $URL/jobs/11/result
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"status":"FAILED","message":"Controller memory is full."}' $URL/jobs/11/result

# ── 6. UPLOAD A PROGRAM A USER ASKED FOR (machine -> server). A user clicked
#    "Get" on the web page: the job's action is FETCH. Read program_name from
#    program_path on the machine and upload it - this finishes the job.
curl -s -H "$AUTH" -F type=FETCHED -F job_id=12 -F file=@O2001.nc $URL/files
#    Not there?  -d '{"status":"FAILED","message":"O2001.nc is not on the machine."}'  to /jobs/12/result

# ── 7. What is in the machine's program path - every few minutes, and after each job.
curl -s -X PUT -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"files":[{"name":"O1234.nc","size":2048,"modified":"2026-10-05T04:00:00Z"},{"name":"O2001.nc","size":512}]}' \
  $URL/controller-files
