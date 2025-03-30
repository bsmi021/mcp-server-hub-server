import { EventEmitter } from 'events';
import { Client, ClientOptions } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod'; // Import Zod
// Import necessary MCP types for request/response
import {
    ListToolsResult,
    Tool, // Use the Tool type from SDK for server tool schemas
    CallToolResult,
    McpError,
    ErrorCode
} from '@modelcontextprotocol/sdk/types.js';
import { ServerManager } from './ServerManager.js';
import { ServerInstance, ServerStatus } from '../types/serverTypes.js';
import { ToolDefinition, ToolsChangedListener } from '../types/toolTypes.js';
import { ConfigurationManager } from '../config/ConfigurationManager.js'; // Import ConfigManager
import { Config, HubToolConfig } from '../types/configTypes.js'; // Import Config types
import { logger } from '../utils/logger.js';
import * as path from 'path'; // Needed for dynamic imports
import { zodToJsonSchema } from 'zod-to-json-schema'; // Import the converter

// Timeout for connecting to a server and listing/calling tools
const DISCOVERY_TIMEOUT_MS = 10000; // 10 seconds
const CALL_TIMEOUT_MS = 15000; // 15 seconds for tool calls

/**
 * Discovers, manages, and routes calls for tools available from connected MCP servers
 * and tools defined dynamically in the hub's configuration.
 * Listens to ServerManager for server status changes.
 * Listens to ConfigurationManager for hub tool configuration changes.
 * Emits 'toolsChanged' when the registry updates.
 */
export class ToolRegistry extends EventEmitter {
    private serverManager: ServerManager;
    private configManager: ConfigurationManager;
    private tools: Map<string, ToolDefinition> = new Map(); // Keyed by gatewayToolName

    // Store loaded hub tool modules to allow for potential unloading/reloading
    private hubToolModules: Map<string, any> = new Map();

    constructor(serverManager: ServerManager, configManager: ConfigurationManager) {
        super();
        this.serverManager = serverManager;
        this.configManager = configManager;

        // Listen for server status changes to discover/remove server tools
        this.serverManager.onServerStatusChange(this.handleServerStatusChange.bind(this));

        // Listen for config changes to update hub tools
        this.configManager.on('configChanged', this.handleConfigChange.bind(this));

        // Process initial hub tools config after ensuring config is loaded
        // We rely on the main server initialization sequence to call loadConfig first.
        // A slight delay might occur if config loads after registry construction,
        // but handleConfigChange will eventually sync it.
        // Alternatively, pass the initial config here if available.
        const initialConfig = this.configManager.getCurrentConfig(); // Use the new getter
        if (initialConfig) {
            this.processHubToolsConfig(initialConfig);
        } else {
            logger.warn('Initial config not available during ToolRegistry construction. Hub tools will be processed on first config change.');
        }

        logger.info('ToolRegistry initialized and listening to ServerManager and ConfigurationManager.');
    }

    /**
    * Handles configuration changes from the ConfigurationManager.
    * Specifically processes changes to the 'hubTools' section.
    */
    private handleConfigChange({ newConfig }: { newConfig: Config }): void {
        logger.info('Configuration changed, reprocessing hub tools...');
        // Use Promise.resolve to handle async operation without awaiting here
        Promise.resolve(this.processHubToolsConfig(newConfig)).catch(err => {
            logger.error(`Error processing hub tools config change: ${err.message}`);
        });
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
        logger.info(`Attempting tool discovery for server: ${instance.id}`);
        let client: Client | null = null;
        let transport: StdioClientTransport | null = null;

        try {
            const transportParams: StdioServerParameters = {
                command: instance.config.command,
                args: instance.config.args,
                env: instance.config.env,
                cwd: instance.config.workingDir,
            };
            transport = new StdioClientTransport(transportParams);
            const clientMetadata = { name: 'mcp-gateway-client', version: '0.0.1' };
            const clientOptions: ClientOptions = {};
            client = new Client(clientMetadata, clientOptions);

            await client.connect(transport);
            logger.debug(`Client connected for ${instance.id}, attempting ListTools.`);

            const response = await client.listTools({}, { timeout: DISCOVERY_TIMEOUT_MS });

            if (!response || !Array.isArray(response.tools)) {
                throw new Error('Invalid ListTools response format.');
            }

            const listToolsResponse = response;
            logger.info(`Discovered ${listToolsResponse.tools.length} tools from server: ${instance.id}`);

            listToolsResponse.tools.forEach((toolSchema: Tool) => {
                this.registerServerTool(instance.id, toolSchema);
            });

            this.serverManager.updateStatus(instance.id, 'running');

        } catch (error: any) {
            logger.error(`Tool discovery failed for ${instance.id}: ${error.message}`);
            const currentInstance = this.serverManager.getServerInstance(instance.id);
            if (currentInstance && currentInstance.status !== 'error' && currentInstance.status !== 'stopped' && currentInstance.status !== 'stopping') {
                this.serverManager.updateStatus(instance.id, 'error');
            }
        } finally {
            if (client) {
                await client.close().catch((err: Error) => logger.warn(`Error closing client for ${instance.id}: ${err.message}`));
            }
        }
    }

