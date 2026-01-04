/**
 * File Export Service
 *
 * Generates Excel files from nexsus_search results.
 * Part of Token Limitation handling (Stage 4).
 *
 * Features:
 * - Creates Excel workbooks with Data and Reconciliation sheets
 * - Auto-generates timestamped filenames
 * - Calculates appropriate column widths
 * - Handles both aggregation and record retrieval results
 * - Supports Cloudflare R2 cloud storage for remote access (claude.ai)
 * - Buffer-based export for memory-efficient processing
 *
 * @module services/file-export
 */

import XLSX from 'xlsx';
import { mkdirSync, existsSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { EXPORT_CONFIG } from '../constants.js';
import { isR2Enabled, uploadToR2, generateExportFilename as generateR2Filename } from './r2-client.js';
import type {
  FileExportResult,
  ExcelSheetData,
  ExcelExportRequest,
  AggregationResult,
  ScrollResult,
  R2UploadResult,
} from '../types.js';

// =============================================================================
// EXPORT OPTIONS
// =============================================================================

/**
 * Options for controlling export behavior
 *
 * Controls whether to use R2 cloud storage or local filesystem.
 * R2 is preferred when available for claude.ai compatibility.
 */
export interface ExportOptions {
  /**
   * Force local filesystem export even if R2 is available.
   * Useful for CLI usage where local files are preferred.
   * @default false
   */
  forceLocal?: boolean;

  /**
   * Explicitly request R2 upload (requires R2 to be configured).
   * If R2 is not available, falls back to local export.
   * @default auto-detect based on R2_CONFIG.ENABLED
   */
  useR2?: boolean;

  /**
   * Custom filename prefix (overrides default "nexsus_export")
   */
  filenamePrefix?: string;

  /**
   * Whether this export was auto-triggered by token threshold
   * (affects response messaging)
   */
  autoTriggered?: boolean;

  /**
   * Reason for auto-trigger (for display in response)
   */
  autoTriggerReason?: string;
}

// =============================================================================
// DIRECTORY MANAGEMENT
// =============================================================================

/**
 * Ensure export directory exists
 *
 * Creates data/exports/ directory if it doesn't exist.
 * Uses recursive mkdir for nested paths.
 *
 * @returns Full path to export directory
 */
export function ensureExportDir(): string {
  const exportDir = resolve(process.cwd(), EXPORT_CONFIG.EXPORT_DIR);

  if (!existsSync(exportDir)) {
    mkdirSync(exportDir, { recursive: true });
    console.error(`[FileExport] Created export directory: ${exportDir}`);
  }

  return exportDir;
}

// =============================================================================
// FILENAME GENERATION
// =============================================================================

/**
 * Generate timestamped filename
 *
 * Creates filename in format: nexsus_export_crm_lead_20250115_143022.xlsx
 *
 * @param modelName - Odoo model name (e.g., "crm.lead")
 * @param prefix - Optional custom prefix
 * @returns Sanitized filename with timestamp and extension
 */
export function generateExportFilename(
  modelName: string,
  prefix?: string
): string {
  const basePrefix = prefix || EXPORT_CONFIG.DEFAULT_PREFIX;

  // Sanitize model name (replace . with _)
  const sanitizedModel = modelName.replace(/\./g, '_');

  // Generate timestamp: YYYYMMDD_HHmmss
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '_',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');

  // Combine and truncate if needed
  let filename = `${basePrefix}_${sanitizedModel}_${timestamp}`;
  if (filename.length > EXPORT_CONFIG.MAX_FILENAME_LENGTH) {
    filename = filename.substring(0, EXPORT_CONFIG.MAX_FILENAME_LENGTH);
  }

  return `${filename}.xlsx`;
}

// =============================================================================
// EXCEL WORKBOOK CREATION
// =============================================================================

/**
 * Create Excel workbook from export request
 *
 * Builds a multi-sheet workbook with proper formatting.
 *
 * @param request - Export request with sheets and metadata
 * @returns XLSX workbook object
 */
function createWorkbook(request: ExcelExportRequest): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();

  // Add each sheet
  for (const sheetData of request.sheets) {
    if (sheetData.rows.length === 0) continue;

    // Convert rows to worksheet
    const worksheet = XLSX.utils.json_to_sheet(sheetData.rows);

    // Set column widths
    const columnWidths = calculateColumnWidths(sheetData.rows);
    worksheet['!cols'] = columnWidths;

    // Truncate sheet name to Excel's 31-char limit
    const sheetName = sheetData.name.substring(0, EXPORT_CONFIG.SHEET_NAME.MAX_LENGTH);

    // Add to workbook
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  }

  return workbook;
}

