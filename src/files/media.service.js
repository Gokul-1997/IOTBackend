const crypto = require('crypto');
const db = require('../db');
const local = require('./local-storage');
const access = require('../middleware/access.middleware');
const { effectivePlantId, idOrNull, resolvePlantId } = require('../lib/plant-scope');

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const READ_PERMISSIONS = ['page:machines:view', 'page:machines:create', 'page:machines:edit',
  'page:dashboard:view', 'page:dashboard:live:view', 'page:quality:view', 'page:analytics-maintenance:view'];
const FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/;
const URL_PATTERN = /^\/api\/files\/companies\/([1-9]\d*)\/images\/machines\/([0-9a-f-]+\.(?:jpg|png|webp))$/;

function requireCompany(user) {
  const company = idOrNull(user?.company_id, 'Company');
  if (!company) throw { status: 403, message: 'Select a company account before uploading or reading files', code: 'COMPANY_REQUIRED' };
  return company;
}
function directory(company) { return `company-${company}/images/machines`; }
function fileUrl(company, filename) { return `/api/files/companies/${company}/images/machines/${filename}`; }
function typeOf(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 45 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      && buffer.readUInt32BE(8) === 13 && buffer.toString('ascii', 12, 16) === 'IHDR'
      && buffer.readUInt32BE(16) > 0 && buffer.readUInt32BE(20) > 0
      && buffer.toString('ascii', buffer.length - 8, buffer.length - 4) === 'IEND') {
    return { mime: 'image/png', extension: 'png' };
  }
  if (buffer.length >= 12 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
      && buffer[buffer.length - 2] === 255 && buffer[buffer.length - 1] === 217) return { mime: 'image/jpeg', extension: 'jpg' };
  if (buffer.length >= 20 && buffer.toString('ascii', 0, 4) === 'RIFF'
      && buffer.readUInt32LE(4) === buffer.length - 8 && buffer.toString('ascii', 8, 12) === 'WEBP'
      && ['VP8 ', 'VP8L', 'VP8X'].includes(buffer.toString('ascii', 12, 16))) return { mime: 'image/webp', extension: 'webp' };
  return null;
}

async function uploadMachineImage(user, file, selectedPlant) {
  const company = requireCompany(user);
  if (!file) throw { status: 400, message: 'Choose an image to upload', code: 'NO_FILE' };
  if (!Buffer.isBuffer(file.buffer) || !file.buffer.length || file.buffer.length > MAX_BYTES) {
    throw { status: 400, message: 'Image must be nonempty and 5 MB or smaller', code: 'IMAGE_TOO_LARGE' };
  }
  const type = typeOf(file.buffer);
  if (!type || type.mime !== file.mimetype) throw { status: 400, message: 'File content must match its JPEG, PNG or WebP image type', code: 'INVALID_IMAGE_CONTENT' };
  // A new machine's image can be previewed before its machine record exists.
  // Its temporary access is tied to the uploader and an actual owned plant.
  const plant = await resolvePlantId(db, { ...user, plant_id: effectivePlantId(user) }, selectedPlant);
  const id = crypto.randomUUID();
  const filename = `${id}.${type.extension}`;
  const relative = directory(company);
  const storageKey = `${relative}/${filename}`;
  const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
  await local.ensureDirectory(relative);
  await local.write(relative, filename, file.buffer);
  try {
    await db.query(`INSERT INTO media_assets
      (id,company_id,plant_id,purpose,storage_key,filename,mime_type,size_bytes,sha256,uploaded_by)
      VALUES ($1,$2,$3,'machine-images',$4,$5,$6,$7,$8,$9)`,
    [id, company, plant, storageKey, filename, type.mime, file.buffer.length, sha, user.id]);
  } catch (error) {
    // Compensate only the newly allocated UUID. Never delete a previous image.
    await local.remove(relative, filename).catch(() => {});
    throw error;
  }
  return { id, filename, mime_type: type.mime, size_bytes: file.buffer.length, fileUrl: fileUrl(company, filename) };
}