    /**
     * Registers a single tool discovered from a managed MCP server.
     * @param serverId - The ID of the server providing the tool.
     * @param toolSchema - The tool schema object received from the server (MCP Tool type).
     */
    private registerServerTool(serverId: string, toolSchema: Tool): void {
        const gatewayToolName = this.generateServerGatewayToolName(serverId, toolSchema.name);
        const existingTool = this.tools.get(gatewayToolName);

        if (existingTool) {
            const conflictSource = existingTool.isHubTool ? 'hub' : `server "${existingTool.serverId}"`;
            logger.warn(`Server tool name conflict: "${gatewayToolName}" from server "${serverId}" conflicts with existing tool from ${conflictSource}. Overwriting.`);
        }

        const toolDefinition: ToolDefinition = {
            name: toolSchema.name,
            description: toolSchema.description,
            // Store the raw JSON schema; conversion to Zod is complex for dynamic schemas
            inputSchema: toolSchema.inputSchema as any,
            serverId: serverId,
            gatewayToolName: gatewayToolName,
            isHubTool: false,
            enabled: true,
        };

        this.tools.set(gatewayToolName, toolDefinition);
        logger.debug(`Registered server tool: ${gatewayToolName} (from ${serverId})`);
        this.emitToolsChanged();
    }

    // --- Hub Tool Management ---

    /**
     * Processes the hubTools section of the configuration, loading, unloading,
     * or updating tools as necessary.
     * @param config - The current hub configuration.
     */
    private async processHubToolsConfig(config: Config | null): Promise<void> {
        if (!config) return;

        const hubToolsConfig = config.hubTools || {};
        const currentHubToolNames = new Set<string>();
        let registryChanged = false;

        // Use Promise.all to handle async loading concurrently
        const processingPromises = Object.entries(hubToolsConfig).map(async ([toolName, toolConfig]) => {
            const gatewayToolName = this.generateHubGatewayToolName(toolName);
            currentHubToolNames.add(gatewayToolName);
            const existingTool = this.tools.get(gatewayToolName);

            if (toolConfig.enabled) {
                let needsLoad = false;
                if (!existingTool || !existingTool.isHubTool) {
                    needsLoad = true; // New or replacing server tool
                } else if (
                    existingTool.modulePath !== toolConfig.modulePath ||
                    existingTool.handlerExport !== toolConfig.handlerExport ||
                    existingTool.description !== toolConfig.description ||
                    !existingTool.enabled // Was previously disabled
                ) {
                    logger.info(`Hub tool "${toolName}" configuration changed, attempting reload...`);
                    this.unloadHubTool(gatewayToolName); // Unload old first
                    needsLoad = true;
                } else if (!existingTool.enabled) { // Only enabled status changed
                    existingTool.enabled = true;
                    logger.info(`Hub tool "${toolName}" (${gatewayToolName}) re-enabled.`);
                    registryChanged = true; // Mark change
                }

                if (needsLoad) {
                    if (await this.loadAndRegisterHubTool(toolName, gatewayToolName, toolConfig)) {
                        registryChanged = true; // Mark change
                    }
                }
            } else { // Tool is configured but disabled
                if (existingTool?.isHubTool && existingTool.enabled) {
                    existingTool.enabled = false;
                    // Consider unloading module here if desired: this.unloadHubTool(gatewayToolName);
                    logger.info(`Hub tool "${toolName}" (${gatewayToolName}) disabled via configuration.`);
                    registryChanged = true; // Mark change
                } else if (existingTool && !existingTool.isHubTool) {
                    logger.warn(`Hub tool config for "${toolName}" is disabled, but a conflicting tool from server "${existingTool.serverId}" exists. Server tool remains active.`);
                }
            }
        });

        await Promise.all(processingPromises);

        // Unload hub tools that are no longer in the configuration
        const toolsToRemove: string[] = [];
        for (const [gatewayToolName, toolDef] of this.tools.entries()) {
            if (toolDef.isHubTool && !currentHubToolNames.has(gatewayToolName)) {
                toolsToRemove.push(gatewayToolName);
                registryChanged = true; // Mark change
            }
        }
        toolsToRemove.forEach(gatewayToolName => {
            const toolName = this.tools.get(gatewayToolName)?.name;
            this.unloadHubTool(gatewayToolName);
            this.tools.delete(gatewayToolName); // Remove from registry
            logger.info(`Unloaded and removed hub tool "${toolName}" (${gatewayToolName}) as it was removed from config.`);
        });

        if (registryChanged) {
            this.emitToolsChanged();
        }
    }

