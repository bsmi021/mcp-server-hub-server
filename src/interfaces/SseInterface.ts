import * as http from 'http';
import { URL } from 'url';
import { Server as McpServer, ServerOptions } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Client as McpClient, ClientOptions as McpClientOptions } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'; // To talk to target servers
import { z } from 'zod'; // Import zod for ping schema usage if needed by EmptyResultSchema
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
import { ConfigurationManager } from '../config/ConfigurationManager.js';
import { logger } from '../utils/logger.js';
import { ToolDefinition } from '../types/toolTypes.js';
import { PingRequestSchema } from '../types/commonTypes.js'; // Import shared schema

// Timeout for calling a tool on a target server (can be same as STDIO)
const CALL_TOOL_TIMEOUT_MS = 30000; // 30 seconds

/**
 * Implements the Server-Sent Events (SSE) gateway interface for MCP clients.
 * Listens for HTTP connections and routes requests to managed servers via SSE.
 */
export class SseInterface {
    private toolRegistry: ToolRegistry;
    private serverManager: ServerManager;
    private configManager: ConfigurationManager;
    private httpServer: http.Server | null = null;
    private activeSseTransports: Map<string, SSEServerTransport> = new Map(); // Map sessionId to transport

    constructor(toolRegistry: ToolRegistry, serverManager: ServerManager, configManager: ConfigurationManager) {
        this.toolRegistry = toolRegistry;
        this.serverManager = serverManager;
        this.configManager = configManager;
    }

    /**
     * Starts the HTTP server to listen for SSE connections.
     */
    public async start(): Promise<void> {
        const settings = this.configManager.getGatewaySettings();
        const port = settings.ssePort;
        const host = settings.sseHost ?? 'localhost';
        const ssePath = settings.ssePath ?? '/events'; // Path for SSE connection
        const postPath = '/mcp'; // Path for POSTing messages

        if (!port) {
            logger.warn('SSE interface disabled: ssePort not configured.');
            return;
        }

        if (this.httpServer) {
            logger.warn('SSE HTTP server already running.');
            return;
        }

        this.httpServer = http.createServer(this.handleHttpRequest.bind(this, ssePath, postPath));

        return new Promise((resolve, reject) => {
            this.httpServer?.on('error', (err) => {
                logger.error(`SSE HTTP server error: ${err.message}`);
                this.httpServer = null; // Ensure server is null on error
                reject(err);
            });

            // Correctly place the listen call within the promise executor
            this.httpServer?.listen(port, host, () => {
                logger.info(`MCP Gateway SSE interface listening on http://${host}:${port}${ssePath} (POST to ${postPath})`);
                resolve();
            });
        });
    } // End of start method

    /**
     * Handles incoming HTTP requests, distinguishing between SSE connection requests
     * and POST requests for sending messages.
     */
    private async handleHttpRequest(ssePath: string, postPath: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const requestUrl = new URL(req.url || '', `http://${req.headers.host}`);
        logger.debug(`SSE Interface received request: ${req.method} ${requestUrl.pathname}`);

        // --- Handle SSE Connection Request ---
        if (req.method === 'GET' && requestUrl.pathname === ssePath) {
            if (req.headers.accept !== 'text/event-stream') {
                res.writeHead(400).end('Client must accept text/event-stream');
                return;
            }
            await this.handleSseConnection(req, res, postPath);
            return;
        }

        // --- Handle POST Message Request ---
        if (req.method === 'POST' && requestUrl.pathname === postPath) {
            const sessionId = requestUrl.searchParams.get('sessionId');
            const transport = sessionId ? this.activeSseTransports.get(sessionId) : null;

            if (!transport) {
                logger.warn(`Received POST for unknown or inactive session ID: ${sessionId}`);
                res.writeHead(404).end('Session not found or inactive');
                return;
            }
            // Let the specific transport handle the POSTed message
            await transport.handlePostMessage(req, res);
            return;
        }

        // --- Handle other requests ---
        logger.debug(`SSE Interface received unhandled request: ${req.method} ${requestUrl.pathname}`);
        res.writeHead(404).end('Not Found');
    }

