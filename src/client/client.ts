import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { Server as McpServer, ServerOptions } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    McpError,
    ErrorCode,
    Request,
    // Response, // Not exported from SDK types?
    // ErrorResponse, // Not exported from SDK types?
    ListToolsResult,
    CallToolResult
} from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js'; // Assuming shared logger for now
import { WebSocketManager } from './managers/WebSocketManager.js';
import { RequestManager } from './managers/RequestManager.js';
import { ToolManager } from './managers/ToolManager.js';
import { EventManager } from './managers/EventManager.js';
import { McpErrorHandler } from './lib/ErrorHandler.js';

// --- Configuration ---
const GATEWAY_SERVER_URL = process.env.GATEWAY_WS_URL || 'ws://localhost:8081'; // Allow overriding WS URL
const DEFAULT_POLLING_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const rawInterval = process.env.CLIENT_TOOL_REFRESH_INTERVAL_MS;
const POLLING_INTERVAL_MS = rawInterval && /^\d+$/.test(rawInterval) ? parseInt(rawInterval, 10) : DEFAULT_POLLING_INTERVAL_MS;

// --- Types for WebSocket Communication ---
// Reusing types defined in WebSocketInterface might be better if possible,
// but defining them here for clarity for now.
interface WebSocketMessage {
    id: string;
    type: 'request' | 'response' | 'event';
    payload: any;
}

interface ResponsePayload {
    result?: any;
    error?: { code: number; message: string; data?: any };
}

interface EventPayload {
    eventType: string;
    data: any;
}

/**
 * Gateway Client Application
 * - Connects to the main Gateway Server via WebSocket.
 * - Listens for LLM Client connections via STDIO.
 * - Proxies MCP requests between LLM Clients and the Gateway Server.
 * - Polls the Gateway Server for tool list updates.
 */
class GatewayClient {
    // Managers
    private webSocketManager: WebSocketManager;
    private requestManager: RequestManager;
    private toolManager: ToolManager;
    private eventManager: EventManager;

    // STDIO Proxy Server
    private mcpServer: McpServer;

    // TODO: Make reconnectInterval configurable and pass to WebSocketManager constructor
    private reconnectInterval = 5000;

    constructor() {
        // Instantiate Managers
        this.eventManager = new EventManager();
        this.webSocketManager = new WebSocketManager(GATEWAY_SERVER_URL, this.reconnectInterval);
        this.requestManager = new RequestManager(this.webSocketManager);
        // Pass requestManager to ToolManager
        this.toolManager = new ToolManager(POLLING_INTERVAL_MS, this.requestManager);

        // Initialize the MCP Server part that listens to LLM clients via STDIO
        const serverOptions: ServerOptions = {
            capabilities: {
                tools: {}, // This client *proxies* tools, so it needs the capability

                // Add other capabilities if proxying resources, etc.
            }
        };
        const serverInfo = { name: 'mcp-gateway-client-proxy', version: '0.1.0' };
        this.mcpServer = new McpServer(serverInfo, serverOptions);
        this.setupStdioRequestHandlers(); // Needs update to use requestManager
        this.setupManagerEventHandlers();

        // Initialize WebSocket connection via manager
        this.webSocketManager.connect();
    }

    /**
     * Sets up handlers for events emitted by the managers.
     */
    private setupManagerEventHandlers(): void {
        this.webSocketManager.on('open', () => {
            logger.info('[GatewayClient] WebSocket connection opened.');
            // Initialize tool polling now that connection is open
            this.toolManager.initialize().catch(err => {
                logger.error('[GatewayClient] Error initializing ToolManager:', err);
            });
        });

        this.webSocketManager.on('close', (code, reason) => {
            logger.warn(`[GatewayClient] WebSocket connection closed. Code: ${code}, Reason: ${reason}`);
            // Stop tool polling when disconnected
            this.toolManager.stopPolling();
        });

        this.webSocketManager.on('error', (error) => {
            logger.error(`[GatewayClient] WebSocket error: ${error.message}`);
            // Stop tool polling on error
            this.toolManager.stopPolling();
        });

        // Handle messages - Distribute to RequestManager or EventManager
        this.webSocketManager.on('message', (data, isBinary) => {
            if (isBinary) return; // Ignore binary
            try {
                // TODO: Define shared WebSocketMessage type?
                const message = JSON.parse(data.toString()) as WebSocketMessage;
                if (message.type === 'response') {
                    // Let RequestManager handle responses
                    // This listener is now handled internally by RequestManager
                    // logger.debug('[GatewayClient] Forwarding response to RequestManager');
                } else if (message.type === 'event') {
                    // Let EventManager handle events
                    const payload = message.payload as EventPayload;
                    logger.info(`[GatewayClient] Received event: ${payload.eventType}`);
                    this.eventManager.emitEvent(payload.eventType, payload.data);
                } else {
                    logger.warn(`[GatewayClient] Received unhandled message type: ${message.type}`);
                }
            } catch (error) {
                logger.error(`[GatewayClient] Failed to parse message: ${error}`, data.toString());
            }
        });

        this.toolManager.on('toolsUpdated', (tools) => {
            logger.info(`[GatewayClient] Tool list updated. Count: ${tools.length}`);
            // TODO: Notify STDIO clients if necessary?
        });

        // TODO: Add listeners for EventManager if needed?
    }

