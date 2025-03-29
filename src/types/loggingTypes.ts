/**
 * Defines the possible log levels for the application logger.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * Defines the structure for log entries, especially when capturing server output.
 */
export interface LogEntry {
    timestamp: Date;
    level: LogLevel;
    message: string;
    serverId?: string; // Identifier for the source MCP server if applicable
    isErrorOutput?: boolean; // Flag for STDERR output from servers
    // Optional additional metadata
    [key: string]: any;
}
