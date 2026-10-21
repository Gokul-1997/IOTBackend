# Local application files

The API stores new machine images and program files on its own disk. AWS keys and an S3 bucket are not required for application uploads. Configure `STORAGE_ROOT` once; the default for development is `Backend/storage`. Production should use a persistent directory outside the Git checkout, such as `/opt/iot/storage`, owned by the account running the API. Container installations must mount a persistent volume there.

For an Ubuntu server where PM2 runs as `ubuntu`, create the root once (use the actual service account if different):

```sh
sudo install -d -m 0750 -o ubuntu -g ubuntu /opt/iot/storage
```

Set `STORAGE_ROOT=/opt/iot/storage` in the backend `.env`. Company and purpose subfolders are created automatically on upload. No public file-server configuration is needed.

```text
/opt/iot/storage/
  company-4/
    images/
      machines/<uuid>.png
    programs/
      machine-7/
        uploads/<timestamp>_NEW_O1234.nc
        backups/<timestamp>_BACKUP_O1234.nc
        fetched/<timestamp>_FETCHED_O1234.nc
  company-5/
    images/machines/...
    programs/machine-12/...
```

Company and machine IDs name folders, so renaming a company or changing a controller IP does not change the new file locations. Folders are created when their first file is saved. Future persisted file types should use another purpose directory inside the company folder through the same private storage service. Reports currently streamed to the browser do not need to be persisted.

## Upload and display

1. Select a machine plant and choose a JPEG, PNG or WebP image, up to 5 MB. The web form sends `POST /api/upload` with Bearer authorization and multipart fields `file` and `plant_id`.
2. The API checks the user's company, machine create/edit permission and company grant before accepting file bytes. It validates the image type, saves an immutable UUID file, and records ownership, MIME, size and checksum in `media_assets`. A failed catalogue insertion removes only this new file.
3. The response includes `fileUrl`, for example `/api/files/companies/4/images/machines/<uuid>.png`. Save that canonical relative reference in the machine form. Machine create/edit rejects another company's image or a new arbitrary external URL.
4. The web image loader fetches local references through authenticated HTTP and displays a blob URL. Requests for a visible image are shared and the small cache is bounded. Session or authorization changes clear cached images. Existing remote image URLs remain directly readable during migration.

The file route authorizes each request, including conditional requests, against the current company and machine plant. An uploader can preview a pending image for their selected plant. Once assigned, the machine's current placement decides access. Disk paths are never accepted from the browser. Files are private: do not mount `STORAGE_ROOT` with Express static middleware, Nginx `alias`, or a public share. If the frontend has a CSP, include `blob:` in its image sources. CORS must permit its real origin.

Deleting an otherwise empty plant clears the retained image catalogue's plant reference; it preserves company ownership and disk bytes. Former plant users cannot preview those unassigned images or attach them to another plant. A company administrator can retain the files for review, while a new machine attachment needs an image uploaded for its selected plant. Company deletion does not silently purge the catalogue or files.

The current mobile screens do not render `image_url`. Their telemetry and API flow remain compatible. A future native image view must fetch the protected route with its current Bearer authorization, rather than opening a private URL without headers.

## Upgrade an existing server

Back up the database and both file roots before changing configuration. Review pending migrations with `npm run migrate -- --status`; apply migration `046_local_media.sql` and its prerequisites through the existing migration runner. The migration is additive and does not move/delete old files or rewrite S3 URLs. Its rollback refuses to remove a nonempty catalogue.

