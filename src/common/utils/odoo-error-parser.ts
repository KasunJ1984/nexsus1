/**
 * Odoo Error Parser
 *
 * Parses Odoo XML-RPC error messages to extract restricted field names.
 * Used for graceful handling of API permission errors during data sync.
 *
 * Supported error patterns:
 * 1. Security restrictions: "The requested operation can not be completed due to
 *    security restrictions... Fields: - field_name (allowed for groups...)"
 * 2. Compute errors: "Compute method failed to assign model(ids,).field_name"
 * 3. Singleton errors: "Expected singleton: model(1, 2, 4, ...)" - Odoo-side bugs
 *    in computed fields that don't properly iterate over recordsets
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Type of Odoo error detected
 *
 * - security_restriction: API permission error
 * - compute_error: Compute method failed (includes field name)
 * - singleton_error: Expected singleton bug (field name NOT in error)
 * - unknown: Unrecognized pattern
 */
export type OdooErrorType = 'security_restriction' | 'compute_error' | 'singleton_error' | 'unknown';

/**
 * Parsed Odoo error with extracted information
 */
export interface OdooSecurityError {
  /** Type of error detected */
  type: OdooErrorType;
  /** Model name if detected from error message */
  model: string | null;
  /** Operation type (read, write, etc.) if detected */
  operation: string | null;
  /** Field names that caused the error */
  restrictedFields: string[];
  /** Original raw error message */
  rawMessage: string;
}

// =============================================================================
// ERROR PARSING
// =============================================================================

/**
 * Parse an Odoo error message to extract restricted field information
 *
 * Handles two main error patterns:
 *
 * **Pattern 1: Security Restriction**
 * ```
 * The requested operation can not be completed due to security restrictions.
 * Document type: Contact (res.partner)
 * Operation: read
 * User: 78
 * Fields:
 * - slide_channel_count (allowed for groups 'eLearning / Officer')
 * - slide_channel_ids (allowed for groups 'eLearning / Officer')
 * ```
 *
 * **Pattern 2: Compute Error**
 * ```
 * ValueError: Compute method failed to assign product.template(6952,).po_ids
 * ```
 *
 * @param errorMessage - The raw error message from Odoo XML-RPC
 * @returns Parsed error with extracted field names
 */
