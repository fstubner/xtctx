/**
 * AutoTagger interface for enriching context records with metadata.
 * Provides methods to extract file references, domain tags, and environment info.
 */
export interface AutoTagger {
  /**
   * Extract file references mentioned in the given text.
   * Returns an array of file paths found in the text.
   */
  getFileReferences(text: string): Promise<string[]>;

  /**
   * Get environment information (e.g., version, runtime, configuration).
   * Returns an object with environment metadata.
   */
  getEnvironment(): Promise<Record<string, unknown>>;

  /**
   * Classify the text into domain tags based on keywords and context.
   * Returns an array of domain tags that apply to the text.
   */
  getDomainTags(text: string): string[];
}
