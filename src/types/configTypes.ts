/**
 * Defines the structure for the main configuration object loaded from the JSON file.
 */
export interface Config {
    /**
     * A map where keys are unique server identifiers (strings) and values
     * are the configuration objects for each MCP server to be managed.
     */
    mcpServers: {
        [serverId: string]: ServerConfig;
    };
    /**
     * Optional settings specific to the MCP Gateway Server itself.
     */
    settings?: GatewaySettings;
}

/**
 * Defines the configuration for a single MCP server instance managed by the gateway.
 */
export interface ServerConfig {
    /**
     * The command or executable to run to start the server (e.g., 'node', 'python', '/path/to/executable').
     */
    command: string;
    /**
     * An optional array of string arguments to pass to the command.
     */
    args?: string[];
    /**
     * An optional map of environment variables (key-value pairs) to set for the server process.
     * Supports basic environment variable substitution using ${VAR_NAME} syntax.
     */
    env?: Record<string, string>;
    /**
     * An optional working directory path where the server command should be executed.
     * If not provided, defaults to the gateway's working directory.
     */
    workingDir?: string;
    /**
     * Optional flag indicating whether the gateway should automatically restart
     * this server if it crashes or exits unexpectedly. Defaults to false.
     */
    autoRestart?: boolean;
    /**
     * Optional maximum number of restart attempts within a short time frame
     * if autoRestart is true. Helps prevent rapid restart loops. Defaults to 3.
     */
    maxRestarts?: number; // Consider adding a time window for this later
}

/**
 * Defines optional settings for the MCP Gateway Server.
 */
export interface GatewaySettings {
    /**
     * The port number on which the gateway should listen for Server-Sent Events (SSE) connections.
     * Required if SSE interface is enabled.
     */
    ssePort?: number;
    /**
     * The host address for the SSE server. Defaults to 'localhost'.
     */
    sseHost?: string;
    /**
     * The path for the SSE endpoint. Defaults to '/events'.
     */
    ssePath?: string;
    /**
     * The port number on which the gateway should listen for WebSocket connections.
     * Required if WebSocket interface is enabled.
     */
    wsPort?: number;
    /**
     * The minimum log level for the gateway's logger.
     * Options: 'error', 'warn', 'info', 'debug'. Defaults to 'info'.
     */
    logLevel?: 'error' | 'warn' | 'info' | 'debug';
}

/**
 * Represents the result of configuration validation.
 */
export interface ValidationResult {
    isValid: boolean;
    errors: string[]; // List of validation error messages
}