export function parseOdooError(errorMessage: string): OdooSecurityError {
  const result: OdooSecurityError = {
    type: 'unknown',
    model: null,
    operation: null,
    restrictedFields: [],
    rawMessage: errorMessage,
  };

  // Normalize the message (handle newlines in different formats)
  const normalizedMessage = errorMessage.replace(/\\n/g, '\n');

  // Pattern 1: Security restriction with field list
  // Look for "security restrictions" keyword
  if (/security restrictions/i.test(normalizedMessage)) {
    result.type = 'security_restriction';

    // Extract model from "Document type: Contact (res.partner)"
    const modelMatch = normalizedMessage.match(/Document type:\s*[^(]*\(([^)]+)\)/i);
    if (modelMatch) {
      result.model = modelMatch[1].trim();
    }

    // Extract operation from "Operation: read"
    const opMatch = normalizedMessage.match(/Operation:\s*(\w+)/i);
    if (opMatch) {
      result.operation = opMatch[1].toLowerCase();
    }

    // Extract field names from "Fields:" section
    // Fields appear as "- field_name (allowed for groups...)" or "- field_name"
    const fieldsSection = normalizedMessage.match(/Fields:\s*([\s\S]*?)(?:\n\n|$)/i);
    if (fieldsSection) {
      // Match each line starting with "- " followed by field name
      const fieldPattern = /-\s+(\w+)(?:\s*\(|$|\n)/g;
      let match;
      while ((match = fieldPattern.exec(fieldsSection[1])) !== null) {
        const fieldName = match[1];
        if (fieldName && !result.restrictedFields.includes(fieldName)) {
          result.restrictedFields.push(fieldName);
        }
      }
    }

    // Alternative pattern: field names might be listed differently
    // "Field 'field_name' cannot be accessed"
    if (result.restrictedFields.length === 0) {
      const altPattern = /Field\s+['"]?(\w+)['"]?\s+(?:cannot|can not)/gi;
      let match;
      while ((match = altPattern.exec(normalizedMessage)) !== null) {
        const fieldName = match[1];
        if (fieldName && !result.restrictedFields.includes(fieldName)) {
          result.restrictedFields.push(fieldName);
        }
      }
    }

    return result;
  }

  // Pattern 2: Compute error
  // "Compute method failed to assign model(ids,).field_name"
  const computePattern = /Compute method failed to assign\s+([^(]+)\([^)]*\)\.(\w+)/i;
  const computeMatch = normalizedMessage.match(computePattern);
  if (computeMatch) {
    result.type = 'compute_error';
    result.model = computeMatch[1].trim();
    result.restrictedFields.push(computeMatch[2]);
    return result;
  }

  // Alternative compute error pattern
  // "ValueError: ... field 'field_name' cannot be computed"
  const altComputePattern = /field\s+['"]?(\w+)['"]?\s+(?:cannot|can not)\s+be\s+computed/gi;
  let altMatch;
  while ((altMatch = altComputePattern.exec(normalizedMessage)) !== null) {
    if (result.type === 'unknown') {
      result.type = 'compute_error';
    }
    const fieldName = altMatch[1];
    if (fieldName && !result.restrictedFields.includes(fieldName)) {
      result.restrictedFields.push(fieldName);
    }
  }

  // Pattern 3: Access denied patterns
  // "Access Denied by record rules for model 'res.partner'"
  if (/access denied/i.test(normalizedMessage)) {
    result.type = 'security_restriction';

    // Try to extract model
    const accessModelMatch = normalizedMessage.match(/model\s+['"]?([^'"]+)['"]?/i);
    if (accessModelMatch) {
      result.model = accessModelMatch[1].trim();
    }

    // Fields might be listed differently in access denied errors
    const accessFieldPattern = /fields?:\s*\[?([^\]]+)\]?/gi;
    const fieldListMatch = normalizedMessage.match(accessFieldPattern);
    if (fieldListMatch) {
      for (const fieldList of fieldListMatch) {
        // Extract field names from comma-separated list
        const fields = fieldList.replace(/fields?:\s*\[?/gi, '').replace(/\]?$/, '');
        const fieldNames = fields.split(/[,\s]+/).filter(f => /^\w+$/.test(f));
        for (const fieldName of fieldNames) {
          if (!result.restrictedFields.includes(fieldName)) {
            result.restrictedFields.push(fieldName);
          }
        }
      }
    }

    return result;
  }

  // Pattern 4: Singleton error (Odoo-side bug)
  // "ValueError: Expected singleton: res.partner(1, 2, 4, 6, 18, 28, 31, 33, ...)"
  // Note: This error does NOT include the field name - sequential exclusion needed
  const singletonPattern = /Expected singleton:\s*([a-z_]+(?:\.[a-z_]+)*)\s*\(/i;
  const singletonMatch = normalizedMessage.match(singletonPattern);
  if (singletonMatch) {
    result.type = 'singleton_error';
    result.model = singletonMatch[1].trim();
    // Field name is NOT available in singleton errors
    // The caller must use sequential exclusion to find the problematic field
    return result;
  }

  return result;
}

/**
 * Quick check if an error message indicates field restrictions
 *
 * Use this for fast filtering before calling parseOdooError().
 *
 * @param errorMessage - The error message to check
 * @returns true if the error appears to be field-restriction related
 */
export function isFieldRestrictionError(errorMessage: string): boolean {
  // Check for known patterns
  const patterns = [
    /security restrictions/i,
    /Compute method failed/i,
    /cannot be computed/i,
    /access denied/i,
    /permission denied/i,
    /not have.*permission/i,
    /allowed for groups/i,
    /Expected singleton/i,  // Odoo-side bug in computed field
    /'_unknown' object has no attribute/i,  // Deleted record reference
  ];

  return patterns.some(pattern => pattern.test(errorMessage));
}

/**
 * Check if an error is specifically a singleton error (Odoo-side bug)
 *
 * Singleton errors require sequential field exclusion since the error
 * doesn't tell us which field caused it.
 *
 * @param errorMessage - The error message to check
 * @returns true if this is a singleton error
 */
export function isSingletonError(errorMessage: string): boolean {
  return /Expected singleton/i.test(errorMessage);
}

/**
 * Check if error is an unknown/deleted record reference error
 *
 * This happens when a many2one field references a record that was deleted
 * but the reference wasn't cleaned up. Odoo returns '_unknown' as placeholder.
 *
 * @param errorMessage - The error message to check
 * @returns true if this is an unknown reference error
 */
export function isUnknownReferenceError(errorMessage: string): boolean {
  return /'_unknown' object has no attribute/i.test(errorMessage);
}

/**
 * Extract just the field names from an error message
 *
 * Convenience function when you only need the field names.
 *
 * @param errorMessage - The error message to parse
 * @returns Array of restricted field names (empty if none found)
 */
export function extractRestrictedFields(errorMessage: string): string[] {
  const parsed = parseOdooError(errorMessage);
  return parsed.restrictedFields;
}

/**
 * Format a parsed error for logging
 *
 * @param error - Parsed Odoo error
 * @returns Formatted string for logging
 */
export function formatErrorForLog(error: OdooSecurityError): string {
  const parts: string[] = [];

  parts.push(`[${error.type.toUpperCase()}]`);

  if (error.model) {
    parts.push(`Model: ${error.model}`);
  }

  if (error.operation) {
    parts.push(`Operation: ${error.operation}`);
  }

  if (error.restrictedFields.length > 0) {
    parts.push(`Restricted fields: ${error.restrictedFields.join(', ')}`);
  } else {
    parts.push('No fields identified');
  }

  return parts.join(' | ');
}
