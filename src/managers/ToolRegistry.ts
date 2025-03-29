import { EventEmitter } from 'events';
import { Client, ClientOptions } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
// Import necessary MCP types for request/response
import {
    ListToolsResultSchema,
    ListToolsResult,
    ToolSchema, // Assuming this is the correct type for tool definition from SDK
    CallToolResult,
    McpError,
    ErrorCode
} from '@modelcontextprotocol/sdk/types.js';
import { ServerManager } from './ServerManager.js';
import { ServerInstance, ServerStatus } from '../types/serverTypes.js';
import { ToolDefinition, ToolsChangedListener } from '../types/toolTypes.js';
import { logger } from '../utils/logger.js';

// Timeout for connecting to a server and listing tools
const DISCOVERY_TIMEOUT_MS = 10000; // 10 seconds

/**
 * Discovers and manages tools available from all connected MCP servers.
 * Listens to ServerManager for status changes and interacts with servers
 * using the MCP client SDK. Emits 'toolsChanged' when the registry updates.
 */
export class ToolRegistry extends EventEmitter {
    private serverManager: ServerManager;
    private tools: Map<string, ToolDefinition> = new Map(); // Keyed by gatewayToolName

    constructor(serverManager: ServerManager) {
        super();
        this.serverManager = serverManager;
        this.serverManager.onServerStatusChange(this.handleServerStatusChange.bind(this));
        logger.info('ToolRegistry initialized and listening to ServerManager.');
    }

    /**
     * Handles status changes from the ServerManager. Triggers tool discovery
     * when a server starts and removal when it stops.
     */
    private async handleServerStatusChange(serverId: string, status: ServerStatus, instance: ServerInstance): Promise<void> {
        logger.debug(`ToolRegistry received status change for ${serverId}: ${status}`);
        switch (status) {
            case 'starting':
                // Attempt discovery once the process is spawned and transport can be created
                // Note: The actual connection and handshake happen after client instantiation
                await this.discoverTools(instance);
                break;
            case 'stopped':
            case 'error':
                // Remove tools associated with this server if it stops or errors
                this.removeToolsForServer(serverId);
                break;
            // Other statuses ('running', 'stopping', 'restarting') don't directly trigger registry changes here
        }
    }

    /**
     * Attempts to connect to a newly started server instance and discover its tools.
     * Updates the server status to 'running' on success, or 'error' on failure.
     * @param instance - The ServerInstance that has just been spawned ('starting' state).
     */
    private async discoverTools(instance: ServerInstance): Promise<void> {
        // We don't need stdin/stdout check here, transport handles process spawning
        logger.info(`Attempting tool discovery for server: ${instance.id}`);
        let client: Client | null = null;
        let transport: StdioClientTransport | null = null;
        // Timeout is handled by client.listTools option now

        try {
            // Create transport parameters based on StdioServerParameters definition
            const transportParams: StdioServerParameters = {
                command: instance.config.command,
                args: instance.config.args,
                env: instance.config.env,
                cwd: instance.config.workingDir,
                // stderr: 'pipe' // Optional: pipe stderr if needed for debugging, default is 'inherit'
            };
            transport = new StdioClientTransport(transportParams);

            // Create Client with metadata. Transport is connected separately.
            const clientMetadata = { name: 'mcp-gateway-client', version: '0.0.1' }; // Placeholder metadata
            // Pass empty options for now, connect transport explicitly later if needed
            const clientOptions: ClientOptions = {};
            client = new Client(clientMetadata, clientOptions);

            // Explicitly connect the transport. The base Protocol class's connect method
            // should handle calling transport.start() and the Client override handles initialization.
            await client.connect(transport);

            logger.debug(`Client connected for ${instance.id}, attempting ListTools.`);

            // List tools with timeout using the helper method
            const response = await client.listTools({}, { timeout: DISCOVERY_TIMEOUT_MS });

            // Validate response structure (basic check)
            if (!response || !Array.isArray(response.tools)) { // Access response.tools directly
                throw new Error('Invalid ListTools response format.');
            }

            // No need to cast response if using helper method and SDK types are correct
            const listToolsResponse = response;

            logger.info(`Discovered ${listToolsResponse.tools.length} tools from server: ${instance.id}`);

            // Register discovered tools
            // Use inline type for toolSchema as ToolSchema from SDK is likely a value
            listToolsResponse.tools.forEach((toolSchema: { name: string; description?: string; inputSchema?: any }) => {
                this.registerTool(instance.id, toolSchema);
            });

            // If discovery is successful, mark the server as 'running'
            this.serverManager.updateStatus(instance.id, 'running');

        } catch (error: any) {
            logger.error(`Tool discovery failed for ${instance.id}: ${error.message}`);
            // Ensure status is marked as error if discovery fails
            // Check if the instance still exists and wasn't stopped during discovery attempt
            const currentInstance = this.serverManager.getServerInstance(instance.id);
            if (currentInstance && currentInstance.status !== 'error' && currentInstance.status !== 'stopped' && currentInstance.status !== 'stopping') {
                this.serverManager.updateStatus(instance.id, 'error');
            }
        } finally {
            // Timeout is handled internally by request, no manual clearing needed
            // Clean up client (which should close the transport)
            if (client) {
                // Corrected: close takes no arguments
                await client.close().catch((err: Error) => logger.warn(`Error closing client for ${instance.id}: ${err.message}`));
            }
            // Transport might be closed implicitly by client.close or process exit
        }
    }

