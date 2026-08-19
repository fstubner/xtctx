export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Replace absolute filesystem paths with a placeholder so error text can be
 * returned to an MCP client without disclosing local machine layout.
 */
export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/[A-Za-z]:[\\/][^\s'"`]+/g, "<path>")
    .replace(/(^|[\s'"`(])\/[^\s'"`):]+/g, "$1<path>");
}