function parseReference(value) {
  const match = typeof value === 'string' && URL_PATTERN.exec(value);
  if (!match || !FILE_PATTERN.test(match[2])) return null;
  const company = Number(match[1]);
  return Number.isSafeInteger(company) ? { company, filename: match[2] } : null;
}
async function getAsset(company, filename, client = db) {
  const { rows } = await client.query(`SELECT id,company_id,plant_id,purpose,storage_key,filename,mime_type,size_bytes,sha256,uploaded_by
    FROM media_assets WHERE company_id=$1 AND filename=$2 AND purpose='machine-images'`, [company, filename]);
  const asset = rows[0];
  // Stored paths are checked too: an old/manual database edit cannot turn the
  // private-file route into an arbitrary local-file reader.
  if (!asset || asset.storage_key !== `${directory(company)}/${filename}` || !ALLOWED_MIME.has(asset.mime_type)) {
    throw { status: 404, message: 'Image not found', code: 'IMAGE_NOT_FOUND' };
  }
  return asset;
}
async function authorizeRead(user, company, filename) {
  if (requireCompany(user) !== company || !FILE_PATTERN.test(filename)) throw { status: 404, message: 'Image not found', code: 'IMAGE_NOT_FOUND' };
  if (await access.denialForAny(user, READ_PERMISSIONS)) throw { status: 403, message: 'Permission denied', code: 'PERMISSION_DENIED' };
  const asset = await getAsset(company, filename);
  const plant = effectivePlantId(user);
  const companyAdmin = (user.roles || []).some(role => ['COMPANY_ADMIN', 'ADMIN'].includes(role));
  if (companyAdmin) return asset;
  const { rows } = await db.query(`SELECT
      EXISTS(SELECT 1 FROM machines WHERE company_id=$1 AND image_url=$2) AS assigned,
      EXISTS(SELECT 1 FROM machines WHERE company_id=$1 AND image_url=$2
        AND ($3::int IS NULL OR plant_id=$3)) AS allowed`, [company, fileUrl(company, filename), plant]);
  if (rows[0]?.allowed === true) return asset;
  // Assignment always wins over uploader access: a machine moved out of the
  // uploader's plant must no longer be visible through the old preview URL.
  if (rows[0]?.assigned === true || Number(asset.uploaded_by) !== Number(user.id)
      || (plant != null && Number(asset.plant_id) !== plant)) throw { status: 404, message: 'Image not found', code: 'IMAGE_NOT_FOUND' };
  if (await access.denialForAny(user, ['page:machines:create', 'page:machines:edit'])) {
    throw { status: 404, message: 'Image not found', code: 'IMAGE_NOT_FOUND' };
  }
  return asset;
}

/** Machine create/edit must use a local asset owned by the actual tenant.
 * Legacy remote URLs may only be kept unchanged during an ordinary edit;
 * they are migrated separately and are never fetched by this service. */
async function validateImageReference({ user, imageUrl, plantId, existingImageUrl, client = db }) {
  if (imageUrl == null || imageUrl === '') return null;
  if (typeof imageUrl !== 'string') throw { status: 400, message: 'Image reference is not valid' };
  const parsed = parseReference(imageUrl);
  if (!parsed) {
    if (/^https?:\/\//i.test(imageUrl) && imageUrl === existingImageUrl) return imageUrl;
    throw { status: 400, message: 'Upload an image using this company account first', code: 'INVALID_IMAGE_REFERENCE' };
  }
  const company = requireCompany(user);
  if (parsed.company !== company) throw { status: 404, message: 'Image not found', code: 'IMAGE_NOT_FOUND' };
  const asset = await getAsset(company, parsed.filename, client);
  const ownPlant = effectivePlantId(user);
  if (ownPlant != null && Number(plantId) !== ownPlant) throw { status: 403, message: 'You can only manage machines in your own plant' };
  // Existing images follow their machine when an authorized administrator
  // moves it. A fresh image cannot be borrowed from a different plant.
  if (imageUrl !== existingImageUrl && (asset.plant_id == null || Number(asset.plant_id) !== Number(plantId))) {
    throw { status: 400, message: 'Upload this image for the selected machine plant', code: 'IMAGE_PLANT_MISMATCH' };
  }
  return imageUrl;
}

module.exports = { MAX_BYTES, ALLOWED_MIME, READ_PERMISSIONS, FILE_PATTERN, requireCompany, directory, fileUrl, typeOf,
  uploadMachineImage, parseReference, authorizeRead, validateImageReference };