    /**
     * Registers a single tool discovered from a server.
     * Handles potential naming conflicts.
     * @param serverId - The ID of the server providing the tool.
     * @param toolSchema - The tool schema object received from the server.
     */
    // Use inline type as ToolSchema from SDK is likely a value/Zod schema
    private registerTool(serverId: string, toolSchema: { name: string; description?: string; inputSchema?: any }): void {
        const gatewayToolName = this.generateGatewayToolName(serverId, toolSchema.name);

        if (this.tools.has(gatewayToolName)) {
            const existingTool = this.tools.get(gatewayToolName);
            logger.warn(`Tool name conflict: "${gatewayToolName}" from server "${serverId}" conflicts with existing tool from server "${existingTool?.serverId}". Overwriting.`);
            // Simple overwrite strategy for now. Could implement prefixing later.
        }

        // Construct the ToolDefinition using the spread operator and adding gateway-specific fields
        const toolDefinition: ToolDefinition = {
            name: toolSchema.name, // Explicitly map known fields
            description: toolSchema.description,
            inputSchema: toolSchema.inputSchema,
            serverId: serverId,
            gatewayToolName: gatewayToolName,
        };

        this.tools.set(gatewayToolName, toolDefinition);
        logger.debug(`Registered tool: ${gatewayToolName} (from ${serverId})`);
        this.emitToolsChanged();
    }

    /**
     * Generates the unique name for the tool within the gateway context.
     * Currently returns the original name, but could be extended for prefixing.
     * @param serverId - The source server ID.
     * @param originalName - The tool's original name.
     * @returns The namespaced tool name (e.g., "serverId__toolName"), truncated if necessary to meet length limits.
     */
    private generateGatewayToolName(serverId: string, originalName: string): string {
        const separator = '__';
        const totalMaxLength = 60; // Target maximum length

        // Calculate max length for serverId, accounting for separator and originalName
        const maxServerIdLength = totalMaxLength - originalName.length - separator.length;

        let truncatedServerId = serverId;
        if (maxServerIdLength < 1) {
            // Edge case: originalName itself is too long or close to the limit
            logger.warn(`Original tool name "${originalName}" is too long (${originalName.length}) for namespacing within ${totalMaxLength} chars. Using truncated name.`);
            // Truncate the original name itself if it exceeds the total limit minus separator
            const maxOriginalNameLength = totalMaxLength - separator.length - 1; // Need at least 1 char for serverId prefix
            const truncatedOriginalName = originalName.substring(0, maxOriginalNameLength > 0 ? maxOriginalNameLength : 0);
            // Use a minimal prefix like 's' if serverId needs to be drastically cut
            return `s${separator}${truncatedOriginalName}`;
        }

        if (serverId.length > maxServerIdLength) {
            truncatedServerId = serverId.substring(0, maxServerIdLength);
            logger.warn(`Server ID "${serverId}" truncated to "${truncatedServerId}" for tool "${originalName}" to meet length limit.`);
        }

        // Combine truncated serverId, separator, and originalName
        return `${truncatedServerId}${separator}${originalName}`;
    }

    /**
     * Removes all tools associated with a specific server ID from the registry.
     * @param serverId - The ID of the server whose tools should be removed.
     */
    private removeToolsForServer(serverId: string): void {
        let changed = false;
        const toolsToRemove: string[] = [];
        for (const [gatewayToolName, toolDef] of this.tools.entries()) {
            if (toolDef.serverId === serverId) {
                toolsToRemove.push(gatewayToolName);
                changed = true;
            }
        }

        if (changed) {
            toolsToRemove.forEach(name => this.tools.delete(name));
            logger.info(`Removed ${toolsToRemove.length} tools for stopped/errored server: ${serverId}`);
            this.emitToolsChanged();
        }
    }

    /**
     * Emits the 'toolsChanged' event with the current tool map.
     */
    private emitToolsChanged(): void {
        // Emit with a copy to prevent external modification
        this.emit('toolsChanged', new Map(this.tools));
    }

    /**
     * Gets the definition for a specific tool by its gateway name.
     * @param gatewayToolName - The unique name of the tool within the gateway.
     * @returns The ToolDefinition or undefined if not found.
     */
    public getTool(gatewayToolName: string): ToolDefinition | undefined {
        return this.tools.get(gatewayToolName);
    }

