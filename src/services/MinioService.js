import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import config from '../config/index.js';

class MinioService {
  constructor() {
    this.s3Client = null;
    this.bucket = null;
    this._init();
  }

  _init() {
    const { endpoint, accessKey, secretKey, bucket, region } = config.minio;

    // MinIO (custom endpoint) doesn't require a real AWS region — default to us-east-1 as a placeholder.
    // AWS S3 (no endpoint) requires a real region to route requests correctly.
    const effectiveRegion = region || (endpoint ? 'us-east-1' : null);

    if (!bucket || !effectiveRegion) {
      console.warn('[MinioService] MinIO configuration incomplete – S3 operations will fail.');
      return;
    }

    // MinIO (dev): requires custom endpoint + explicit credentials + path-style
    // AWS S3 (prod): only needs region; SDK uses IAM role from EC2 instance metadata
    const s3Options = { region: effectiveRegion };
    if (endpoint) {
      s3Options.endpoint = endpoint;
      s3Options.forcePathStyle = true;
      s3Options.credentials = {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      };
    }

    this.bucket = bucket;
    this.s3Client = new S3Client(s3Options);

    console.log('[MinioService] MinIO S3 client initialized ✓');
  }

  /**
   * Upload a file to MinIO.
   * @param {Buffer|Stream} fileContent - File content
   * @param {string} fileName - Original file name
   * @param {string} recordId - Record ID (claim_no, etc.)
   * @param {string} batchId - Batch ID
   * @returns {Promise<{key: string, fileName: string, size: number, uploadedAt: string}>}
   */
  async uploadFile(fileContent, fileName, recordId, batchId) {
    if (!this.s3Client) {
      throw new Error('MinIO service not configured');
    }

    const timestamp = Date.now();
    const uniqueFileName = `${timestamp}-${fileName}`;
    const key = `${batchId}/${recordId}/${uniqueFileName}`;

    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: fileContent,
        ContentType: this._getContentType(fileName),
        Metadata: {
          'original-filename': fileName,
          'record-id': recordId,
          'batch-id': batchId,
          'uploaded-at': new Date().toISOString(),
        },
      });

      await this.s3Client.send(command);

      return {
        key,
        fileName,
        size: fileContent.length,
        uploadedAt: new Date().toISOString(),
      };
    } catch (err) {
      console.error('[MinioService] Upload failed:', err);
      throw new Error(`MinIO upload failed: ${err.message}`);
    }
  }

  /**
   * Delete a file from MinIO.
   * @param {string} key - File key (full path)
   * @returns {Promise<void>}
   */
  async deleteFile(key) {
    if (!this.s3Client) {
      throw new Error('MinIO service not configured');
    }

    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.s3Client.send(command);
    } catch (err) {
      console.error('[MinioService] Delete failed:', err);
      throw new Error(`MinIO delete failed: ${err.message}`);
    }
  }

  /**
   * List all files for a record.
   * @param {string} recordId - Record ID
   * @param {string} batchId - Batch ID
   * @returns {Promise<Array>} Array of file objects
   */
  async listFiles(recordId, batchId) {
    if (!this.s3Client) {
      return [];
    }

    try {
      const prefix = `${batchId}/${recordId}/`;
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
      });

      const response = await this.s3Client.send(command);

      if (!response.Contents) return [];

      return response.Contents.map((obj) => ({
        key: obj.Key,
        fileName: obj.Key.split('/').pop(),
        size: obj.Size,
        lastModified: obj.LastModified,
      }));
    } catch (err) {
      console.error('[MinioService] List failed:', err);
      throw new Error(`MinIO list failed: ${err.message}`);
    }
  }

  /**
   * Get a presigned URL for downloading or accessing a file.
   * @param {string} key - File key
   * @returns {Promise<string>} Presigned URL
   */
  async getPresignedUrl(key) {
    if (!this.s3Client) {
      throw new Error('MinIO service not configured');
    }

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const url = await getSignedUrl(this.s3Client, command, {
        expiresIn: 30 * 60, // 30 minutes
      });

      return url;
    } catch (err) {
      console.error('[MinioService] Presigned URL generation failed:', err);
      throw new Error(`MinIO presigned URL failed: ${err.message}`);
    }
  }

  /**
   * Get file content and presigned URL in one call.
   * @param {string} key - File key
   * @returns {Promise<{url: string, fileName: string}>}
   */
  async getFileWithUrl(key) {
    if (!this.s3Client) {
      throw new Error('MinIO service not configured');
    }

    try {
      const url = await this.getPresignedUrl(key);
      const fileName = key.split('/').pop();

      return {
        url,
        fileName,
      };
    } catch (err) {
      console.error('[MinioService] Get file with URL failed:', err);
      throw new Error(`MinIO get file failed: ${err.message}`);
    }
  }

  /**
   * Upload a file to a specific path prefix (folder-based storage).
   * @param {Buffer|Stream} fileContent - File content
   * @param {string} fileName - Original file name
   * @param {string} pathPrefix - Path prefix (e.g., 'claim/attachment/NP001')
   * @param {string} [identifier] - Optional identifier to include in filename (e.g., contractNo, batchId)
   * @param {Object} [metadata] - Optional metadata key-value pairs
   * @returns {Promise<{key: string, fileName: string, size: number, uploadedAt: string}>}
   */
  async uploadFileToPath(fileContent, fileName, pathPrefix, identifier = '', metadata = {}) {
    if (!this.s3Client) {
      throw new Error('MinIO service not configured');
    }

    const timestamp = Date.now();
    const uniqueFileName = identifier
      ? `${timestamp}-${identifier}-${fileName}`
      : `${timestamp}-${fileName}`;
    // Remove trailing slash from prefix if present
    const cleanPrefix = pathPrefix.replace(/\/+$/, '');
    const key = `${cleanPrefix}/${uniqueFileName}`;

    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: fileContent,
        ContentType: this._getContentType(fileName),
        Metadata: {
          'original-filename': fileName,
          'uploaded-at': new Date().toISOString(),
          ...metadata,
        },
      });

      await this.s3Client.send(command);

      return {
        key,
        fileName,
        size: fileContent.length,
        uploadedAt: new Date().toISOString(),
      };
    } catch (err) {
      console.error('[MinioService] Upload to path failed:', err);
      throw new Error(`MinIO upload failed: ${err.message}`);
    }
  }

  /**
   * List all files under an arbitrary path prefix.
   * @param {string} pathPrefix - Path prefix (e.g., 'claim/attachment/NP001')
   * @returns {Promise<Array>} Array of file objects
   */
  async listFilesByPath(pathPrefix) {
    if (!this.s3Client) {
      return [];
    }

    try {
      const prefix = pathPrefix.endsWith('/') ? pathPrefix : `${pathPrefix}/`;
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
      });

      const response = await this.s3Client.send(command);

      if (!response.Contents) return [];

      return response.Contents.map((obj) => ({
        key: obj.Key,
        fileName: obj.Key.split('/').pop(),
        size: obj.Size,
        lastModified: obj.LastModified,
      }));
    } catch (err) {
      console.error('[MinioService] List by path failed:', err);
      throw new Error(`MinIO list failed: ${err.message}`);
    }
  }

  /**
   * Delete all files under a given prefix.
   * @param {string} prefix - Path prefix (e.g., 'master-contract/')
   * @returns {Promise<number>} Number of files deleted
   */
  async deleteAllByPrefix(prefix) {
    if (!this.s3Client) {
      return 0;
    }

    const files = await this.listFilesByPath(prefix);
    let deleted = 0;
    for (const file of files) {
      await this.deleteFile(file.key);
      deleted++;
    }
    return deleted;
  }

  /**
   * Get MIME type from file name.
   * @private
   */
  _getContentType(fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase();
    const mimeTypes = {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      txt: 'text/plain',
      csv: 'text/csv',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }
}

// Export singleton instance
let minioServiceInstance;

export default (() => {
  if (!minioServiceInstance) {
    minioServiceInstance = new MinioService();
  }
  return minioServiceInstance;
})();
