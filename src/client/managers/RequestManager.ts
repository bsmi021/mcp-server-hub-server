import WebSocket from 'ws'; // Added import for RawData type
import { EventEmitter } from 'events';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../../utils/logger.js'; // Assuming shared logger
import { WebSocketManager } from './WebSocketManager.js'; // Dependency

// TODO: Define types for WebSocket messages if not shared globally
interface WebSocketRequestPayload {
    method: string;
    params: any;
}

interface WebSocketMessage {
    id: string;
    type: 'request' | 'response' | 'event';
    payload: any;
}

interface ResponsePayload {
    result?: any;
    error?: { code: number; message: string; data?: any };
}

interface PendingRequest<T = any> {
    id: string;
    method: string;
    params: any;
    resolve: (value: T) => void;
    reject: (reason?: any) => void;
    timer?: NodeJS.Timeout; // For timeout handling
}

interface RequestOptions {
    timeout?: number; // Timeout in milliseconds
    // retries?: number; // Future consideration
}

const DEFAULT_TIMEOUT = 30000; // 30 seconds

/**
 * Manages outgoing MCP requests via the WebSocket connection.
 * Handles request serialization, queuing when disconnected, matching responses
 * to requests, and implementing timeouts.
 */
export class RequestManager extends EventEmitter {
    private wsManager: WebSocketManager;
    private pendingRequests: Map<string, PendingRequest> = new Map();
    private requestQueue: PendingRequest[] = [];
    private requestIdCounter = 0; // Simple counter for unique IDs

    constructor(wsManager: WebSocketManager) {
        super();
        this.wsManager = wsManager;
        this.setupWsListeners();
    }

    private setupWsListeners(): void {
        this.wsManager.on('open', this.processRequestQueue.bind(this));
        this.wsManager.on('message', this.handleWebSocketMessage.bind(this));
        this.wsManager.on('close', () => this.rejectAllPending('WebSocket connection closed'));
        this.wsManager.on('error', (err) => this.rejectAllPending(`WebSocket connection error: ${err.message}`));
    }

    /**
     * Sends an MCP request to the Gateway Server.
     * If the WebSocket is not connected, the request is queued.
     * @param method The MCP method name (e.g., 'mcp_listTools', 'mcp_callTool').
     * @param params The parameters for the method.
     * @param options Optional request configuration like timeout.
     * @returns A promise that resolves with the result or rejects with an error/timeout.
     */
    public send<T = any>(method: string, params: any, options?: RequestOptions): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const requestId = `${method}-${Date.now()}-${this.requestIdCounter++}`;
            const timeoutDuration = options?.timeout ?? DEFAULT_TIMEOUT;

            const pending: PendingRequest<T> = {
                id: requestId,
                method,
                params,
                resolve,
                reject,
            };