    /**
     * Handles a new SSE connection request.
     */
    private async handleSseConnection(req: http.IncomingMessage, res: http.ServerResponse, postEndpointPath: string): Promise<void> {
        logger.info('New SSE client connection establishing...');

        // Create an MCP Server instance *for this specific connection*
        // It shares the same handlers but uses a unique transport
        const serverInfo = { name: 'mcp-gateway-server-sse-conn', version: '0.1.0' };
        const mcpServer = new McpServer(serverInfo, {}); // Use default options
        this.setupRequestHandlers(mcpServer); // Setup the same handlers

        // Create the SSE transport for this connection
        // The endpoint path needs to be absolute or relative to the gateway host
        const postEndpoint = new URL(postEndpointPath, `http://${req.headers.host}`).toString();
        const transport = new SSEServerTransport(postEndpoint, res);
        const sessionId = transport.sessionId;
        this.activeSseTransports.set(sessionId, transport);
        logger.info(`SSE connection ${sessionId} established. Client should POST to ${postEndpoint}?sessionId=${sessionId}`);

        transport.onclose = () => {
            logger.info(`SSE connection ${sessionId} closed.`);
            this.activeSseTransports.delete(sessionId);
            mcpServer.close().catch(err => logger.warn(`Error closing MCP server for SSE session ${sessionId}: ${err.message}`));
        };
        transport.onerror = (error) => {
            logger.error(`SSE transport error for session ${sessionId}: ${error.message}`);
            // Transport might close itself, or we might need to force removal
            this.activeSseTransports.delete(sessionId);
            mcpServer.close().catch(err => logger.warn(`Error closing MCP server for errored SSE session ${sessionId}: ${err.message}`));
        };

        try {
            // Connect the MCP server instance to this specific transport
            await mcpServer.connect(transport);
            // transport.start() is called internally by mcpServer.connect()
            logger.debug(`MCP Server connected to SSE transport for session ${sessionId}`);
        } catch (error: any) {
            logger.error(`Failed to connect MCP Server to SSE transport for session ${sessionId}: ${error.message}`);
            res.writeHead(500).end('Internal Server Error during connection setup');
            this.activeSseTransports.delete(sessionId);
        }
    }


    /**
     * Sets up handlers for incoming MCP requests for a specific server instance.
     * This is largely the same as the STDIO version but operates on the passed McpServer.
     * @param mcpServer - The McpServer instance for a specific connection.
     */
    private setupRequestHandlers(mcpServer: McpServer): void {
        // --- ListTools Handler ---
        mcpServer.setRequestHandler(ListToolsRequestSchema, async (request) => {
            // Logic is identical to StdioInterface
            logger.debug('SSE: Received ListTools request.');
            const allTools = this.toolRegistry.getAllTools();
            const toolList: { name: string; description?: string; inputSchema?: any }[] = [];
            allTools.forEach(toolDef => {
                toolList.push({
                    name: toolDef.gatewayToolName,
                    description: toolDef.description,
                    inputSchema: toolDef.inputSchema,
                });
            });
            return { tools: toolList };
        });

        // --- CallTool Handler ---
        mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
            // Logic is identical to StdioInterface for finding tool and target server
            const gatewayToolName = request.params.name;
            const toolArgs = request.params.arguments;
            logger.debug(`SSE: Received CallTool request for: ${gatewayToolName}`);

            try {
                // Delegate directly to ToolRegistry, which handles routing and errors
                const result = await this.toolRegistry.callTool(gatewayToolName, toolArgs);
                return result;
            } catch (error: any) {
                logger.error(`SSE: Error processing CallTool request for ${gatewayToolName}: ${error.message}`, error);
                // Re-throw MCP errors directly, wrap others if necessary
                if (error instanceof McpError) {
                    throw error;
                }
                // Convert other errors to InternalError for the client
                throw new McpError(ErrorCode.InternalError, `Failed to execute tool "${gatewayToolName}": ${error.message}`);
            }
        });

        // Handle ping request using the defined schema (same as StdioInterface)
        // This belongs inside setupRequestHandlers
        mcpServer.setRequestHandler(PingRequestSchema, async () => {
            logger.debug('SSE: Received ping request.');
            return EmptyResultSchema.parse({}); // Return validated empty object
        });

        // Error handler for this specific connection's server instance
        mcpServer.onerror = (error) => {
            // Include session ID if possible, though context might be lost here
            logger.error(`[GatewayServer SSE Conn Error] ${error.message}`, error);
        };
    } // End of setupRequestHandlers method


    /**
     * Stops the SSE interface by closing the HTTP server.
     */
    public async stop(): Promise<void> {
        logger.info('Stopping SSE interface...');
        // Close all active SSE transports/connections
        const closePromises: Promise<void>[] = [];
        this.activeSseTransports.forEach(transport => {
            closePromises.push(transport.close().catch(err => logger.warn(`Error closing active SSE transport: ${err.message}`)));
        });
        await Promise.allSettled(closePromises);
        this.activeSseTransports.clear();

        // Close the main HTTP server
        return new Promise((resolve, reject) => {
            if (this.httpServer) {
                this.httpServer.close((err) => {
                    if (err) {
                        logger.error(`Error closing SSE HTTP server: ${err.message}`);
                        reject(err);
                    } else {
                        logger.info('SSE interface stopped.');
                        this.httpServer = null;
                        resolve();
                    }
                });
            } else {
                resolve(); // Already stopped
            }
        });
    }
}
