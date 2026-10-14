/** Shared image contract. Importing this module never opens a database. */
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/;
const URL_PATTERN = /^\/api\/files\/companies\/([1-9]\d*)\/images\/machines\/([0-9a-f-]+\.(?:jpg|png|webp))$/;

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

module.exports = { MAX_BYTES, ALLOWED_MIME, FILE_PATTERN, URL_PATTERN, directory, fileUrl, typeOf };
