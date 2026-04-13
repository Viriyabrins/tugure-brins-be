import { sendSuccess, sendError } from '../utils/response.js';
import minioService from '../services/MinioService.js';

export default class FileController {
  /**
   * Upload a file to MinIO.
   * Expects multipart form data with file and metadata.
   */
  async uploadFile(request, reply) {
    try {
      const data = await request.file();

      if (!data) {
        return sendError(reply, { message: 'No file provided' }, 400);
      }

      const { recordId, batchId } = request.body || request.query;

      if (!recordId || !batchId) {
        return sendError(reply, { message: 'recordId and batchId are required' }, 400);
      }

      // Read file buffer
      const fileBuffer = await data.toBuffer();
      const fileName = data.filename;

      // Upload to MinIO
      const result = await minioService.uploadFile(fileBuffer, fileName, recordId, batchId);

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
   */
  async listFiles(request, reply) {
    try {
      const { recordId, batchId } = request.query;

      if (!recordId || !batchId) {
        return sendError(reply, { message: 'recordId and batchId are required' }, 400);
      }

      const files = await minioService.listFiles(recordId, batchId);

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