    /**
     * Dynamically loads a hub tool module and registers the tool.
     * @param toolName Original tool name from config.
     * @param gatewayToolName Namespaced tool name.
     * @param toolConfig Configuration for the tool.
     * @returns True if successful, false otherwise.
     */
    private async loadAndRegisterHubTool(toolName: string, gatewayToolName: string, toolConfig: HubToolConfig): Promise<boolean> {
        // Resolve module path relative to project root (where node runs from) or dist folder
        const moduleFullPath = path.resolve(process.cwd(), 'dist', 'tools', toolConfig.modulePath);
        logger.debug(`Attempting to load hub tool module: ${moduleFullPath}`);

        try {
            // Cache busting for dynamic import
            const moduleWithCacheBust = `${moduleFullPath}?t=${Date.now()}`;
            const toolModule = await import(moduleWithCacheBust);
            const handler = toolModule[toolConfig.handlerExport || 'default'];

            if (typeof handler !== 'function') {
                throw new Error(`Handler export "${toolConfig.handlerExport || 'default'}" not found or not a function in module ${moduleFullPath}`);
            }

            // Convention: Assume module exports 'inputSchema' (a Zod schema)
            const inputSchema = toolModule.inputSchema instanceof z.ZodType ? toolModule.inputSchema : undefined;
            if (!inputSchema) {
                logger.warn(`Hub tool "${toolName}" module ${toolConfig.modulePath} does not export 'inputSchema' or it's not a Zod schema. Input validation will not be performed.`);
            }

            const toolDefinition: ToolDefinition = {
                name: toolName,
                gatewayToolName: gatewayToolName,
                description: toolConfig.description,
                inputSchema: inputSchema, // Store Zod schema if found
                isHubTool: true,
                handler: handler,
                modulePath: toolConfig.modulePath,
                handlerExport: toolConfig.handlerExport,
                enabled: true,
            };

            this.tools.set(gatewayToolName, toolDefinition);
            this.hubToolModules.set(gatewayToolName, toolModule);
            logger.info(`Successfully loaded and registered hub tool: ${gatewayToolName}`);
            return true;

        } catch (error: any) {
            logger.error(`Failed to load hub tool "${toolName}" from ${moduleFullPath}: ${error.message}`);
            if (this.tools.has(gatewayToolName)) {
                this.tools.delete(gatewayToolName);
            }
            return false;
        }
    }