/**
 * Calculate appropriate column widths based on content
 *
 * Examines first 100 rows to determine optimal width for each column.
 *
 * @param rows - Data rows to analyze
 * @returns Array of column width objects for xlsx
 */
function calculateColumnWidths(
  rows: Array<Record<string, unknown>>
): Array<{ wch: number }> {
  if (rows.length === 0) return [];

  // Get all column names from first row
  const columns = Object.keys(rows[0]);
  const widths: Array<{ wch: number }> = [];

  for (const col of columns) {
    // Start with header length
    let maxWidth = col.length;

    // Sample first 100 rows for content width
    const sampleSize = Math.min(rows.length, 100);
    for (let i = 0; i < sampleSize; i++) {
      const value = rows[i][col];
      if (value !== null && value !== undefined) {
        const strValue = String(value);
        maxWidth = Math.max(maxWidth, strValue.length);
      }
    }

    // Apply limits
    const width = Math.min(
      Math.max(maxWidth + 2, EXPORT_CONFIG.COLUMN_WIDTHS.DEFAULT),
      EXPORT_CONFIG.COLUMN_WIDTHS.MAX
    );

    widths.push({ wch: width });
  }

  return widths;
}

// =============================================================================
// BUFFER EXPORT (Core Building Block)
// =============================================================================

/**
 * Create Excel workbook as Buffer (memory-based export)
 *
 * This is the core building block for both local and R2 exports.
 * Creates the workbook in memory without writing to filesystem.
 *
 * @param request - Export request with sheets and metadata
 * @returns Buffer containing the Excel file
 *
 * @example
 * const buffer = createWorkbookBuffer(request);
 * // For R2: await uploadToR2(buffer, filename);
 * // For local: writeFileSync(path, buffer);
 */
export function createWorkbookBuffer(request: ExcelExportRequest): Buffer {
  const workbook = createWorkbook(request);

  // Write to buffer instead of file
  // Type 'buffer' returns a Node.js Buffer
  const buffer = XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
    compression: true, // Enable compression for smaller file size
  }) as Buffer;

  console.error(`[FileExport] Created workbook buffer: ${buffer.length} bytes`);

  return buffer;
}

/**
 * Determine if R2 should be used for export
 *
 * Decision logic:
 * 1. If forceLocal=true, always use local
 * 2. If useR2=true explicitly, use R2 if available
 * 3. Otherwise, auto-detect based on R2_CONFIG.ENABLED
 *
 * @param options - Export options
 * @returns true if R2 should be used
 */
export function shouldUseR2(options?: ExportOptions): boolean {
  // Force local takes priority
  if (options?.forceLocal) {
    return false;
  }

  // Explicit useR2 request
  if (options?.useR2 === true) {
    return isR2Enabled();
  }

  // Auto-detect: use R2 if available
  return isR2Enabled();
}

/**
 * Export buffer to R2 cloud storage
 *
 * Uploads the Excel buffer to Cloudflare R2 and returns a signed download URL.
 * Falls back to local export if R2 upload fails.
 *
 * @param buffer - Excel file as Buffer
 * @param filename - Filename for the export
 * @param metadata - Query metadata for result
 * @param dataRows - Number of data rows (for result)
 * @param options - Export options
 * @returns FileExportResult with download URL
 */