Migration 046 now avoids the column-specific `ON DELETE SET NULL (plant_id)` syntax, which was added in [PostgreSQL 15](https://www.postgresql.org/docs/15/release-15.html#RELEASE-15-UTILITY). It uses a plant-deletion trigger with a composite company/plant foreign key, preserving company ownership on older PostgreSQL servers. Use a PostgreSQL/TimescaleDB pair supported by the rest of the project. When migrations run as a separate owner, the API role needs `SELECT` on `media_assets` and `UPDATE (plant_id)` for plant deletion; the normal migration runner uses the API's own database account.

If 046 failed with `syntax error at or near "("`, deploy the corrected migration and rerun `npm run migrate`. The runner rolls back a failed schema change and does not record it as applied. Do not use baseline/reset or delete data to retry. Check `npm run migrate -- --status` first: 046 should be `PENDING`. If another server has already applied the previous 046 successfully, its checksum must remain protected; a `CHANGED` result needs a separately reviewed upgrade rather than changing ledger checksums to force a rerun.

Set `STORAGE_ROOT` to the new persistent directory. Keep the previous `PROGRAM_TRANSFER_DIR` unchanged: historical relative `company-N/<IP>` and `company-N/machine-N` program references continue using that legacy root. If that variable was previously omitted, the legacy root remains `Backend/storage/ProgramTransfer`; preserve it when moving the checkout. New program records use the unified directory even while old records remain readable. Program Transfer uses `/api/programs` (people) and `/api/device/v1` (the machine's gateway, see [PROGRAM_TRANSFER_API.md](PROGRAM_TRANSFER_API.md)); historical files stay readable through this storage compatibility.

Existing S3 images keep their old URLs until they are imported or re-uploaded. Migration 046 creates the catalogue; it does not copy image bytes. Use the one-time `migrate:images` command below to copy old images and change each machine to its authenticated local URL. Retain the original bucket until the local copies and backups are checked. Never replace stored URLs by string substitution: URLs alone do not create local bytes or ownership metadata.

Build and deploy the frontend with the customer's API URL; canonical local references resolve against that API's origin. Move the database and the matching complete `STORAGE_ROOT` tree plus any legacy program root, preserve relative names, set the new root paths, and verify upload/download/Backup as the relevant company and plant users.

## Move older machine images from S3

Run this from `IOTBackend` on the server which owns the database and `STORAGE_ROOT`, after migration 046 succeeds. It uses the backend database/TLS configuration from `.env`. Take the database and file backup first. Replace the example bucket origin with the exact origin from your old machine image URLs, and `4` with the company ID you intend to migrate.

Running `npm run migrate:images` without options cannot choose an approved source. Supply both `--source-origin` and `--source-prefix`. For an old URL such as `https://my-bucket.s3.ap-south-1.amazonaws.com/images/file-123.jpg`, the origin is `https://my-bucket.s3.ap-south-1.amazonaws.com` and the prefix is `/images/`. The `--` after the npm script name passes these options to the importer. Missing/invalid options stop before loading `.env` or connecting to a database.

First review the plan. This reads machine references and placement only; it does not download files or change the database/storage:

```sh
npm run migrate:images -- \
  --company-id 4 \
  --source-origin https://your-old-bucket.s3.ap-south-1.amazonaws.com \
  --source-prefix /images/ \
  --dry-run
```

Then copy and switch the matching public images:

```sh
npm run migrate:images -- \
  --company-id 4 \
  --source-origin https://your-old-bucket.s3.ap-south-1.amazonaws.com \
  --source-prefix /images/ \
  --apply
```

The command processes images sequentially. It downloads only the approved HTTPS origin and prefix, rejects redirects/private network targets, checks the 5 MB image contract and saves a new immutable UUID file under the machine's actual company. It locks and rechecks the machine before changing its URL. The image catalogue insertion and machine URL update commit together. A failed copy or known failed transaction leaves the old URL intact. An uncertain commit keeps its file for reconciliation instead of risking deletion of a committed image. Files already migrated to local URLs are skipped when rerun; no S3 object is deleted.

Missing, inaccessible, oversized or invalid images are reported by machine ID and code. Invalid/unassigned plant ownership must be corrected through administration before retry. A file over 5 MB needs an optimized image re-uploaded through the machine form; the importer never truncates file bytes. Images at another bucket/CDN origin are reported as `OTHER_REMOTE_SOURCE` and remain unchanged until a separate reviewed run for that origin. Apply exits with status 1 if a copy failed, a machine changed during the import, or a commit needs reconciliation; review the reported IDs before retry. Dry-run eligibility is not proof that an object exists or can be downloaded.

For a private bucket, use your configured AWS CLI read access to stage an object copy locally. Preserve the bucket key layout: an old URL ending in `/images/file-123.jpg` must be available as `<source-dir>/images/file-123.jpg`. This copies S3 objects to a local directory using [AWS CLI sync](https://docs.aws.amazon.com/cli/latest/reference/s3/sync.html):

```sh
umask 077
aws s3 sync s3://your-old-bucket/ /home/ubuntu/legacy-s3-images/ \
  --exclude '*' --include 'images/*' --only-show-errors
npm run migrate:images -- \
  --company-id 4 \
  --source-origin https://your-old-bucket.s3.ap-south-1.amazonaws.com \
  --source-prefix /images/ \
  --source-dir /home/ubuntu/legacy-s3-images \
  --apply
```

The source-directory mode uses the original URL to choose its key inside the staged directory and reads bounded local bytes; it makes no HTTPS/S3 request. AWS credentials are used by your AWS CLI for this one-time copy, not by normal application uploads or the importer. Keep the staging folder private. Do not remove the original bucket or its backup until every required machine shows a local image. After a successful run, reload the web page; existing dashboard answers can retain old URLs for up to their five-minute cache lifetime. Verify the local URLs while blocking access to S3 before moving the installation offline. The current machine image views already support local API references, so no additional frontend rollout is needed if the local-storage frontend is installed.

## Backup and capacity

Back up `STORAGE_ROOT`, the legacy program root if still used, and PostgreSQL together at a consistent boundary. Pause program uploads and gateway backups during a backup snapshot or use a coordinated backup process. The existing database dump script backs up the database only; its optional S3 off-host copy is independent of application storage. An internal server can copy backups to its own backup host or NAS.

Monitor free disk space and backup age. Immutable program versions and images accumulate; no automatic deletion policy is introduced by this change. On one API host, local storage is the low-cost option. Before adding API hosts, use a shared persistent volume/storage provider and coordinate socket/session state; replicas with separate local disks cannot serve one another's files.
