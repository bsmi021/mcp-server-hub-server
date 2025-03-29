import WebSocket, { WebSocketServer } from 'ws';
import { EventEmitter } from 'events';
import { ConfigurationManager } from '../config/ConfigurationManager.js';
import { ServerManager } from '../managers/ServerManager.js';
import { ToolRegistry } from '../managers/ToolRegistry.js';
import { logger } from '../utils/logger.js';
import { ServerStatus, ServerStatusChangeListener } from '../types/serverTypes.js';

// Define the structure for messages exchanged over WebSocket
interface WebSocketMessage {
    id: string; // Unique message ID for request/response matching
    type: 'request' | 'response' | 'event';
    payload: any;
}

interface RequestPayload {
    method: string; // e.g., 'mcp_listTools', 'mcp_callTool', 'mcp_getServerStatus'
    params: any;
}

interface ResponsePayload {
    result?: any;
    error?: { code: number; message: string; data?: any };
}

interface EventPayload {
    eventType: string; // e.g., 'serverStatusChange'
    data: any;
}


/**
 * Handles communication with Gateway Clients over WebSockets.
 */
export class WebSocketInterface extends EventEmitter {
    private wss: WebSocketServer | null = null;
    private toolRegistry: ToolRegistry;
    private serverManager: ServerManager;
    private configManager: ConfigurationManager;
    private clients: Set<WebSocket> = new Set();
    private statusChangeListener: ServerStatusChangeListener;

    constructor(toolRegistry: ToolRegistry, serverManager: ServerManager, configManager: ConfigurationManager) {
        super();
        this.toolRegistry = toolRegistry;
        this.serverManager = serverManager;
        this.configManager = configManager;

        // Listener to propagate server status changes to connected clients
        this.statusChangeListener = (serverId, status, instance) => {
            this.broadcast({
                id: `event-${Date.now()}-${serverId}`, // Simple unique ID for event
                type: 'event',
                payload: {
                    eventType: 'serverStatusChange',
                    data: {
                        serverId: serverId,
                        status: status,
                        // Include more details from 'instance' if needed
                    }
                }
            });
        };
    }

    /**
     * Starts the WebSocket server if configured.
     */
    public async start(): Promise<void> {
        const settings = this.configManager.getGatewaySettings();
        const port = settings.wsPort;

        if (!port) {
            logger.info('WebSocket interface disabled (wsPort not configured).');
            return;
        }

        try {
            this.wss = new WebSocketServer({ port });

            this.wss.on('listening', () => {
                logger.info(`WebSocket interface listening on port ${port}`);
                // Start listening to ServerManager events only when WS server is running
                this.serverManager.onServerStatusChange(this.statusChangeListener);
            });

            this.wss.on('connection', (ws) => {
                logger.info('WebSocket client connected.');
                this.clients.add(ws);

                ws.on('message', (message) => {
                    this.handleMessage(ws, message);
                });

                ws.on('close', () => {
                    logger.info('WebSocket client disconnected.');
                    this.clients.delete(ws);
                });

                ws.on('error', (error) => {
                    logger.error(`WebSocket client error: ${error.message}`);
                    this.clients.delete(ws); // Remove potentially broken client
                    ws.close(); // Ensure connection is closed
                });

                // Send initial status of all servers to the newly connected client
                this.sendInitialServerStatuses(ws);
            });

            this.wss.on('error', (error) => {
                logger.error(`WebSocket server error: ${error.message}`);
                this.wss = null; // Indicate server is down
                this.serverManager.offServerStatusChange(this.statusChangeListener); // Stop listening
                // Consider attempting to restart or notifying admin
            });

        } catch (error: any) {
            logger.error(`Failed to start WebSocket interface on port ${port}: ${error.message}`);
            this.wss = null;
        }
    }

    /**
     * Stops the WebSocket server.
     */
    public async stop(): Promise<void> {
        if (this.wss) {
            logger.info('Stopping WebSocket interface...');
            // Stop listening to ServerManager events first
            this.serverManager.offServerStatusChange(this.statusChangeListener);

            return new Promise((resolve) => {
                // Close all client connections gracefully
                this.clients.forEach(client => client.close(1000, 'Server shutting down'));
                this.clients.clear();

                // Add null check before calling close
                if (this.wss) {
                    this.wss.close((err) => {
                        if (err) {
                            logger.error(`Error stopping WebSocket server: ${err.message}`);
                        } else {
                            logger.info('WebSocket interface stopped.');
                        }
                        this.wss = null;
                        resolve();
                    });
                } else {
                    resolve(); // Already stopped or never started
                }
            });
        } else {
            // If wss is null, resolve immediately as there's nothing to stop
            return Promise.resolve();
        }
    } // Correctly placed closing brace for stop()

    /**
     * Handles incoming messages from a WebSocket client.
     */
    private handleMessage(ws: WebSocket, message: WebSocket.RawData): void {
        let parsedMessage: WebSocketMessage;
        try {
            parsedMessage = JSON.parse(message.toString());
            if (parsedMessage.type !== 'request' || !parsedMessage.id || !parsedMessage.payload?.method) {
                throw new Error('Invalid message format');
            }
        } catch (error: any) {
            logger.warn(`Received invalid WebSocket message: ${error.message}`);
            this.sendError(ws, 'unknown', -32700, 'Parse error', error.message);
            return;
        }

        const { id, payload } = parsedMessage;
        const { method, params } = payload as RequestPayload;

        logger.debug(`WS Request ID ${id}: Method=${method}, Params=${JSON.stringify(params)}`);

        // Route the request based on the method
        switch (method) {
            case 'mcp_listTools':
                this.handleListTools(ws, id);
                break;
            // case 'mcp_listResources': // Add if resources are needed
            //     this.handleListResources(ws, id);
            //     break;
            case 'mcp_callTool':
                this.handleCallTool(ws, id, params);
                break;
            case 'mcp_getServerStatus':
                this.handleGetServerStatus(ws, id, params);
                break;
            default:
                logger.warn(`Received unknown WS method: ${method}`);
                this.sendError(ws, id, -32601, 'Method not found', `Method "${method}" is not supported.`);
        }
    }