async function exportBufferToR2(
  buffer: Buffer,
  filename: string,
  metadata: { model_name: string; filters_summary: string; query_time_ms: number },
  dataRows: number,
  options?: ExportOptions
): Promise<FileExportResult> {
  const startTime = Date.now();

  try {
    console.error(`[FileExport] Uploading ${filename} to R2...`);

    const r2Result: R2UploadResult = await uploadToR2(buffer, filename);

    if (!r2Result.success) {
      console.error(`[FileExport] R2 upload failed: ${r2Result.error}, falling back to local`);
      // Fallback to local export
      return await exportBufferToLocal(buffer, filename, metadata, dataRows, options);
    }

    const exportTime = Date.now() - startTime;
    console.error(`[FileExport] R2 upload complete in ${exportTime}ms`);

    return {
      success: true,
      file_path: '', // No local path for R2 exports
      filename,
      file_size_bytes: buffer.length,
      data_rows: dataRows,
      sheet_count: 2,
      export_time_ms: exportTime,
      query_summary: `${metadata.model_name}: ${metadata.filters_summary}`,
      // R2-specific fields
      download_url: r2Result.download_url,
      url_expires_at: r2Result.expires_at,
      storage_type: 'r2',
      r2_key: r2Result.key,
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[FileExport] R2 export error: ${errorMsg}, falling back to local`);

    // Fallback to local export on any error
    return await exportBufferToLocal(buffer, filename, metadata, dataRows, options);
  }
}

/**
 * Export buffer to local filesystem
 *
 * Writes the Excel buffer to the local data/exports/ directory.
 *
 * @param buffer - Excel file as Buffer
 * @param filename - Filename for the export
 * @param metadata - Query metadata for result
 * @param dataRows - Number of data rows (for result)
 * @param options - Export options (unused, for signature compatibility)
 * @returns FileExportResult with file path
 */
async function exportBufferToLocal(
  buffer: Buffer,
  filename: string,
  metadata: { model_name: string; filters_summary: string; query_time_ms: number },
  dataRows: number,
  options?: ExportOptions
): Promise<FileExportResult> {
  const startTime = Date.now();

  try {
    // Ensure export directory exists
    const exportDir = ensureExportDir();
    const filePath = join(exportDir, filename);

    // Write buffer to file
    writeFileSync(filePath, buffer);

    // Get file stats
    const stats = statSync(filePath);
    const exportTime = Date.now() - startTime;

    console.error(`[FileExport] Local export complete: ${filePath} (${exportTime}ms)`);

    return {
      success: true,
      file_path: filePath,
      filename,
      file_size_bytes: stats.size,
      data_rows: dataRows,
      sheet_count: 2,
      export_time_ms: exportTime,
      query_summary: `${metadata.model_name}: ${metadata.filters_summary}`,
      storage_type: 'local',
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[FileExport] Local export failed: ${errorMsg}`);

    return {
      success: false,
      file_path: '',
      filename: '',
      file_size_bytes: 0,
      data_rows: 0,
      sheet_count: 0,
      export_time_ms: Date.now() - startTime,
      query_summary: `${metadata.model_name}: ${metadata.filters_summary}`,
      error: errorMsg,
      storage_type: 'local',
    };
  }
}

// =============================================================================
// AGGREGATION EXPORT
// =============================================================================

/**
 * Export aggregation results to Excel
 *
 * Creates workbook with:
 * - Data sheet: All groups with aggregated values
 * - Reconciliation sheet: Checksums and totals
 *
 * Supports both local filesystem and R2 cloud storage.
 * R2 is used automatically when configured (for claude.ai compatibility).
 *
 * @param result - Aggregation result from aggregation-engine
 * @param metadata - Query metadata for reconciliation
 * @param options - Export options (forceLocal, useR2, etc.)
 * @returns Export result with file path or download URL
 */
