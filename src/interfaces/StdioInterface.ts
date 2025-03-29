import { Server as McpServer, ServerOptions } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client as McpClient, ClientOptions as McpClientOptions } from '@modelcontextprotocol/sdk/client/index.js';
// Correct StdioClientTransport import based on provided SDK source
import { StdioClientTransport, StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod'; // Import zod for creating ping schema
import {
    CallToolRequestSchema,
    // CallToolResultSchema, // Remove - rely on inferred type from callTool helper
    ErrorCode,
    ListToolsRequestSchema,
    // ListToolsResultSchema, // Remove - rely on inferred type from listTools helper
    McpError,
    Request, // Keep Request if needed for generic types, otherwise remove
    // ToolSchema, // Remove - use inline type or inferred type
    EmptyResultSchema, // Import for ping result validation
} from '@modelcontextprotocol/sdk/types.js';
import { ToolRegistry } from '../managers/ToolRegistry.js';
import { ServerManager } from '../managers/ServerManager.js';
import { logger } from '../utils/logger.js';
import { ToolDefinition } from '../types/toolTypes.js';
import { PingRequestSchema } from '../types/commonTypes.js'; // Import shared schema

// Timeout for calling a tool on a target server
const CALL_TOOL_TIMEOUT_MS = 30000; // 30 seconds

/**
 * Implements the STDIO gateway interface for MCP clients.
 * Listens on stdin/stdout and routes requests to managed servers.
 */
export class StdioInterface {
    private mcpServer: McpServer;
    private toolRegistry: ToolRegistry;
    private serverManager: ServerManager;

    constructor(toolRegistry: ToolRegistry, serverManager: ServerManager) {
        this.toolRegistry = toolRegistry;
        this.serverManager = serverManager;

        const serverOptions: ServerOptions = {
            // Explicitly enable the 'tools' capability for this server instance
            capabilities: {
                tools: {} // Empty object signifies capability is enabled
            }
        };
        // Metadata for the gateway server itself
        const serverInfo = { name: 'mcp-gateway-server', version: '0.1.0' };

        this.mcpServer = new McpServer(serverInfo, serverOptions);
        this.setupRequestHandlers();
    }

    /**
     * Sets up handlers for incoming MCP requests (ListTools, CallTool).
     */
    private setupRequestHandlers(): void {
        // --- ListTools Handler ---
        // Use the SDK schema constant
        this.mcpServer.setRequestHandler(ListToolsRequestSchema, async (request) => {
            logger.debug('Received ListTools request from client.');
            const allTools = this.toolRegistry.getAllTools();
            // Define the expected structure for the response tools inline
            const toolList: { name: string; description?: string; inputSchema?: any }[] = [];

            allTools.forEach(toolDef => {
                // Map ToolDefinition back to the expected tool structure for the response
                toolList.push({
                    name: toolDef.gatewayToolName, // Use the gateway-unique name
                    description: toolDef.description,
                    inputSchema: toolDef.inputSchema,
                });
            });

            logger.debug(`Responding with ${toolList.length} tools.`);
            // Return the object directly, matching the expected structure (inferred type)
            return { tools: toolList };
        });

        // --- CallTool Handler ---
        // Use the SDK schema constant
        this.mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
            const gatewayToolName = request.params.name;
            const toolArgs = request.params.arguments;
            logger.debug(`Received CallTool request for: ${gatewayToolName}`);

            const toolDef = this.toolRegistry.getTool(gatewayToolName);
            if (!toolDef) {
                logger.warn(`Tool not found: ${gatewayToolName}`);
                throw new McpError(ErrorCode.MethodNotFound, `Tool '${gatewayToolName}' not found.`);
            }

            const targetServerId = toolDef.serverId;
            const targetServerInstance = this.serverManager.getServerInstance(targetServerId);

            if (!targetServerInstance || targetServerInstance.status !== 'running' || !targetServerInstance.process) {
                logger.error(`Target server ${targetServerId} for tool ${gatewayToolName} is not running or process is missing.`);
                throw new McpError(ErrorCode.InternalError, `Target server '${targetServerId}' is not available.`);
            }

            // --- Forward request to target server ---
            let targetClient: McpClient | null = null;
            let targetTransport: StdioClientTransport | null = null;
            try {
                // Create transport parameters based on StdioServerParameters definition
                const transportParams: StdioServerParameters = {
                    command: targetServerInstance.config.command,
                    args: targetServerInstance.config.args,
                    env: targetServerInstance.config.env,
                    cwd: targetServerInstance.config.workingDir,
                };
                targetTransport = new StdioClientTransport(transportParams);

                // Create Client with metadata and empty options
                const clientMetadata = { name: 'mcp-gateway-stdio-fwd', version: '0.0.1' };
                targetClient = new McpClient(clientMetadata, {}); // Pass empty options

                // Explicitly connect the transport. This triggers initialization.
                await targetClient.connect(targetTransport);

                logger.debug(`Forwarding CallTool request for '${toolDef.name}' to server ${targetServerId}`);

                // Use the original tool name when calling the target server
                // Use the client's helper method callTool
                const targetResponse = await targetClient.callTool(
                    { name: toolDef.name, arguments: toolArgs },
                    undefined, // Pass undefined for resultSchema to use default
                    { timeout: CALL_TOOL_TIMEOUT_MS }
                );

                logger.debug(`Received response from target server ${targetServerId} for ${gatewayToolName}`);
                // Return the response directly. Type safety relies on SDK callTool helper return type.
                return targetResponse;

            } catch (error: any) {
                logger.error(`Error forwarding CallTool request to ${targetServerId}: ${error.message}`, error); // Log the full error
                if (error instanceof McpError) {
                    throw error; // Re-throw MCP errors directly
                }
                // Map other errors to InternalError
                throw new McpError(ErrorCode.InternalError, `Failed to call tool on target server: ${error.message}`);
            } finally {
                // Clean up the temporary client connection to the target server
                if (targetClient) {
                    // Corrected: close takes no arguments
                    await targetClient.close().catch(err => logger.warn(`Error closing target client for ${targetServerId}: ${err.message}`));
                }
            }
        });

        // Handle ping request using the defined schema
        this.mcpServer.setRequestHandler(PingRequestSchema, async () => {
            logger.debug('Received ping request.');
            // Validate result against EmptyResultSchema if needed, or just return {}
            return EmptyResultSchema.parse({}); // Return validated empty object
        });

        // Error handler for the gateway server itself
        this.mcpServer.onerror = (error) => {
            logger.error(`[GatewayServer Error] ${error.message}`, error);
        };
    }

    /**
     * Starts the STDIO interface, listening for client connections.
     */
    public async start(): Promise<void> {
        try {
            const transport = new StdioServerTransport();
            // The connect method starts listening on the transport
            await this.mcpServer.connect(transport);
            logger.info('MCP Gateway Server listening on STDIO.');
        } catch (error: any) {
            logger.error(`Failed to start STDIO interface: ${error.message}`);
            throw error; // Propagate error to main server startup
        }
    }

    /**
     * Stops the STDIO interface.
     */
    public async stop(): Promise<void> {
        logger.info('Stopping STDIO interface...');
        await this.mcpServer.close();
        logger.info('STDIO interface stopped.');
    }
}
