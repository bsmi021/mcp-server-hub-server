import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js'; // Assuming shared logger

// TODO: Define connection state enum?
// enum ConnectionState { CONNECTING, OPEN, CLOSING, CLOSED }

/**
 * Manages the WebSocket connection to the MCP Gateway Server,
 * including connection logic, reconnection attempts, and raw message handling.
 */
export class WebSocketManager extends EventEmitter {
    private ws: WebSocket | null = null;
    private gatewayUrl: string;
    private isConnected = false;
    private reconnectInterval: number;
    private reconnectTimer: NodeJS.Timeout | null = null;

    constructor(gatewayUrl: string, reconnectInterval = 5000) {
        super();
        this.gatewayUrl = gatewayUrl;
        this.reconnectInterval = reconnectInterval;
        // TODO: Consider adding options for max retries, backoff strategy
    }

    public connect(): void {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            logger.debug('[WSManager] Connection attempt ignored, already open or connecting.');
            return;
        }

        // Clear any pending reconnect timer
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        logger.info(`[WSManager] Attempting to connect to ${this.gatewayUrl}...`);
        this.ws = new WebSocket(this.gatewayUrl);
        // TODO: Add options like headers if needed

        this.ws.on('open', this.handleOpen.bind(this));
        this.ws.on('message', this.handleMessage.bind(this));
        this.ws.on('close', this.handleClose.bind(this));
        this.ws.on('error', this.handleError.bind(this));
    }

    private handleOpen(): void {
        logger.info(`[WSManager] Connected to ${this.gatewayUrl}.`);
        this.isConnected = true;
        this.emit('open');
    }

    private handleMessage(data: WebSocket.RawData, isBinary: boolean): void {
        // Emit raw message data for RequestManager or others to parse
        this.emit('message', data, isBinary);
    }

    private handleClose(code: number, reason: Buffer): void {
        logger.warn(`[WSManager] Connection closed. Code: ${code}, Reason: ${reason.toString()}.`);
        this.isConnected = false;
        this.ws = null; // Clean up the old socket
        this.emit('close', code, reason.toString());
        this.scheduleReconnect();
    }

    private handleError(error: Error): void {
        logger.error(`[WSManager] Connection error: ${error.message}`);
        // The 'close' event will likely follow, triggering reconnect logic.
        // Emit the error for potential higher-level handling.
        this.emit('error', error);
        // Ensure socket is cleaned up if 'close' doesn't fire immediately
        if (this.ws) {
            this.ws.removeAllListeners(); // Prevent duplicate handling
            this.ws = null;
        }
        this.isConnected = false;
        // Explicitly schedule reconnect here too, in case 'close' is delayed or doesn't fire
        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) {
            // Already scheduled
            return;
        }
        logger.info(`[WSManager] Scheduling reconnect in ${this.reconnectInterval / 1000}s...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null; // Clear timer ID before attempting connect
            this.connect();
        }, this.reconnectInterval);
    }

    public send(data: string | Buffer): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return reject(new Error('WebSocket connection is not open.'));
                // TODO: Integrate with RequestManager queuing? Or let RequestManager handle this?
            }
            this.ws.send(data, (error) => {
                if (error) {
                    logger.error(`[WSManager] Failed to send message: ${error.message}`);
                    return reject(error);
                }
                resolve();
            });
        });
    }

    public close(code?: number, reason?: string): void {
        logger.info('[WSManager] Closing connection intentionally.');
        // Stop reconnection attempts if closing intentionally
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            // Remove listeners to prevent automatic reconnection after intentional close
            this.ws.removeAllListeners();
            this.ws.close(code, reason);
            this.ws = null;
        }
        this.isConnected = false;
    }

    public get IsConnected(): boolean {
        return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
    }
}
