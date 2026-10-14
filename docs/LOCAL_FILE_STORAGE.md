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

Use PostgreSQL 15 or later with a compatible TimescaleDB release; 046 uses a column-specific `ON DELETE SET NULL` to retain tenant ownership. See the [PostgreSQL 15 constraint documentation](https://www.postgresql.org/docs/15/ddl-constraints.html#DDL-CONSTRAINTS-FK).

Set `STORAGE_ROOT` to the new persistent directory. Keep the previous `PROGRAM_TRANSFER_DIR` unchanged: historical relative `company-N/<IP>` and `company-N/machine-N` program references continue using that legacy root. If that variable was previously omitted, the legacy root remains `Backend/storage/ProgramTransfer`; preserve it when moving the checkout. New program records use the unified directory even while old records remain readable.

Existing S3 images are not automatically downloaded or deleted. Re-upload each machine's image through its company account to replace its old URL. Before moving a company to a disconnected customer server, copy/import every required old image and verify its local reference; a remaining S3 URL still needs internet access. Retain the original bucket until the local copy and backups are checked. Never replace every stored URL by string substitution: URLs alone do not create local bytes or ownership metadata.

Build and deploy the frontend with the customer's API URL; canonical local references resolve against that API's origin. Move the database and the matching complete `STORAGE_ROOT` tree plus any legacy program root, preserve relative names, set the new root paths, and verify upload/download/Backup as the relevant company and plant users.

## Backup and capacity

Back up `STORAGE_ROOT`, the legacy program root if still used, and PostgreSQL together at a consistent boundary. Pause uploads/device file results during a backup snapshot or use a coordinated backup process. The existing database dump script backs up the database only; its optional S3 off-host copy is independent of application storage. An internal server can copy backups to its own backup host or NAS.

Monitor free disk space and backup age. Immutable program versions and images accumulate; no automatic deletion policy is introduced by this change. On one API host, local storage is the low-cost option. Before adding API hosts, use a shared persistent volume/storage provider and coordinate socket/session state; replicas with separate local disks cannot serve one another's files.