    // OBSOLETE METHODS REMOVED:
    // - connectWebSocket() -> Handled by WebSocketManager
    // - rejectPendingRequests() -> Handled by RequestManager
    // - handleWebSocketMessage() -> Handled by RequestManager/EventManager via setupManagerEventHandlers
    // - sendWebSocketRequest() -> Use RequestManager.send()
    // - processRequestQueue() -> Handled by RequestManager
    // - initializeToolPolling() -> Handled by ToolManager
    // - stopToolPolling() -> Handled by ToolManager
    // - pollForTools() -> Handled by ToolManager
    // - updateKnownTools() -> Handled by ToolManager


    /**
     * Sets up handlers for MCP requests coming from LLM clients via STDIO.
     */
    private setupStdioRequestHandlers(): void {
        // --- ListTools Proxy ---
        this.mcpServer.setRequestHandler(ListToolsRequestSchema, async (request) => {
            logger.debug('[GatewayClient] Received ListTools request via STDIO, forwarding...');
            try {
                // Forward the request via RequestManager
                const result = await this.requestManager.send<ListToolsResult>('mcp_listTools', request.params);
                return result;
            } catch (error) {
                logger.error('[GatewayClient] Failed to forward ListTools request:', error);
                // Use ErrorHandler
                throw McpErrorHandler.handle(error, 'ListTools Proxy');
            }
        });

        // --- CallTool Proxy ---
        this.mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
            const toolName = request.params.name;
            logger.debug(`[GatewayClient] Received CallTool request via STDIO for ${toolName}, forwarding...`);
            try {
                // Forward the request via RequestManager
                const result = await this.requestManager.send<CallToolResult>('mcp_callTool', request.params);
                return result;
            } catch (error) {
                logger.error(`[GatewayClient] Failed to forward CallTool request for ${toolName}:`, error);
                // Use ErrorHandler
                throw McpErrorHandler.handle(error, `CallTool Proxy (${toolName})`);
            }
        });

        // TODO: Add handlers for other proxied requests (ListResources, ReadResource, etc.) if needed.

        this.mcpServer.onerror = (error: Error) => { // Explicitly type error
            // Use ErrorHandler? Or just log as it's specific to the proxy server part.
            logger.error(`[GatewayClient-Proxy Error] ${error.message}`, error.stack);
        };
    }


    /**
     * Starts the STDIO server to listen for LLM clients.
     */
    public async startStdioServer(): Promise<void> {
        try {
            const transport = new StdioServerTransport();
            await this.mcpServer.connect(transport);
            logger.info('Gateway Client Proxy listening on STDIO for LLM clients.');
        } catch (error: any) {
            logger.error(`Failed to start STDIO interface for Gateway Client Proxy: ${error.message}`);
            throw error;
        } // Added missing closing brace for catch
    } // Added missing closing brace for startStdioServer method

    // --- Tool Polling Logic (Now handled by ToolManager) ---


    // --- Shutdown Logic Update ---

    /**
     * Stops the client gracefully.
     */
    public async stop(): Promise<void> {
        logger.info('[GatewayClient] Stopping...');
        // Stop managers
        this.toolManager.destroy();
        this.requestManager.destroy(); // This should reject pending/queued
        this.webSocketManager.close(1000, 'Client shutting down'); // Close WS intentionally
        this.eventManager.destroy();

        // Stop the STDIO server
        await this.mcpServer.close();
        // No need to call rejectPendingRequests here, RequestManager handles it
        logger.info('[GatewayClient] Stopped.');
    }
}

// --- Main Execution ---
async function runClient() {
    // Configure logger specifically for the client? Or use shared config?
    // logger.setLevel('debug'); // Example: Set client log level

    const client = new GatewayClient();

    // Start listening for LLM clients on STDIO
    await client.startStdioServer();

    // Graceful shutdown handling
    const handleShutdown = async (signal: string) => {
        logger.info(`Received ${signal}. Shutting down Gateway Client...`);
        await client.stop();
        process.exit(0);
    };

    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    process.on('uncaughtException', async (error) => {
        logger.error('Unhandled Client Exception:', error);
        await client.stop();
        process.exit(1);
    });
    process.on('unhandledRejection', async (reason, promise) => {
        logger.error('Unhandled Client Rejection at:', promise, 'reason:', reason);
        await client.stop();
        process.exit(1);
    });

}

runClient().catch(error => {
    logger.error(`Gateway Client failed to start: ${error.message}`, error);
    process.exit(1);
});