    /**
     * Gets a map of all currently registered tools.
     * @returns A Map where keys are gateway tool names and values are ToolDefinition objects.
     */
    public getAllTools(): Map<string, ToolDefinition> {
        // Return a shallow copy
        return new Map(this.tools);
    }

    /**
     * Lists all tools currently available through the gateway, formatted for MCP clients.
     * Tool names are namespaced with their server ID.
     * @returns A promise resolving to a ListToolsResult object.
     */
    public async listTools(): Promise<ListToolsResult> {
        // Define the expected structure for each tool in the result array
        // Define the expected structure for each tool in the result array
        // Aligning with SDK's ListToolsResult which seems to require inputSchema
        type McpToolSchema = {
            name: string;
            description?: string;
            inputSchema: any; // Make required, provide default if missing
        };
        const mcpTools: McpToolSchema[] = [];
        for (const toolDef of this.tools.values()) {
            // Only list tools from currently 'running' servers? Or list all discovered?
            // Let's list all discovered for now, client can check status separately if needed.
            mcpTools.push({
                name: toolDef.gatewayToolName, // Use the namespaced name
                description: toolDef.description,
                // Provide default empty object if inputSchema is missing/undefined
                inputSchema: toolDef.inputSchema ?? {},
            });
        }
        // Ensure the result conforms to the SDK schema type
        const result: ListToolsResult = { tools: mcpTools };
        // Validate against Zod schema if available/needed
        // ListToolsResultSchema.parse(result);
        return result;
    }

    /**
     * Calls a tool on the appropriate underlying MCP server.
     * @param gatewayToolName - The namespaced tool name (e.g., "serverId.toolName").
     * @param args - The arguments for the tool.
     * @returns A promise resolving to the tool's result.
     * @throws McpError if the tool is not found, the server is not running, or the call fails.
     */
    public async callTool(gatewayToolName: string, args: any): Promise<CallToolResult> {
        const toolDef = this.getTool(gatewayToolName);
        if (!toolDef) {
            throw new McpError(ErrorCode.MethodNotFound, `Tool "${gatewayToolName}" not found.`);
        }

        const serverId = toolDef.serverId;
        const originalToolName = toolDef.name;
        const serverInstance = this.serverManager.getServerInstance(serverId);

        if (!serverInstance) {
            // Should not happen if toolDef exists, but good practice to check
            throw new McpError(ErrorCode.InternalError, `Server instance "${serverId}" not found for tool "${gatewayToolName}".`);
        }

        // Check if the target server is actually running
        if (serverInstance.status !== 'running') {
            // Use InternalError as ServerError doesn't seem to exist in standard ErrorCode
            throw new McpError(ErrorCode.InternalError, `Server "${serverId}" is not running (status: ${serverInstance.status}). Cannot call tool "${gatewayToolName}".`);
        }

        // --- Connect to the target server and call the tool ---
        // This involves creating a temporary client connection for each call.
        // Optimization: Could potentially pool/reuse client connections if performance becomes an issue.
        let client: Client | null = null;
        let transport: StdioClientTransport | null = null;
        const callTimeout = DISCOVERY_TIMEOUT_MS; // Reuse discovery timeout for calls for now

        try {
            const transportParams: StdioServerParameters = {
                command: serverInstance.config.command,
                args: serverInstance.config.args,
                env: serverInstance.config.env,
                cwd: serverInstance.config.workingDir,
            };
            transport = new StdioClientTransport(transportParams);

            const clientMetadata = { name: 'mcp-gateway-tool-caller', version: '0.0.1' };
            client = new Client(clientMetadata, {});

            await client.connect(transport);
            logger.debug(`Temporary client connected to ${serverId} to call tool ${originalToolName}`);

            // Call the tool using the original name - remove timeout option
            const result = await client.callTool({ name: originalToolName, arguments: args });

            // Explicitly cast result assuming runtime structure matches CallToolResult
            return result as CallToolResult;

        } catch (error: any) {
            logger.error(`Error calling tool "${originalToolName}" on server "${serverId}" (Gateway Tool: ${gatewayToolName}): ${error.message}`);
            // Re-throw MCP errors directly, wrap others
            if (error instanceof McpError) {
                throw error;
            } else {
                // Use InternalError here as well
                throw new McpError(ErrorCode.InternalError, `Failed to call tool "${gatewayToolName}": ${error.message}`);
            }
        } finally {
            // Ensure temporary client is closed
            if (client) {
                await client.close().catch((err: Error) => logger.warn(`Error closing temporary client for ${serverId}: ${err.message}`));
            }
        }
    }


    /**
    * Registers a listener for tool registry change events.
    * @param listener - The function to call when the tool registry changes.
    */
    public onToolsChanged(listener: ToolsChangedListener): void {
        this.on('toolsChanged', listener);
    }

    /**
     * Removes a listener for tool registry change events.
     * @param listener - The listener function to remove.
     */
    public offToolsChanged(listener: ToolsChangedListener): void {
        this.off('toolsChanged', listener);
    }
}