export async function exportAggregationToExcel(
  result: AggregationResult,
  metadata: {
    model_name: string;
    filters_summary: string;
    query_time_ms: number;
    aggregations: Array<{ field: string; op: string; alias: string }>;
    group_by?: string[];
  },
  options?: ExportOptions
): Promise<FileExportResult> {
  const startTime = Date.now();

  try {
    // Generate filename
    const prefix = options?.filenamePrefix || EXPORT_CONFIG.DEFAULT_PREFIX;
    const filename = generateExportFilename(metadata.model_name, prefix);

    // Build data sheet rows
    const dataRows: Array<Record<string, unknown>> = [];

    if (result.groups && result.groups.length > 0) {
      // Grouped aggregation - each group becomes a row
      for (const group of result.groups) {
        const row: Record<string, unknown> = {
          ...group.key,
          ...group.values,
        };
        dataRows.push(row);
      }
    } else {
      // Simple aggregation - single row with results
      dataRows.push(result.results);
    }

    // Build reconciliation sheet
    const reconRows: Array<Record<string, unknown>> = [];
    reconRows.push({
      Field: 'Model',
      Value: metadata.model_name,
    });
    reconRows.push({
      Field: 'Filters',
      Value: metadata.filters_summary,
    });
    reconRows.push({
      Field: 'Total Records Processed',
      Value: result.totalRecords,
    });
    reconRows.push({
      Field: 'Groups',
      Value: result.groups?.length ?? 1,
    });
    reconRows.push({
      Field: 'Query Time (ms)',
      Value: metadata.query_time_ms,
    });
    reconRows.push({
      Field: 'Export Time',
      Value: new Date().toISOString(),
    });

    // Add auto-trigger info if applicable
    if (options?.autoTriggered) {
      reconRows.push({ Field: '---', Value: '---' });
      reconRows.push({
        Field: 'Auto-Triggered',
        Value: 'Yes',
      });
      if (options.autoTriggerReason) {
        reconRows.push({
          Field: 'Trigger Reason',
          Value: options.autoTriggerReason,
        });
      }
    }

    // Add reconciliation checksum if available
    if (result.reconciliation) {
      reconRows.push({ Field: '---', Value: '---' });
      reconRows.push({
        Field: 'Reconciliation Hash',
        Value: result.reconciliation.hash,
      });
      reconRows.push({
        Field: 'Grand Total',
        Value: result.reconciliation.grand_total,
      });
      reconRows.push({
        Field: 'Aggregation Field',
        Value: result.reconciliation.aggregation_field,
      });
      reconRows.push({
        Field: 'Record Count',
        Value: result.reconciliation.record_count,
      });
    }

    // Create export request
    const request: ExcelExportRequest = {
      sheets: [
        {
          name: EXPORT_CONFIG.SHEET_NAME.DATA_SHEET,
          rows: dataRows,
        },
        {
          name: EXPORT_CONFIG.SHEET_NAME.RECONCILIATION_SHEET,
          rows: reconRows,
        },
      ],
      filename,
      metadata: {
        model_name: metadata.model_name,
        filters_summary: metadata.filters_summary,
        query_time_ms: metadata.query_time_ms,
        reconciliation: result.reconciliation,
      },
    };

    // Create workbook buffer (memory-based)
    const buffer = createWorkbookBuffer(request);

    // Route to R2 or local based on options and availability
    if (shouldUseR2(options)) {
      console.error(`[FileExport] Using R2 for aggregation export`);
      return await exportBufferToR2(buffer, filename, metadata, dataRows.length, options);
    } else {
      console.error(`[FileExport] Using local filesystem for aggregation export`);
      return await exportBufferToLocal(buffer, filename, metadata, dataRows.length, options);
    }

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[FileExport] Export failed: ${errorMsg}`);

    return {
      success: false,
      file_path: '',
      filename: '',
      file_size_bytes: 0,
      data_rows: 0,
      sheet_count: 0,
      export_time_ms: Date.now() - startTime,
      query_summary: `${metadata.model_name}: ${metadata.filters_summary}`,
      error: errorMsg,
    };
  }
}

// =============================================================================
// RECORD RETRIEVAL EXPORT
// =============================================================================

/**
 * Export record retrieval results to Excel
 *
 * Creates workbook with:
 * - Data sheet: All records as rows
 * - Reconciliation sheet: Query metadata
 *
 * Supports both local filesystem and R2 cloud storage.
 * R2 is used automatically when configured (for claude.ai compatibility).
 *
 * @param result - Scroll result from scroll-engine
 * @param metadata - Query metadata
 * @param options - Export options (forceLocal, useR2, etc.)
 * @returns Export result with file path or download URL
 */
export async function exportRecordsToExcel(
  result: ScrollResult,
  metadata: {
    model_name: string;
    filters_summary: string;
    query_time_ms: number;
    fields?: string[];
  },
  options?: ExportOptions
): Promise<FileExportResult> {
  const startTime = Date.now();

  try {
    // Generate filename
    const prefix = options?.filenamePrefix || EXPORT_CONFIG.DEFAULT_PREFIX;
    const filename = generateExportFilename(metadata.model_name, prefix);

    // Build data sheet rows (records are already Record<string, unknown>[])
    const dataRows = result.records;

    // Build reconciliation sheet
    const reconRows: Array<Record<string, unknown>> = [];
    reconRows.push({
      Field: 'Model',
      Value: metadata.model_name,
    });
    reconRows.push({
      Field: 'Filters',
      Value: metadata.filters_summary,
    });
    reconRows.push({
      Field: 'Records Returned',
      Value: result.records.length,
    });
    reconRows.push({
      Field: 'Total Scanned',
      Value: result.totalScanned,
    });
    reconRows.push({
      Field: 'Has More',
      Value: result.hasMore ? 'Yes' : 'No',
    });
    reconRows.push({
      Field: 'Query Time (ms)',
      Value: metadata.query_time_ms,
    });
    reconRows.push({
      Field: 'Export Time',
      Value: new Date().toISOString(),
    });

    if (metadata.fields && metadata.fields.length > 0) {
      reconRows.push({
        Field: 'Requested Fields',
        Value: metadata.fields.join(', '),
      });
    }

    // Add auto-trigger info if applicable
    if (options?.autoTriggered) {
      reconRows.push({ Field: '---', Value: '---' });
      reconRows.push({
        Field: 'Auto-Triggered',
        Value: 'Yes',
      });
      if (options.autoTriggerReason) {
        reconRows.push({
          Field: 'Trigger Reason',
          Value: options.autoTriggerReason,
        });
      }
    }

    // Create export request
    const request: ExcelExportRequest = {
      sheets: [
        {
          name: EXPORT_CONFIG.SHEET_NAME.DATA_SHEET,
          rows: dataRows,
        },
        {
          name: EXPORT_CONFIG.SHEET_NAME.RECONCILIATION_SHEET,
          rows: reconRows,
        },
      ],
      filename,
      metadata: {
        model_name: metadata.model_name,
        filters_summary: metadata.filters_summary,
        query_time_ms: metadata.query_time_ms,
      },
    };

    // Create workbook buffer (memory-based)
    const buffer = createWorkbookBuffer(request);

    // Route to R2 or local based on options and availability
    if (shouldUseR2(options)) {
      console.error(`[FileExport] Using R2 for records export`);
      return await exportBufferToR2(buffer, filename, metadata, dataRows.length, options);
    } else {
      console.error(`[FileExport] Using local filesystem for records export`);
      return await exportBufferToLocal(buffer, filename, metadata, dataRows.length, options);
    }

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[FileExport] Export failed: ${errorMsg}`);

    return {
      success: false,
      file_path: '',
      filename: '',
      file_size_bytes: 0,
      data_rows: 0,
      sheet_count: 0,
      export_time_ms: Date.now() - startTime,
      query_summary: `${metadata.model_name}: ${metadata.filters_summary}`,
      error: errorMsg,
    };
  }
}

