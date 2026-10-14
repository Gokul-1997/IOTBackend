#!/bin/sh
# API examples only. Run each step separately after reading its response.
# The real device needs a controller adapter and durable command state.
# Set API_URL=https://your-api and DEVICE_TOKEN to the machine's device token.
: "${API_URL:?Set API_URL to the final HTTPS API origin}"
: "${DEVICE_TOKEN:?Set DEVICE_TOKEN to the device token for this machine}"
API="${API_URL%/}/api/device/v1"

# 1. Poll every 15 seconds. job:null means no work. Save the command before
# touching the CNC. SEND includes the saved IP/path and file size/checksum;
# BACKUP has source CURRENT_RUNNING, so query the controller's actual program.
curl --fail-with-body -X POST -H "Authorization: Bearer $DEVICE_TOKEN" \
  -H 'Content-Type: application/json' -d '{}' "$API/commands/next"

# 2. For a SEND command, download using POST, verify command size + SHA-256,
# and use your FOCAS/FTP/controller adapter to save at its exact path.
# Replace COMMAND_ID with the id returned above; the example is not executable
# until COMMAND_ID and the program filename have been chosen from that response.
# curl --fail-with-body -X POST -H "Authorization: Bearer $DEVICE_TOKEN" \
#   -o O1234.nc "$API/jobs/$COMMAND_ID/file"
# After controller read-back matches, report success with the EXACT checksum:
# curl --fail-with-body -X POST -H "Authorization: Bearer $DEVICE_TOKEN" \
#   -H 'Content-Type: application/json' \
#   -d '{"status":"DONE","verified":true,"replaced":false,"sha256":"<command SHA-256>"}' \
#   "$API/jobs/$COMMAND_ID/result"
# If a file already exists, explicit overwrite approval and a confirmed
# POST /files type=BACKUP job_id upload must precede replacement. Then send
# replaced:true. Never replace a running program.

# 3. For a BACKUP command, read the ACTUAL current running program, then upload
# those bytes with its actual filename and checksum. This completes the command.
# curl --fail-with-body -X POST -H "Authorization: Bearer $DEVICE_TOKEN" \
#   -F "job_id=$COMMAND_ID" -F program_name=O1234.nc \
#   -F 'sha256=<SHA-256 of the actual controller file>' -F file=@O1234.nc "$API/backup"

# 4. An invalid path/unsupported controller/write error must reach the web user:
# curl --fail-with-body -X POST -H "Authorization: Bearer $DEVICE_TOKEN" \
#   -H 'Content-Type: application/json' \
#   -d '{"status":"FAILED","error_code":"PATH_NOT_FOUND","message":"The saved controller program path does not exist."}' \
#   "$API/jobs/$COMMAND_ID/result"
