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
import { ConfigurationManager } from '../config/ConfigurationManager.js'; // Import ConfigManager

/**
 * Implements the STDIO gateway interface for MCP clients.
 * Listens on stdin/stdout and routes requests to managed servers.
 */
export class StdioInterface {
    private mcpServer: McpServer;
    private toolRegistry: ToolRegistry;
    private serverManager: ServerManager;
    private configManager: ConfigurationManager; // Add configManager property

    constructor(toolRegistry: ToolRegistry, serverManager: ServerManager, configManager: ConfigurationManager) { // Add configManager param
        this.toolRegistry = toolRegistry;
        this.serverManager = serverManager;
        this.configManager = configManager; // Assign configManager

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
            logger.debug(`STDIO: Received CallTool request for: ${gatewayToolName}`);

            // Get config snapshot at the time of request
            const configSnapshot = this.configManager.getCurrentConfig(); // Need to inject configManager

            try {
                // Delegate directly to ToolRegistry, passing the snapshot
                const result = await this.toolRegistry.callTool(gatewayToolName, toolArgs, configSnapshot);
                return result;
            } catch (error: any) {
                logger.error(`STDIO: Error processing CallTool request for ${gatewayToolName}: ${error.message}`, error);
                // Re-throw MCP errors directly, wrap others if necessary
                if (error instanceof McpError) {
                    throw error;
                }
                // Convert other errors to InternalError for the client
                throw new McpError(ErrorCode.InternalError, `Failed to execute tool "${gatewayToolName}": ${error.message}`);
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