            if (!this.wsManager.IsConnected) {
                logger.warn(`[ReqManager] WebSocket not connected. Queuing request ID ${requestId}: ${method}`);
                this.requestQueue.push(pending);
                // TODO: Implement queue size limit?
            } else {
                this.sendRequestInternal(pending, timeoutDuration);
            }
        });
    }

    private sendRequestInternal(request: PendingRequest, timeoutDuration: number): void {
        const message: WebSocketMessage = {
            id: request.id,
            type: 'request',
            payload: { method: request.method, params: request.params }
        };

        try {
            const messageString = JSON.stringify(message);
            logger.debug(`[ReqManager] Sending WS request ID ${request.id}: Method=${request.method}`);

            // Set up timeout *before* sending
            request.timer = setTimeout(() => {
                if (this.pendingRequests.has(request.id)) {
                    logger.warn(`[ReqManager] Request ${request.id} (${request.method}) timed out after ${timeoutDuration}ms.`);
                    this.pendingRequests.delete(request.id);
                    // Use RequestTimeout if available, otherwise fallback or check SDK types again
                    request.reject(new McpError(ErrorCode.RequestTimeout ?? ErrorCode.InternalError, `Request ${request.id} timed out after ${timeoutDuration}ms`));
                }
            }, timeoutDuration);

            // Store pending request *before* sending
            this.pendingRequests.set(request.id, request);

            // Send the request via WebSocketManager
            this.wsManager.send(messageString).catch(sendError => {
                // If sending fails immediately, reject the promise
                logger.error(`[ReqManager] Failed to send WS request ID ${request.id}: ${sendError}`);
                if (request.timer) clearTimeout(request.timer); // Clear timeout if send failed
                this.pendingRequests.delete(request.id);
                request.reject(new McpError(ErrorCode.InternalError, `Failed to send request: ${sendError instanceof Error ? sendError.message : String(sendError)}`));
            });

        } catch (error: any) {
            logger.error(`[ReqManager] Failed to stringify or prepare request ID ${request.id}: ${error.message}`);
            // Don't need to clear timeout here as it wasn't set
            this.pendingRequests.delete(request.id); // Ensure cleanup if it was added before error
            request.reject(new McpError(ErrorCode.InternalError, `Failed to prepare request: ${error.message}`));
        }
    }

    /**
     * Processes requests that were queued while the WebSocket was disconnected.
     */
    private processRequestQueue(): void {
        if (this.requestQueue.length === 0) {
            return;
        }
        logger.info(`[ReqManager] WebSocket connected. Processing ${this.requestQueue.length} queued request(s)...`);

        // Process queue FIFO
        while (this.requestQueue.length > 0) {
            const queuedRequest = this.requestQueue.shift();
            if (queuedRequest) {
                // TODO: Re-evaluate timeout for queued requests? Use original or reset?
                // For now, use the default timeout when sending from queue.
                this.sendRequestInternal(queuedRequest, DEFAULT_TIMEOUT);
            }
        }
    }

    /**
     * Handles incoming WebSocket messages, parsing them and resolving/rejecting pending requests.
     */
    private handleWebSocketMessage(data: WebSocket.RawData, isBinary: boolean): void {
        if (isBinary) {
            logger.warn('[ReqManager] Received unexpected binary message, ignoring.');
            return;
        }

        try {
            const message: WebSocketMessage = JSON.parse(data.toString());
            logger.debug(`[ReqManager] Received WS message: Type=${message.type}, ID=${message.id}`);

            if (message.type === 'response') {
                const pending = this.pendingRequests.get(message.id);
                if (pending) {
                    // Clear timeout associated with this request
                    if (pending.timer) {
                        clearTimeout(pending.timer);
                    }
                    this.pendingRequests.delete(message.id);

                    const payload = message.payload as ResponsePayload;
                    if (payload.error) {
                        logger.warn(`[ReqManager] Received error response for ID ${message.id}: ${payload.error.message}`);
                        // TODO: Use ErrorHandler class here?
                        const error = new McpError(payload.error.code, payload.error.message, payload.error.data);
                        pending.reject(error);
                    } else {
                        logger.debug(`[ReqManager] Received result for ID ${message.id}`);
                        pending.resolve(payload.result);
                    }
                } else {
                    logger.warn(`[ReqManager] Received response for unknown/timed-out request ID: ${message.id}`);
                }
            } else if (message.type === 'event') {
                // Events are not handled by RequestManager, maybe EventManager?
                // logger.debug(`[ReqManager] Ignoring event message ID: ${message.id}`);
            } else {
                logger.warn(`[ReqManager] Received unexpected WebSocket message type: ${message.type}`);
            }
        } catch (error: any) {
            logger.error(`[ReqManager] Failed to process WebSocket message: ${error.message}`, data.toString());
        }
    }

    /**
     * Rejects all pending and queued requests, typically on disconnection or fatal error.
 * @param reason - A description of why requests are being rejected.
 */
    private rejectAllPending(reason: string): void {
        // Use InternalError or a more appropriate code if NetworkError doesn't exist
        const error = new McpError(ErrorCode.InternalError, reason);
        logger.warn(`[ReqManager] Rejecting all pending/queued requests: ${reason}`);

        // Reject pending requests waiting for WS response
        this.pendingRequests.forEach((pending) => {
            if (pending.timer) clearTimeout(pending.timer);
            pending.reject(error);
        });
        this.pendingRequests.clear();

        // Reject requests queued because WS was down
        this.requestQueue.forEach((queued) => {
            // No timer to clear for queued requests
            queued.reject(error);
        });
        this.requestQueue = []; // Clear queue
    }

    /**
     * Cleans up resources (e.g., removes listeners).
     */
    public destroy(): void {
        this.rejectAllPending('RequestManager shutting down');
        this.wsManager.off('open', this.processRequestQueue.bind(this));
        this.wsManager.off('message', this.handleWebSocketMessage.bind(this));
        // Don't remove close/error listeners here? Or should we?
        this.removeAllListeners(); // Clean up own event listeners if any added later
        logger.info('[ReqManager] Destroyed.');
    }
}
