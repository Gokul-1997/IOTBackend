# Program Transfer: send a program, get a program

## In the app

1. Choose **CNC Machine** once.
2. **Send to machine:** choose **Send a new file**, select your program, then **Send program**. Or choose **Send** beside an existing saved program.
3. **Get from machine:** choose **Get** beside a controller program. Once its transfer shows **Done**, choose **Download** in Recent transfers or Transfer History.

Follow the status until **Done**; queued transfers still need the machine's device to complete them. Admins configure the path and device token under **Machine setup**. Optional program names and notes are inside the upload dialog's expandable section.

## Using Postman

For the normal operator flow, use **your login token**. The machine's device uses a separate **device token**. You do not need to run the device requests when a working device agent is already connected.

Import these two files into Postman:

- [CNC Program Transfer collection](postman/CNC_Program_Transfer.postman_collection.json)
- [Blank local environment](postman/CNC_Program_Transfer.local.postman_environment.json)

Select **CNC Program Transfer - Local (fill privately)**. Set `base_url` to your backend address without `/api` or a trailing slash; the included value is `http://localhost:8000`. Use HTTPS for a hosted server. Fill your local `email` and `password` values. Keep credentials private; share the original blank environment, not your populated export or saved login responses.

The collection includes complete illustrative success/error responses under each request's **Examples**. No real credentials or machine files are included. Use **Send** on individual requests. Collection Runner deliberately stops after the selected request; this is not an automatic machine-control test. Use a current Postman version supporting [`pm.execution.skipRequest()`](https://learning.postman.com/v11/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/pm-execution/); do not remove the guards to run the whole collection.

## First time: login and choose the machine

1. Send **1 Setup → 01 Login**. Body is JSON: `{"email":"{{email}}","password":"{{password}}"}`. The script stores `access_token` and `refresh_token` from the response.
2. Send **03 List machines and choose machine_id**. Choose the correct row in `data`, set the environment's `machine_id` to its `id`, then send that request again to capture its serial. The collection never chooses the first machine automatically.
3. Check that this machine has a `program_path` and an online device. If configured already, setup is finished.
4. Only if the path is missing, enter the actual `program_path`, such as `//CNC_MEM/USER/PATH1/`, set `confirm_setup_machine_id` to the selected machine ID, and send **04 Set machine program path**. It sends `PUT /api/machines/{id}` with only `{"program_path":"..."}`.
5. Only if linking/replacing a device, set `confirm_replace_machine_id` to that machine ID, then send **05 Create or replace device token**. This immediately invalidates its old device token. The response contains the new token **once**; install it securely in that machine's agent. The script also saves it privately as `device_token` for integration testing.

`machine_id` is the database ID from this list, not the serial number, IP address, or controller program number. All operator requests are restricted to the logged-in user's company; do not pass a company ID in the body.

## Send a program to the machine

1. Open **2 Send program → 01 Upload and send to machine**.
2. In **Body → form-data**, select your NC file in the `file` row. Keep these text fields:

   | Key | Value | Meaning |
   |---|---|---|
   | `file` | Select File | Your actual program; row type **File** |
   | `machine_id` | `{{machine_id}}` | Selected destination |
   | `send` | `true` | Save the file and queue a SEND job |
   | `overwrite` | `false` | Refuse a known existing controller program |
   | `program_name` | Optional; disabled by default | Uses the uploaded filename when omitted |
   | `note` | Optional | Up to 255 characters |

3. Click **Send**. A `201` response contains `data.file.id` and `data.job.id`; the script stores `file_id` and `job_id`.
4. Open **4 Check status → 01 Check jobs**. Send it again after about 15 seconds until your job is `DONE` or `FAILED`. Read the failure `message` if it fails.

**QUEUED does not mean the program reached the controller.** The device must collect the job, download the file, verify it, write the controller, then report its result. Postman uploading a file cannot perform these controller operations.

Do not set a `Content-Type` header for uploads; Postman adds the multipart boundary. Use `send=false` if you only want to save the file on the server. To send an already saved file, use **02 Send an already saved file** instead, with this JSON:

```json
{
  "action": "SEND",
  "file_ids": [41],
  "machine_ids": [7],
  "overwrite": false
}
```

Use your real IDs. Do not run both SEND alternatives for the same open job. For `FILE_EXISTS`, inspect the machine and deliberately change `overwrite` to `true` only if replacement is intended; the device must back up an existing program before overwriting it.

## Get a program from the machine onto your computer

1. Send **3 Get program → 01 List programs currently reported on the machine**. This is the device's last reported inventory; check `reported_at`.
2. Set `program_name` to the exact controller filename you want. Send **02 Request a program from machine (FETCH)**:

   ```json
   {
     "action": "FETCH",
     "machine_id": 7,
     "program_names": ["O2001.nc"]
   }
   ```

3. Send **4 Check status → 01 Check jobs** until that exact job is `DONE`. The script captures its returned `file_id`. A FETCH request initially has no file to download.
4. Open **03 Download saved file to computer** and use **Send and Download**, or save the response. It calls `GET /api/programs/files/{file_id}/download` and returns file bytes, not JSON.

Already saved files can be found with **02 List saved files**. Set `file_id` to the chosen row and download directly. Optional filters are `kind=NEW`, `BACKUP`, or `FETCHED`, and `search=O1234`. Jobs/files are paginated: change `page` when needed. Job polling searches the exact `job_id` in the returned page; it never mistakes the latest unrelated job for yours. There is no `GET /api/programs/jobs/{id}` endpoint.

## Device team: how the physical transfer works

Use folder **5 Device integration ONLY** with `Authorization: Bearer {{device_token}}`. Other folders inherit `Authorization: Bearer {{access_token}}`. A user JWT does not work on `/api/device/v1`, and an `mxd_…` token does not work on operator endpoints.