    /**
    * Unloads resources associated with a hub tool.
    * Currently just removes from internal maps. Cache invalidation is handled by import cache busting.
    * @param gatewayToolName The namespaced name of the tool to unload.
    */
    private unloadHubTool(gatewayToolName: string): void {
        const toolDef = this.tools.get(gatewayToolName);
        if (toolDef?.isHubTool) {
            logger.debug(`Unloading hub tool: ${gatewayToolName}`);
            this.hubToolModules.delete(gatewayToolName);
            // The tool definition itself is removed by the caller (processHubToolsConfig)
        }
    }

    // --- Tool Name Generation ---

    /**
     * Generates the unique name for a server tool within the gateway context.
     * @param serverId - The source server ID.
     * @param originalName - The tool's original name.
     * @returns The namespaced tool name (e.g., "serverId__toolName").
     */
    private generateServerGatewayToolName(serverId: string, originalName: string): string {
        return `${serverId}__${originalName}`;
    }

    /**
    * Generates the unique name for a hub tool within the gateway context.
    * @param originalName - The tool's original name from config.
    * @returns The namespaced tool name (e.g., "hub__toolName").
    */
    private generateHubGatewayToolName(originalName: string): string {
        return `hub__${originalName}`;
    }

    /**
     * Removes all tools associated with a specific server ID from the registry.
     * Only removes tools where isHubTool is false.
     * @param serverId - The ID of the server whose tools should be removed.
     */
    private removeToolsForServer(serverId: string): void {
        let changed = false;
        const toolsToRemove: string[] = [];
        for (const [gatewayToolName, toolDef] of this.tools.entries()) {
            if (!toolDef.isHubTool && toolDef.serverId === serverId) {
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
     * Gets a map of all currently registered tools (both server and hub tools).
     * @returns A Map where keys are gateway tool names and values are ToolDefinition objects.
     */
    public getAllTools(): Map<string, ToolDefinition> {
        return new Map(this.tools);
    }

    /**
     * Lists all enabled tools currently available through the gateway, formatted for MCP clients.
     * Tool names are namespaced (e.g., "hub__toolName", "serverId__toolName").
     * @returns A promise resolving to a ListToolsResult object.
     */
    public async listTools(): Promise<ListToolsResult> {
        const mcpTools: Tool[] = [];
        for (const toolDef of this.tools.values()) {
            if (toolDef.enabled) {
                let jsonInputSchema: any = { type: 'object' }; // Default empty schema
                if (toolDef.inputSchema instanceof z.ZodType) {
                    try {
                        // Convert Zod schema to JSON schema
                        // Ensure the output conforms to the expected structure (basic JSON Schema object)
                        jsonInputSchema = zodToJsonSchema(toolDef.inputSchema, {
                            target: 'jsonSchema7', // Specify target schema version if needed
                            $refStrategy: 'none' // Avoid refs for simplicity, or configure as needed
                        });
                        // Remove the top-level $schema if present, as it might not be desired in MCP ToolSchema
                        if (jsonInputSchema.$schema) {
                            delete jsonInputSchema.$schema;
                        }
                        logger.debug(`Converted Zod schema to JSON schema for hub tool ${toolDef.gatewayToolName}.`);
                    } catch (e: unknown) {
                        const errorMessage = e instanceof Error ? e.message : String(e);
                        logger.error(`Failed to convert Zod schema to JSON schema for tool ${toolDef.gatewayToolName}: ${errorMessage}`);
                        // Keep default empty schema on error
                    }
                } else if (toolDef.inputSchema) {
                    // Assume it's already a JSON schema (from server tool)
                    jsonInputSchema = toolDef.inputSchema;
                }

                mcpTools.push({
                    name: toolDef.gatewayToolName,
                    description: toolDef.description,
                    inputSchema: jsonInputSchema,
                });
            }
        }
        const result: ListToolsResult = { tools: mcpTools };
        return result;
    }

    /**
     * Calls a tool, routing to either a hub tool handler or the appropriate managed server.
     * @param gatewayToolName - The namespaced tool name (e.g., "hub__toolName", "serverId__toolName").
     * @param args - The arguments for the tool.
     * @param configSnapshot - An optional snapshot of the configuration at the time the request was received.
     * @returns A promise resolving to the tool's result.
     * @throws McpError if the tool is not found, disabled, the target server is not running, or the call fails.
     */
    public async callTool(gatewayToolName: string, args: any, configSnapshot?: Config | null): Promise<CallToolResult> {
        // Use the provided snapshot if available, otherwise use the registry's current config
        // Note: this.configManager.getCurrentConfig() could also be used, but snapshot ensures request isolation.
        const currentConfig = configSnapshot ?? this.configManager.getCurrentConfig();
        const toolDef = this.getTool(gatewayToolName);

        if (!toolDef) {
            throw new McpError(ErrorCode.MethodNotFound, `Tool "${gatewayToolName}" not found.`);
        }
        if (!toolDef.enabled) {
            throw new McpError(ErrorCode.MethodNotFound, `Tool "${gatewayToolName}" is currently disabled.`);
        }

        if (toolDef.isHubTool) {
            // --- Call Hub Tool ---
            if (!toolDef.handler) {
                throw new McpError(ErrorCode.InternalError, `Hub tool "${gatewayToolName}" has no handler loaded.`);
            }
            logger.debug(`Calling hub tool: ${gatewayToolName}`);
            try {
                let validatedArgs = args;
                if (toolDef.inputSchema instanceof z.ZodType) {
                    const parseResult = toolDef.inputSchema.safeParse(args);
                    if (!parseResult.success) {
                        throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for tool ${gatewayToolName}: ${parseResult.error.message}`);
                    }
                    validatedArgs = parseResult.data;
                } else if (toolDef.inputSchema) {
                    logger.warn(`Input schema for hub tool ${gatewayToolName} is not a Zod schema. Skipping validation.`);
                }

                // Pass validated args and the relevant config snapshot to the handler
                // TODO: Update handler signature definition in toolTypes.ts if handlers need config access
                const result = await toolDef.handler(validatedArgs, { config: currentConfig }); // Pass config in 'extra' object? Or separate arg?
                // Ensure result conforms to CallToolResult structure
                if (typeof result === 'object' && result !== null && Array.isArray(result.content)) {
                    return result as CallToolResult;
                } else {
                    logger.warn(`Hub tool "${gatewayToolName}" returned unexpected format. Wrapping as text.`);
                    return { content: [{ type: 'text', text: String(result) }] };
                }
            } catch (error: any) {
                logger.error(`Error executing hub tool "${gatewayToolName}": ${error.message}`);
                if (error instanceof McpError) { // Re-throw specific MCP errors (like InvalidParams from validation)
                    throw error;
                }
                // Wrap other errors
                return {
                    content: [{ type: 'text', text: `Error executing hub tool: ${error.message}` }],
                    isError: true
                };
            }

        } else {
            // --- Call Server Tool ---
            const serverId = toolDef.serverId;
            const originalToolName = toolDef.name;
            if (!serverId) {
                throw new McpError(ErrorCode.InternalError, `Server ID missing for server tool "${gatewayToolName}".`);
            }
            const serverInstance = this.serverManager.getServerInstance(serverId);

            if (!serverInstance) {
                throw new McpError(ErrorCode.InternalError, `Server instance "${serverId}" not found for tool "${gatewayToolName}".`);
            }
            if (serverInstance.status !== 'running') {
                throw new McpError(ErrorCode.InternalError, `Server "${serverId}" is not running (status: ${serverInstance.status}). Cannot call tool "${gatewayToolName}".`);
            }

            let client: Client | null = null;
            let transport: StdioClientTransport | null = null;

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

                // Call the tool using the original name (removed unsupported timeout option)
                const result = await client.callTool({ name: originalToolName, arguments: args });
                return result as CallToolResult;

            } catch (error: any) {
                logger.error(`Error calling tool "${originalToolName}" on server "${serverId}" (Gateway Tool: ${gatewayToolName}): ${error.message}`);
                if (error instanceof McpError) { throw error; }
                throw new McpError(ErrorCode.InternalError, `Failed to call tool "${gatewayToolName}": ${error.message}`);
            } finally {
                if (client) {
                    await client.close().catch((err: Error) => logger.warn(`Error closing temporary client for ${serverId}: ${err.message}`));
                }
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
