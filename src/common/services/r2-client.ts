/**
 * Cloudflare R2 Client Service
 *
 * Provides cloud storage for Excel exports via Cloudflare R2 (S3-compatible).
 * Used when results exceed token threshold and need to be exported for download.
 *
 * Key features:
 * - Singleton S3Client for connection reuse
 * - Signed URL generation for secure downloads
 * - Auto-detection of R2 availability via environment variables
 *
 * Required environment variables:
 * - R2_ACCOUNT_ID: Cloudflare account ID
 * - R2_ACCESS_KEY_ID: R2 API token access key
 * - R2_SECRET_ACCESS_KEY: R2 API token secret
 * - R2_BUCKET_NAME: R2 bucket name
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { R2_CONFIG } from '../constants.js';
import { R2UploadResult } from '../types.js';

/**
 * Singleton S3Client instance for R2
 */
let r2Client: S3Client | null = null;

/**
 * Check if R2 is enabled (all required env vars are set)
 *
 * @returns true if R2 is configured and ready to use
 *
 * @example
 * if (isR2Enabled()) {
 *   const result = await uploadToR2(buffer, 'export.xlsx');
 * } else {
 *   // Fall back to local filesystem export
 * }
 */
export function isR2Enabled(): boolean {
  return R2_CONFIG.ENABLED;
}

/**
 * Get or create the R2 S3Client singleton
 *
 * Creates a configured S3Client for Cloudflare R2 on first call.
 * Returns the same instance on subsequent calls for connection reuse.
 *
 * @returns Configured S3Client for R2
 * @throws Error if R2 is not enabled
 *
 * @example
 * const client = getR2Client();
 * await client.send(new PutObjectCommand({ ... }));
 */
export function getR2Client(): S3Client {
  if (!isR2Enabled()) {
    throw new Error(
      'R2 is not enabled. Required environment variables: ' +
      'R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME'
    );
  }

  if (!r2Client) {
    // Cloudflare R2 uses S3-compatible API with custom endpoint
    const endpoint = `https://${R2_CONFIG.ACCOUNT_ID}.r2.cloudflarestorage.com`;

    r2Client = new S3Client({
      region: 'auto', // R2 uses 'auto' region
      endpoint,
      credentials: {
        accessKeyId: R2_CONFIG.ACCESS_KEY_ID,
        secretAccessKey: R2_CONFIG.SECRET_ACCESS_KEY,
      },
    });

    console.error('[R2Client] Initialized S3Client for Cloudflare R2');
  }

  return r2Client;
}

/**
 * Upload a file buffer to R2 and return a signed download URL
 *
 * The file is uploaded to the configured bucket with the specified key.
 * A signed URL is generated for secure, time-limited downloads.
 *
 * @param buffer - File content as Buffer
 * @param filename - Filename for the export (e.g., "nexsus_export_20250103.xlsx")
 * @param contentType - MIME type (default: Excel spreadsheet)
 * @returns R2UploadResult with signed URL and metadata
 *
 * @example
 * const buffer = XLSX.write(workbook, { type: 'buffer' });
 * const result = await uploadToR2(buffer, 'export.xlsx');
 * console.log(result.download_url); // Signed URL valid for 1 hour
 */
