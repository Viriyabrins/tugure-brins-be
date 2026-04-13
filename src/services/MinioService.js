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
    const { endpoint, accessKey, secretKey, bucket } = config.minio;

    if (!endpoint || !accessKey || !secretKey || !bucket) {
      console.warn('[MinioService] MinIO configuration incomplete – S3 operations will fail.');
      return;
    }

    this.bucket = bucket;
    this.s3Client = new S3Client({
      region: 'us-east-1',
      endpoint,
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
      forcePathStyle: true,
    });

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
      throw new Error('MinIO service not configured');
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