// =============================================================================
// FORMATTING HELPERS
// =============================================================================

/**
 * Format export result for MCP response
 *
 * Generates user-friendly markdown response when export is successful.
 * Handles both local filesystem and R2 cloud storage exports.
 *
 * @param result - Export result
 * @param options - Export options (for auto-trigger messaging)
 * @returns Formatted markdown string
 */
export function formatExportResponse(
  result: FileExportResult,
  options?: ExportOptions
): string {
  const lines: string[] = [];

  if (result.success) {
    // Header varies based on auto-trigger status
    if (options?.autoTriggered) {
      lines.push('# Export Complete (Auto-Triggered)');
      lines.push('');
      if (options.autoTriggerReason) {
        lines.push(`**Reason:** ${options.autoTriggerReason}`);
      }
    } else {
      lines.push('# Export Complete');
    }
    lines.push('');

    // File info
    lines.push(`**File:** \`${result.filename}\``);

    // R2 vs Local specific output
    if (result.storage_type === 'r2' && result.download_url) {
      // R2 cloud export - show download URL
      lines.push(`**Download:** [Click here to download](${result.download_url})`);
      lines.push('');

      // Show expiry warning
      if (result.url_expires_at) {
        const expiresAt = new Date(result.url_expires_at);
        const now = new Date();
        const minutesRemaining = Math.round((expiresAt.getTime() - now.getTime()) / 60000);
        lines.push(`> **Link expires in ${minutesRemaining} minutes** (at ${expiresAt.toLocaleTimeString()})`);
        lines.push('');
      }
    } else {
      // Local filesystem export - show path
      lines.push(`**Path:** \`${result.file_path}\``);
    }

    // Common metadata
    lines.push(`**Size:** ${formatBytes(result.file_size_bytes)}`);
    lines.push(`**Data Rows:** ${result.data_rows.toLocaleString()}`);
    lines.push(`**Sheets:** ${result.sheet_count}`);
    lines.push(`**Export Time:** ${result.export_time_ms}ms`);
    lines.push('');

    // Query summary
    lines.push('## Query Summary');
    lines.push(`\`${result.query_summary}\``);
    lines.push('');
    lines.push('---');

    // Footer varies based on storage type
    if (result.storage_type === 'r2') {
      lines.push('*Excel file uploaded to cloud storage with Data and Reconciliation sheets.*');
    } else {
      lines.push('*Excel file saved with Data and Reconciliation sheets.*');
    }

  } else {
    // Export failed
    lines.push('# Export Failed');
    lines.push('');
    lines.push(`**Error:** ${result.error}`);
    lines.push('');
    lines.push('## Query Summary');
    lines.push(`\`${result.query_summary}\``);
  }

  return lines.join('\n');
}

/**
 * Format bytes to human-readable size
 *
 * @param bytes - Number of bytes
 * @returns Human readable string (e.g., "45.2 KB")
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
