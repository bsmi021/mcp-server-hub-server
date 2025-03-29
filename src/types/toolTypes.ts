/**
 * Represents a tool discovered from a managed MCP server,
 * including metadata about its origin and the expected fields
 * from the MCP ToolSchema definition.
 */
export interface ToolDefinition {
    /**
     * The original name of the tool as defined by the source server.
     */
    name: string;
    /**
     * The description of the tool provided by the source server.
     */
    description?: string; // Optional based on MCP spec? Assume optional for flexibility
    /**
     * The JSON schema defining the input parameters for the tool.
     * Use 'any' for now, but could be refined to a specific JSON schema type if needed.
     */
    inputSchema?: any; // Replace 'any' with a proper JSONSchema type if available/needed
    /**
     * The unique identifier of the MCP server that provides this tool.
     */
    serverId: string;
    /**
     * The fully qualified name for the tool within the gateway,
     * potentially prefixed to avoid collisions if multiple servers
     * offer tools with the same base name.
     * (Example: 'serverA_getWeather', 'serverB_getWeather')
     * Note: For simplicity, initial implementation might not prefix
     * and just log warnings on conflict.
     */
    gatewayToolName: string;
}

/**
 * Type for the listener function used with ToolRegistry change events.
 * Provides the updated map of all tools registered with the gateway.
 */
export type ToolsChangedListener = (allTools: Map<string, ToolDefinition>) => void;
