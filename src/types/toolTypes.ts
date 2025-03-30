/**
 * Represents a tool discovered from a managed MCP server,
 * including metadata about its origin and the expected fields
 * from the MCP ToolSchema definition or defined locally in the hub config.
 */
export interface ToolDefinition {
    /**
     * The original name of the tool (without any hub prefix).
     */
    name: string;
    /**
     * The description of the tool.
     */
    description?: string;
    /**
     * The Zod schema defining the input parameters for the tool.
     * Tool modules should export this. For server tools, this might be derived from JSON schema.
     */
    inputSchema?: z.ZodTypeAny; // Use Zod schema type
    /**
     * The fully qualified name for the tool within the gateway,
     * potentially prefixed to avoid collisions if multiple servers/hub
     * offer tools with the same base name (e.g., 'hub__myTool', 'serverA__theirTool').
     */
    gatewayToolName: string;
    /**
     * Indicates if the tool is provided by the hub itself or a managed server.
     */
    isHubTool: boolean;
    /**
     * The unique identifier of the MCP server that provides this tool (only if isHubTool is false).
     */
    serverId?: string; // Made optional, only present for server tools
    /**
     * The actual handler function for the tool (only if isHubTool is true).
     * The signature should align with the expected MCP tool handler signature.
     * We'll use a generic function type for now.
     */
    handler?: (...args: any[]) => Promise<any>; // Only present for hub tools
    /**
     * The path to the module where the handler is defined (only if isHubTool is true).
     * Used for dynamic loading/unloading.
     */
    modulePath?: string; // Only present for hub tools
    /**
     * The name of the exported handler function within the module (only if isHubTool is true).
     */
    handlerExport?: string; // Only present for hub tools
    /**
     * Current enabled status of the tool.
     */
    enabled: boolean;
}

// Re-import z if not already present (might be needed if this file is used independently)
import { z } from 'zod';


/**
 * Type for the listener function used with ToolRegistry change events.
 * Provides the updated map of all tools registered with the gateway.
 */
export type ToolsChangedListener = (allTools: Map<string, ToolDefinition>) => void;