1. **Ping** returns `machine.serial`, `machine.program_path`, and `poll_seconds` (default 15). The script checks the serial against your selected machine.
2. **Claim next job** calls `GET /api/device/v1/jobs/next`. This **changes state**, although it uses GET: it claims the oldest queued job and marks it `DELIVERED`. `204` with an empty body is normal when there is no work. Only claim during a coordinated device integration test; do not compete with a running agent.
3. For a manual claim, set `confirm_claim_job_id` to the queued `job_id` you just inspected. The server still chooses the oldest job. If it returns another job, the script refuses to use it and records `unexpected_claim_id`; that job is already claimed and must be handed to the responsible device team. Do not keep claiming jobs to search for yours.
4. Follow the returned `action`:

   | SEND: platform → controller | FETCH: controller → platform |
   |---|---|
   | Download `/jobs/{id}/file`. | Read the returned `target_file` from the controller. |
   | Verify the actual downloaded bytes against `file.size`, `file.sha256`, and `X-Sha256`. The Postman test checks metadata only. | Upload actual bytes as multipart `file`, `type=FETCHED`, `job_id={id}`. Optional `sha256` verifies the uploaded bytes. |
   | If target exists with `overwrite=false`, report FAILED. If it exists with `overwrite=true`, upload the **old** bytes with `type=BACKUP`, `job_id={id}` and wait for `201` before writing. | A successful `201` upload automatically marks the FETCH job `DONE`; no result request is needed. |
   | Write to `target_file`, read it back, and verify it before reporting `{"status":"DONE"}`. | If the controller program cannot be read, report FAILED with the actual reason. |

For a SEND result set `confirm_done_job_id` to the verified `claimed_job_id`. For a FETCH upload set `confirm_fetch_job_id`. To report a failure, set `failure_message` and `confirm_failed_job_id`. These values are consumed once. The scripts also require matching job, machine, action, and program. They are guardrails for manual testing, not proof that a physical controller operation succeeded.

To compute a downloaded file's SHA-256 locally, use `shasum -a 256 O1234.nc` on macOS, `sha256sum O1234.nc` on Linux, or `Get-FileHash O1234.nc -Algorithm SHA256` in PowerShell. Verify the file byte count too. Enable the optional `sha256` multipart row only after setting `upload_sha256` to the digest of the actual file being uploaded.

After jobs and about every five minutes, the device can `PUT /controller-files` with its **actual complete** inventory. This replaces the previous list, with at most 5,000 entries. The collection requires `confirm_report_machine_id`; replace the example body first. Scheduled BACKUP uploads can omit `job_id`. Never execute a program or press CYCLE START as part of this transfer API.

Jobs normally follow `QUEUED → DELIVERED → DONE / FAILED`. Only a QUEUED job can be cancelled (`POST /api/programs/jobs/{id}/cancel`). The scheduled timeout task fails unclaimed jobs after 24 hours and claimed jobs after 15 minutes, on its next five-minute run. Do not retry an interrupted physical write blindly. Full agent contract: [Program Transfer Device API](PROGRAM_TRANSFER_DEVICE_API.md).

## Common errors

| HTTP | Response / code | What to check |
|---|---|---|
| 400 | `NO_FILE`, `NO_MACHINE`, `NO_PROGRAM`, `BAD_ACTION` | Select `file` as a File row; provide the destination ID or program name and correct action. |
| 400 | `BAD_NAME`, `BAD_TYPE`, `EMPTY`, `NOT_TEXT` | Nonempty NC text file; supported extension or no extension; name up to 100 characters. |
| 401 | User: `{"message":"Access token expired or invalid"}` | Run Refresh user token, or log in again. |
| 401 | Device: `TOKEN_MISSING` / `TOKEN_INVALID` | Correct machine device token; it may have been replaced or revoked. |
| 403 | User: `{"message":"Permission denied","required":"page:programs:upload"}` | Ask the company administrator for the required role permission. |
| 403 | Device: `MACHINE_INACTIVE` / `COMPANY_DISABLED` | Stop and resolve the inactive machine/company; do not loop retries. |
| 409 | `NO_PROGRAM_PATH` | Configure the real machine program folder first. |
| 409 | `DUPLICATE_JOB` | An open job already exists for the same program; follow its status. |
| 409 | `FILE_EXISTS` | Review whether the controller program should be replaced; do not silently overwrite. |
| 409 | `WRONG_ACTION`, `JOB_NOT_OPEN`, `NO_FILE` | Match SEND/FETCH, check job state; FETCH completes through its file upload. |
| 404 | `MACHINE_NOT_FOUND`, `FILE_NOT_FOUND`, `JOB_NOT_FOUND` | Recheck IDs and company/machine ownership. |
| 413 / 422 | `TOO_LARGE` / `CHECKSUM_MISMATCH` | Default size limit is 20 MB (server configurable); digest must match the uploaded bytes. |

Program API validation errors use `{"status":"error","code":"...","message":"..."}` with optional `names`. Authentication, permission, and machine-update routes can use the different shapes shown above. View needs `page:programs:view`; upload needs `page:programs:upload`; SEND also needs `page:programs:transfer`; FETCH needs `page:programs:fetch`; setup/token creation needs `machine.update`.

Run the offline artifact checks with `node docs/postman/validate.cjs` from `Backend`. These checks do not send any HTTP request, claim a job, or operate a machine. After editing these source documents, run `node docs/postman/sync-frontend.cjs` to update the downloadable copies in the sibling `FrontendIOT/public/integrations` folder. The web screen exposes them under **Postman / API guide**; they are downloaded only when requested.