export async function uploadToR2(
  buffer: Buffer,
  filename: string,
  contentType: string = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
): Promise<R2UploadResult> {
  const startTime = Date.now();

  try {
    const client = getR2Client();
    const key = `${R2_CONFIG.KEY_PREFIX}${filename}`;

    console.error(`[R2Client] Uploading ${filename} (${buffer.length} bytes) to ${key}`);

    // Upload the file to R2
    const putCommand = new PutObjectCommand({
      Bucket: R2_CONFIG.BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      // Add metadata for tracking
      Metadata: {
        'source': 'nexsus-mcp',
        'uploaded-at': new Date().toISOString(),
      },
    });

    await client.send(putCommand);

    // Generate signed URL for download
    const downloadUrl = await getSignedDownloadUrl(key, R2_CONFIG.URL_EXPIRY_SECONDS);
    const expiresAt = new Date(Date.now() + R2_CONFIG.URL_EXPIRY_SECONDS * 1000).toISOString();

    const duration = Date.now() - startTime;
    console.error(`[R2Client] Upload complete in ${duration}ms. URL expires at ${expiresAt}`);

    return {
      success: true,
      key,
      download_url: downloadUrl,
      expires_at: expiresAt,
      size_bytes: buffer.length,
      content_type: contentType,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[R2Client] Upload failed: ${errorMessage}`);

    return {
      success: false,
      key: '',
      download_url: '',
      expires_at: '',
      size_bytes: 0,
      content_type: contentType,
      error: errorMessage,
    };
  }
}

/**
 * Generate a signed download URL for an existing R2 object
 *
 * Creates a cryptographically signed URL that allows download access
 * for the specified duration. After expiry, the URL becomes invalid.
 *
 * @param key - R2 object key (e.g., "exports/nexsus_export_20250103.xlsx")
 * @param expiresInSeconds - URL validity duration (default: 3600 = 1 hour)
 * @returns Signed URL string
 *
 * @example
 * const url = await getSignedDownloadUrl('exports/my-file.xlsx');
 * // URL is valid for 1 hour
 */
export async function getSignedDownloadUrl(
  key: string,
  expiresInSeconds: number = R2_CONFIG.URL_EXPIRY_SECONDS
): Promise<string> {
  const client = getR2Client();

  const getCommand = new GetObjectCommand({
    Bucket: R2_CONFIG.BUCKET_NAME,
    Key: key,
  });

  const signedUrl = await getSignedUrl(client, getCommand, {
    expiresIn: expiresInSeconds,
  });

  return signedUrl;
}

/**
 * Check if an object exists in R2
 *
 * @param key - R2 object key to check
 * @returns true if object exists, false otherwise
 */
export async function objectExists(key: string): Promise<boolean> {
  try {
    const client = getR2Client();

    const headCommand = new HeadObjectCommand({
      Bucket: R2_CONFIG.BUCKET_NAME,
      Key: key,
    });

    await client.send(headCommand);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a unique filename for export
 *
 * Creates a timestamped filename to avoid collisions.
 *
 * @param prefix - Filename prefix (default: "nexsus_export")
 * @param modelName - Optional model name to include
 * @returns Unique filename with .xlsx extension
 *
 * @example
 * generateExportFilename(); // "nexsus_export_20250103_142533.xlsx"
 * generateExportFilename('report', 'account.move.line'); // "report_account_move_line_20250103_142533.xlsx"
 */
export function generateExportFilename(prefix: string = 'nexsus_export', modelName?: string): string {
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '_')
    .replace(/\..+/, '')
    .slice(0, 15); // Format: YYYYMMDD_HHMMSS

  const sanitizedModel = modelName
    ? `_${modelName.replace(/\./g, '_')}`
    : '';

  return `${prefix}${sanitizedModel}_${timestamp}.xlsx`;
}

/**
 * Get R2 configuration status for diagnostics
 *
 * @returns Configuration status object
 */
export function getR2Status(): {
  enabled: boolean;
  bucket: string;
  urlExpirySeconds: number;
  keyPrefix: string;
} {
  return {
    enabled: isR2Enabled(),
    bucket: R2_CONFIG.BUCKET_NAME,
    urlExpirySeconds: R2_CONFIG.URL_EXPIRY_SECONDS,
    keyPrefix: R2_CONFIG.KEY_PREFIX,
  };
}

// =============================================================================
// JSON AND TEXT STORAGE (for Memory Layer)
// =============================================================================

/**
 * Upload a JSON object to R2
 *
 * @param key - R2 object key
 * @param data - JSON-serializable object
 */
export async function uploadJson<T>(key: string, data: T): Promise<boolean> {
  if (!isR2Enabled()) return false;

  try {
    const client = getR2Client();
    const content = JSON.stringify(data, null, 2);

    const putCommand = new PutObjectCommand({
      Bucket: R2_CONFIG.BUCKET_NAME,
      Key: key,
      Body: content,
      ContentType: 'application/json',
    });

    await client.send(putCommand);
    return true;
  } catch (error) {
    console.error(`[R2Client] JSON upload failed for ${key}:`, error);
    return false;
  }
}

/**
 * Get a JSON object from R2
 *
 * @param key - R2 object key
 * @returns Parsed JSON object or null if not found
 */
export async function getJson<T>(key: string): Promise<T | null> {
  if (!isR2Enabled()) return null;

  try {
    const client = getR2Client();

    const getCommand = new GetObjectCommand({
      Bucket: R2_CONFIG.BUCKET_NAME,
      Key: key,
    });

    const response = await client.send(getCommand);
    const bodyContents = await response.Body?.transformToString();

    if (!bodyContents) return null;
    return JSON.parse(bodyContents) as T;
  } catch (error) {
    // NotFound is expected for cache misses
    const isNotFound = (error as { name?: string })?.name === 'NoSuchKey';
    if (!isNotFound) {
      console.error(`[R2Client] JSON get failed for ${key}:`, error);
    }
    return null;
  }
}

/**
 * Upload text content to R2
 */
export async function uploadText(key: string, content: string): Promise<boolean> {
  if (!isR2Enabled()) return false;

  try {
    const client = getR2Client();

    const putCommand = new PutObjectCommand({
      Bucket: R2_CONFIG.BUCKET_NAME,
      Key: key,
      Body: content,
      ContentType: 'text/plain',
    });

    await client.send(putCommand);
    return true;
  } catch (error) {
    console.error(`[R2Client] Text upload failed for ${key}:`, error);
    return false;
  }
}

/**
 * Get text content from R2
 */
export async function getText(key: string): Promise<string | null> {
  if (!isR2Enabled()) return null;

  try {
    const client = getR2Client();

    const getCommand = new GetObjectCommand({
      Bucket: R2_CONFIG.BUCKET_NAME,
      Key: key,
    });

    const response = await client.send(getCommand);
    return await response.Body?.transformToString() || null;
  } catch {
    return null;
  }
}

/**
 * Append content to a file in R2 (for JSONL logs)
 *
 * Note: This reads the existing content and appends. Not ideal for high-frequency
 * writes, but works for daily log files.
 */
export async function appendToFile(key: string, content: string): Promise<boolean> {
  if (!isR2Enabled()) return false;

  try {
    const existing = await getText(key) || '';
    const newContent = existing + (existing.endsWith('\n') || !existing ? '' : '\n') + content;
    return await uploadText(key, newContent);
  } catch (error) {
    console.error(`[R2Client] Append failed for ${key}:`, error);
    return false;
  }
}
