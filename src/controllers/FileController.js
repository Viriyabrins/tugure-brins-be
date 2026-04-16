import { sendSuccess, sendError } from '../utils/response.js';
import minioService from '../services/MinioService.js';

/** Allowed folder → subfolder combinations for path-based storage. */
const ALLOWED_PATHS = {
  'master-contract': ['excel', 'attachment'],
  'claim': ['excel', 'attachment'],
  'batch': ['excel', 'attachment'],
  'subrogation': ['excel', 'attachment'],
};

/** Reject values containing path-traversal characters. */
function isSafePathSegment(value) {
  if (!value) return true; // empty/null is ok (optional fields)
  return !/[\/\\]|\.\.|\x00/.test(value);
}

/** Validate folder + subfolder against the allowlist and sanitize all path segments. */
function validateStoragePath(folder, subfolder, recordId, identifier) {
  if (!folder || !subfolder) {
    return { valid: false, error: 'folder and subfolder are required' };
  }
  if (!ALLOWED_PATHS[folder]) {
    return { valid: false, error: `Invalid folder: "${folder}". Allowed: ${Object.keys(ALLOWED_PATHS).join(', ')}` };
  }
  if (!ALLOWED_PATHS[folder].includes(subfolder)) {
    return { valid: false, error: `Invalid subfolder "${subfolder}" for folder "${folder}". Allowed: ${ALLOWED_PATHS[folder].join(', ')}` };
  }
  for (const [label, val] of [['folder', folder], ['subfolder', subfolder], ['recordId', recordId], ['identifier', identifier]]) {
    if (!isSafePathSegment(val)) {
      return { valid: false, error: `Invalid characters in ${label}` };
    }
  }
  return { valid: true };
}

export default class FileController {
  /**
   * Upload a file to MinIO.
   * Supports two modes:
   *   1. Folder-based (new): form fields folder, subfolder, optional recordId, optional identifier
   *   2. Legacy: form fields recordId, batchId
   */
  async uploadFile(request, reply) {
    try {
      const data = await request.file();

      if (!data) {
        return sendError(reply, { message: 'No file provided' }, 400);
      }

      // With @fastify/multipart, form fields are on data.fields
      const folder = data.fields.folder?.value;
      const subfolder = data.fields.subfolder?.value;
      const recordId = data.fields.recordId?.value;
      const identifier = data.fields.identifier?.value;
      const batchId = data.fields.batchId?.value;

      // Read file buffer
      const fileBuffer = await data.toBuffer();
      const fileName = data.filename;

      let result;

      if (folder && subfolder) {
        // ── New folder-based upload ──────────────────────────────────
        const validation = validateStoragePath(folder, subfolder, recordId, identifier);
        if (!validation.valid) {
          return sendError(reply, { message: validation.error }, 400);
        }

        const pathPrefix = recordId
          ? `${folder}/${subfolder}/${recordId}`
          : `${folder}/${subfolder}`;

        const metadata = {
          folder,
          subfolder,
          ...(recordId && { 'record-id': recordId }),
          ...(identifier && { identifier }),
        };

        result = await minioService.uploadFileToPath(fileBuffer, fileName, pathPrefix, identifier || '', metadata);
      } else if (recordId && batchId) {
        // ── Legacy upload (backward compat) ──────────────────────────
        result = await minioService.uploadFile(fileBuffer, fileName, recordId, batchId);
      } else {
        return sendError(reply, { message: 'Either (folder + subfolder) or (recordId + batchId) are required' }, 400);
      }

      return sendSuccess(reply, result, 'File uploaded successfully');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  /**
   * Delete a file from MinIO.
   */
  async deleteFile(request, reply) {
    try {
      const { key } = request.params;

      if (!key) {
        return sendError(reply, { message: 'File key is required' }, 400);
      }

      await minioService.deleteFile(key);

      return sendSuccess(reply, { key }, 'File deleted successfully');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  /**
   * List files for a record.
   * Supports two modes:
   *   1. Folder-based (new): query params folder, subfolder, optional recordId
   *   2. Legacy: query params recordId, batchId
   */
  async listFiles(request, reply) {
    try {
      const { folder, subfolder, recordId, batchId } = request.query;

      let files;

      if (folder && subfolder) {
        // ── New folder-based listing ─────────────────────────────────
        const validation = validateStoragePath(folder, subfolder, recordId);
        if (!validation.valid) {
          return sendError(reply, { message: validation.error }, 400);
        }

        const pathPrefix = recordId
          ? `${folder}/${subfolder}/${recordId}`
          : `${folder}/${subfolder}`;

        files = await minioService.listFilesByPath(pathPrefix);
      } else if (recordId && batchId) {
        // ── Legacy listing (backward compat) ─────────────────────────
        files = await minioService.listFiles(recordId, batchId);
      } else {
        return sendError(reply, { message: 'Either (folder + subfolder) or (recordId + batchId) are required' }, 400);
      }

      return sendSuccess(reply, { files }, 'Files listed successfully');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  /**
   * Get a presigned download URL for a file.
   */
  async getDownloadUrl(request, reply) {
    try {
      const { key } = request.query;

      if (!key) {
        return sendError(reply, { message: 'File key is required' }, 400);
      }

      const url = await minioService.getPresignedUrl(key);

      return sendSuccess(reply, { url }, 'Download URL generated successfully');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }

  /**
   * Get file info and download URL.
   */
  async getFileWithUrl(request, reply) {
    try {
      const { key } = request.query;

      if (!key) {
        return sendError(reply, { message: 'File key is required' }, 400);
      }

      const result = await minioService.getFileWithUrl(key);

      return sendSuccess(reply, result, 'File info retrieved successfully');
    } catch (error) {
      return sendError(reply, error, error.statusCode || 500);
    }
  }
}
