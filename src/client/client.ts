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
    private ws: WebSocket | null = null;
    private mcpServer: McpServer;
    private isWsConnected = false;
    private reconnectInterval = 5000; // 5 seconds
    private pendingRequests: Map<string, { resolve: (value: any) => void, reject: (reason?: any) => void }> = new Map();
    private requestQueue: Array<{ id: string, method: string, params: any, resolve: (value: any) => void, reject: (reason?: any) => void }> = [];
    private pollingIntervalId: NodeJS.Timeout | null = null;
    private knownTools: ListToolsResult | null = null; // Store the last known tool list

    constructor() {
        // Initialize the MCP Server part that listens to LLM clients via STDIO
        const serverOptions: ServerOptions = {
            capabilities: {
                tools: {} // This client *proxies* tools, so it needs the capability
                // Add other capabilities if proxying resources, etc.
            }
        };
        const serverInfo = { name: 'mcp-gateway-client-proxy', version: '0.1.0' };
        this.mcpServer = new McpServer(serverInfo, serverOptions);
        this.setupStdioRequestHandlers();

        // Initialize WebSocket connection attempt
        this.connectWebSocket();
    }

    /**
     * Connects (or attempts to reconnect) to the Gateway Server via WebSocket.
     */
    private connectWebSocket(): void {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            logger.debug('WebSocket connection already open or connecting.');
            return;
        }

        logger.info(`Attempting to connect to Gateway Server at ${GATEWAY_SERVER_URL}...`);
        this.ws = new WebSocket(GATEWAY_SERVER_URL);

        this.ws.on('open', () => {
            logger.info('Connected to Gateway Server via WebSocket.');
            this.isWsConnected = true;
            // Process any queued requests
            this.processRequestQueue();
            // Perform initial tool list fetch and start polling
            this.initializeToolPolling();
        });

        this.ws.on('message', (data) => {
            this.handleWebSocketMessage(data);
        });

        this.ws.on('close', (code, reason) => {
            logger.warn(`WebSocket connection closed. Code: ${code}, Reason: ${reason?.toString()}. Attempting reconnect in ${this.reconnectInterval / 1000}s...`);
            this.isWsConnected = false;
            this.ws = null;
            // Stop polling on close
            this.stopToolPolling();
            // Reject any pending requests
            this.rejectPendingRequests('WebSocket connection closed');
            setTimeout(() => this.connectWebSocket(), this.reconnectInterval);
        });

        this.ws.on('error', (error) => {
            logger.error(`WebSocket connection error: ${error.message}`);
            this.isWsConnected = false;
            // Stop polling on error
            this.stopToolPolling();
            this.ws = null; // Ensure ws is null on error before attempting reconnect
            // Connection will likely close, triggering the 'close' handler for reconnect logic
        });
    }

    /**
     * Rejects all pending requests with a given reason.
     */
    private rejectPendingRequests(reason: string): void {
        const error = new McpError(ErrorCode.InternalError, reason); // Use InternalError
        // Reject pending requests waiting for WS response
        this.pendingRequests.forEach(({ reject }) => reject(error));
        this.pendingRequests.clear();
        // Reject requests queued because WS was down
        this.requestQueue.forEach(({ reject }) => reject(error));
        this.requestQueue = []; // Clear queue
    }

    /**
     * Handles messages received from the Gateway Server via WebSocket.
     */
    private handleWebSocketMessage(data: WebSocket.RawData): void {
        try {
            const message: WebSocketMessage = JSON.parse(data.toString());
            logger.debug(`Received WS message: Type=${message.type}, ID=${message.id}`);

            if (message.type === 'response') {
                const pending = this.pendingRequests.get(message.id);
                if (pending) {
                    this.pendingRequests.delete(message.id);
                    const payload = message.payload as ResponsePayload;
                    if (payload.error) {
                        logger.warn(`Received error response for ID ${message.id}: ${payload.error.message}`);
                        // Reconstruct McpError if possible, otherwise use a generic error
                        const error = new McpError(payload.error.code, payload.error.message, payload.error.data);
                        pending.reject(error);
                    } else {
                        logger.debug(`Received result for ID ${message.id}`);
                        pending.resolve(payload.result);
                    }
                } else {
                    logger.warn(`Received response for unknown request ID: ${message.id}`);
                }
            } else if (message.type === 'event') {
                const payload = message.payload as EventPayload;
                logger.info(`Received event from Gateway Server: ${payload.eventType}`, payload.data);
                // TODO: Handle specific events if needed (e.g., serverStatusChange)
                // Could potentially forward some events to connected LLM clients if required.
            } else {
                logger.warn(`Received unexpected WebSocket message type: ${message.type}`);
            }
        } catch (error: any) {
            logger.error(`Failed to process WebSocket message: ${error.message}`, data.toString());
        }
    }

    /**
     * Sends a request to the Gateway Server via WebSocket and returns a Promise for the response.
     */
    private sendWebSocketRequest(method: string, params: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const requestId = `${method}-${Date.now()}-${Math.random().toString(16).substring(2)}`;

            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                // Queue the request instead of rejecting immediately
                logger.warn(`WebSocket not connected. Queuing request ID ${requestId}: ${method}`);
                this.requestQueue.push({ id: requestId, method, params, resolve, reject });
                return; // Don't proceed to send yet
            }

            // If already connected, send immediately
            const message: WebSocketMessage = {
                id: requestId,
                type: 'request',
                payload: { method, params }
            };

            try {
                this.ws.send(JSON.stringify(message));
                logger.debug(`Sent WS request ID ${requestId}: Method=${method}`);
                // Store the resolve/reject handlers to be called when the response arrives
                this.pendingRequests.set(requestId, { resolve, reject });

                // TODO: Implement request timeout?
                // setTimeout(() => {
                //     if (this.pendingRequests.has(requestId)) {
                //         this.pendingRequests.delete(requestId);
                //         reject(new McpError(ErrorCode.Timeout, `Request ${requestId} timed out`));
                //     }
                // }, 30000); // 30 second timeout example

            } catch (error: any) {
                logger.error(`Failed to send WebSocket request: ${error.message}`);
                reject(new McpError(ErrorCode.InternalError, `Failed to send request: ${error.message}`)); // Use InternalError
            }
        });
    }

    /**
     * Processes requests that were queued while the WebSocket was disconnected.
     */
    private processRequestQueue(): void {
        if (this.requestQueue.length === 0) {
            return;
        }
        logger.info(`Processing ${this.requestQueue.length} queued request(s)...`);

        // Create a copy and clear the original queue first to avoid race conditions if new requests are queued during processing
        const queueToProcess = [...this.requestQueue];
        this.requestQueue = [];

        queueToProcess.forEach(queuedRequest => {
            // Re-attempt sending now that WS should be open
            const { id, method, params, resolve, reject } = queuedRequest;

            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                // Should not happen if called right after 'open', but handle defensively
                logger.error(`WebSocket disconnected while processing queue for request ID ${id}. Rejecting.`);
                reject(new McpError(ErrorCode.InternalError, 'WebSocket disconnected during queue processing'));
                return;
            }

            const message: WebSocketMessage = {
                id: id,
                type: 'request',
                payload: { method, params }
            };

            try {
                this.ws.send(JSON.stringify(message));
                logger.debug(`Sent queued WS request ID ${id}: Method=${method}`);
                // Store the original promise handlers
                this.pendingRequests.set(id, { resolve, reject });
                // Add timeout logic here if needed for queued requests too
            } catch (error: any) {
                logger.error(`Failed to send queued WebSocket request ID ${id}: ${error.message}`);
                reject(new McpError(ErrorCode.InternalError, `Failed to send queued request: ${error.message}`));
            }
        });
    }


    /**
     * Sets up handlers for MCP requests coming from LLM clients via STDIO.
     */
    private setupStdioRequestHandlers(): void {
        // --- ListTools Proxy ---
        this.mcpServer.setRequestHandler(ListToolsRequestSchema, async (request) => {
            logger.debug('Received ListTools request via STDIO, forwarding to Gateway Server...');
            try {
                // Forward the request via WebSocket
                const result = await this.sendWebSocketRequest('mcp_listTools', request.params);
                // Assuming the result structure matches ListToolsResult
                return result as ListToolsResult;
            } catch (error) {
                logger.error('Failed to forward ListTools request:', error);
                if (error instanceof McpError) throw error;
                throw new McpError(ErrorCode.InternalError, `Failed to list tools via gateway: ${error instanceof Error ? error.message : String(error)}`);
            }
        });

        // --- CallTool Proxy ---
        this.mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
            const toolName = request.params.name;
            logger.debug(`Received CallTool request via STDIO for ${toolName}, forwarding to Gateway Server...`);
            try {
                // Forward the request via WebSocket
                const result = await this.sendWebSocketRequest('mcp_callTool', request.params);
                // Assuming the result structure matches CallToolResult
                return result as CallToolResult;
            } catch (error) {
                logger.error(`Failed to forward CallTool request for ${toolName}:`, error);
                if (error instanceof McpError) throw error;
                throw new McpError(ErrorCode.InternalError, `Failed to call tool "${toolName}" via gateway: ${error instanceof Error ? error.message : String(error)}`);
            }
        });

        // TODO: Add handlers for other proxied requests (ListResources, ReadResource, etc.) if needed.

        this.mcpServer.onerror = (error) => {
            logger.error(`[GatewayClient-Proxy Error] ${error.message}`, error);
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
        }
    }

    // --- Tool Polling Logic ---

    /**
     * Fetches the initial tool list and starts the polling interval.
     */
    private async initializeToolPolling(): Promise<void> {
        logger.info('Performing initial tool list fetch...');
        try {
            const initialTools = await this.sendWebSocketRequest('mcp_listTools', {}) as ListToolsResult;
            this.updateKnownTools(initialTools);
            logger.info(`Initial tool list fetched (${this.knownTools?.tools?.length ?? 0} tools). Starting polling interval (${POLLING_INTERVAL_MS}ms).`);
            // Clear any existing interval just in case
            this.stopToolPolling();
            // Start the polling timer
            this.pollingIntervalId = setInterval(() => this.pollForTools(), POLLING_INTERVAL_MS);
        } catch (error: any) {
            logger.error('Failed to fetch initial tool list:', error);
            // Optionally retry initial fetch or rely on the first poll interval
            // For now, start polling anyway, it will retry
            if (!this.pollingIntervalId) {
                logger.info(`Starting polling interval (${POLLING_INTERVAL_MS}ms) despite initial fetch failure.`);
                this.pollingIntervalId = setInterval(() => this.pollForTools(), POLLING_INTERVAL_MS);
            }
        }
    }

    /**
     * Stops the tool polling interval timer.
     */
    private stopToolPolling(): void {
        if (this.pollingIntervalId) {
            logger.info('Stopping tool list polling.');
            clearInterval(this.pollingIntervalId);
            this.pollingIntervalId = null;
        }
    }

    /**
     * Fetches the current tool list from the gateway and updates the known list.
     */
    private async pollForTools(): Promise<void> {
        logger.debug('Polling for tool list updates...');
        try {
            const currentTools = await this.sendWebSocketRequest('mcp_listTools', {}) as ListToolsResult;
            this.updateKnownTools(currentTools);
        } catch (error: any) {
            logger.warn('Failed to poll for tool list:', error);
            // Don't stop polling on error, just log and wait for the next interval
        }
    }

    /**
     * Compares the newly fetched tool list with the known list and logs changes.
     * @param newTools - The newly fetched ListToolsResult.
     */
    private updateKnownTools(newTools: ListToolsResult): void {
        if (!newTools || !Array.isArray(newTools.tools)) {
            logger.warn('Received invalid tool list format during update.');
            return;
        }

        const oldToolMap = new Map(this.knownTools?.tools?.map(t => [t.name, t]));
        const newToolMap = new Map(newTools.tools.map(t => [t.name, t]));
        let changed = false;

        // Check for added/updated tools
        newToolMap.forEach((newTool, name) => {
            if (!oldToolMap.has(name)) {
                logger.info(`[Tool Update] Tool added: ${name}`);
                changed = true;
            } else {
                // Basic check for description/schema changes (more robust diffing needed for real updates)
                const oldTool = oldToolMap.get(name);
                if (JSON.stringify(oldTool) !== JSON.stringify(newTool)) {
                    logger.info(`[Tool Update] Tool updated: ${name}`); // Simple update log
                    changed = true;
                }
            }
        });

        // Check for removed tools
        oldToolMap.forEach((oldTool, name) => {
            if (!newToolMap.has(name)) {
                logger.info(`[Tool Update] Tool removed: ${name}`);
                changed = true;
            }
        });

        this.knownTools = newTools; // Update the known list

        if (changed) {
            logger.debug(`Tool list updated. Current count: ${this.knownTools?.tools?.length ?? 0}`);
            // TODO: Emit an event or notify relevant client parts about the change?
        } else {
            logger.debug('Tool list polled, no changes detected.');
        }
    }

    // --- Shutdown Logic Update ---

    /**
     * Stops the client gracefully.
     */
    public async stop(): Promise<void> {
        logger.info('Stopping Gateway Client...');
        // Stop polling
        this.stopToolPolling();
        // Close WebSocket connection
        if (this.ws) {
            // Remove listeners to prevent reconnect attempts during shutdown
            this.ws.removeAllListeners('close');
            this.ws.removeAllListeners('error');
            this.ws.close(1000, 'Client shutting down');
            this.ws = null;
        }
        // Stop the STDIO server
        await this.mcpServer.close();
        this.rejectPendingRequests('Gateway Client shutting down');
        logger.info('Gateway Client stopped.');
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