    // --- Request Handlers ---

    private async handleListTools(ws: WebSocket, requestId: string): Promise<void> {
        try {
            const tools = await this.toolRegistry.listTools(); // Assumes ToolRegistry handles namespacing
            this.sendResponse(ws, requestId, tools);
        } catch (error: any) {
            logger.error(`Error listing tools via WS: ${error.message}`);
            this.sendError(ws, requestId, -32000, 'Server error', 'Failed to list tools.');
        }
    }

    private async handleCallTool(ws: WebSocket, requestId: string, params: any): Promise<void> {
        // Basic validation - ToolRegistry will do more thorough schema validation
        if (!params || typeof params.name !== 'string' || typeof params.arguments !== 'object') {
            this.sendError(ws, requestId, -32602, 'Invalid params', 'Missing or invalid "name" (string) or "arguments" (object).');
            return;
        }

        try {
            // ToolRegistry's callTool should handle finding the right server and forwarding
            const result = await this.toolRegistry.callTool(params.name, params.arguments);
            this.sendResponse(ws, requestId, result);
        } catch (error: any) {
            logger.error(`Error calling tool "${params.name}" via WS: ${error.message}`, error);
            // TODO: Map internal errors (like MethodNotFound) to appropriate JSON-RPC error codes
            this.sendError(ws, requestId, -32000, 'Server error', `Failed to call tool "${params.name}": ${error.message}`);
        }
    }

    private handleGetServerStatus(ws: WebSocket, requestId: string, params: any): void {
        try {
            const serverId = params?.serverId;
            let statusData: Record<string, ServerStatus> | ServerStatus | undefined; // Allow undefined initially

            if (serverId && typeof serverId === 'string') {
                // Get status for a specific server
                statusData = this.serverManager.getServerStatus(serverId); // This returns ServerStatus
            } else {
                // Get status for all servers
                const allStatusData: Record<string, ServerStatus> = {}; // Explicitly type here
                const allServers = this.serverManager.getAllServers();
                allServers.forEach((instance, id) => {
                    allStatusData[id] = instance.status;
                });
                statusData = allStatusData; // Assign the correctly typed object
            }
            this.sendResponse(ws, requestId, statusData);
        } catch (error: any) {
            logger.error(`Error getting server status via WS: ${error.message}`);
            this.sendError(ws, requestId, -32000, 'Server error', 'Failed to get server status.');
        }
    }

    private sendInitialServerStatuses(ws: WebSocket): void {
        try {
            const statusData: Record<string, ServerStatus> = {};
            const allServers = this.serverManager.getAllServers();
            allServers.forEach((instance, id) => {
                statusData[id] = instance.status;
            });

            const message: WebSocketMessage = {
                id: `event-init-${Date.now()}`,
                type: 'event',
                payload: {
                    eventType: 'initialServerStatuses',
                    data: statusData
                }
            };
            ws.send(JSON.stringify(message));
        } catch (error: any) {
            logger.error(`Failed to send initial server statuses to client: ${error.message}`);
        }
    }


    // --- Response/Error Sending ---

    private sendResponse(ws: WebSocket, id: string, result: any): void {
        const message: WebSocketMessage = {
            id: id,
            type: 'response',
            payload: { result: result }
        };
        try {
            ws.send(JSON.stringify(message));
            logger.debug(`WS Response ID ${id}: Sent result.`);
        } catch (error: any) {
            logger.error(`Failed to send WS response (ID: ${id}): ${error.message}`);
        }
    }

    private sendError(ws: WebSocket, id: string | null, code: number, message: string, data?: any): void {
        const errorMessage: WebSocketMessage = {
            id: id ?? 'unknown', // Use null or a placeholder if ID is unknown (e.g., parse error)
            type: 'response',
            payload: {
                error: {
                    code: code,
                    message: message,
                    ...(data && { data: data }) // Include data if provided
                }
            }
        };
        try {
            ws.send(JSON.stringify(errorMessage));
            logger.debug(`WS Error Response ID ${id ?? 'unknown'}: Code=${code}, Message=${message}`);
        } catch (error: any) {
            logger.error(`Failed to send WS error response (ID: ${id ?? 'unknown'}): ${error.message}`);
        }
    }

    /**
     * Broadcasts a message to all connected WebSocket clients.
     */
    private broadcast(message: WebSocketMessage): void {
        if (this.clients.size === 0) return;

        const messageString = JSON.stringify(message);
        logger.debug(`Broadcasting WS message to ${this.clients.size} clients: ${message.payload.eventType}`);

        this.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(messageString);
                } catch (error: any) {
                    logger.error(`Failed to broadcast message to a client: ${error.message}`);
                    // Optionally remove the client if sending fails repeatedly
                    // this.clients.delete(client);
                }
            } else {
                // Remove clients that are no longer open
                logger.debug('Removing non-open client during broadcast.');
                this.clients.delete(client);
            }
        });
    }
} // Closing brace for the class
