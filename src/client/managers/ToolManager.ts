import { EventEmitter } from 'events';
import { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
// import { ToolDefinition } from '../../types/toolTypes.js'; // REMOVE: Don't use hub-specific definition here
import { logger } from '../../utils/logger.js'; // Assuming shared logger
import { RequestManager } from './RequestManager.js'; // Import RequestManager

/**
 * Represents the structure of a tool as returned by the MCP ListTools request.
 */
interface McpToolSchema {
    name: string;
    description?: string;
    // Input schema is expected to be a JSON Schema object
    inputSchema?: { [key: string]: unknown };
}

/**
 * Manages the list of available tools provided by the Gateway Server.
 * Handles fetching the initial list, polling for updates, and caching the results.
 */
export class ToolManager extends EventEmitter {
    private knownTools: McpToolSchema[] = []; // Use the standard schema type
    private pollingIntervalMs: number;
    private pollingIntervalId: NodeJS.Timeout | null = null;
    private isPolling = false;
    private requestManager: RequestManager; // Inject RequestManager dependency

    constructor(pollingIntervalMs: number, requestManager: RequestManager) {
        super();
        this.pollingIntervalMs = pollingIntervalMs;
        this.requestManager = requestManager;
        // TODO: Validate pollingIntervalMs
    }

    /**
     * Fetches the initial tool list and starts the polling interval.
     * Should be called after the WebSocket connection is established.
     */
    public async initialize(): Promise<void> {
        logger.info('[ToolManager] Initializing tool list...');
        try {
            // Use RequestManager to fetch initial tools
            const initialToolsResult = await this.requestManager.send<ListToolsResult>('mcp_listTools', {});
            this.updateKnownTools(initialToolsResult);
            logger.info(`[ToolManager] Initial tool list fetched (${this.knownTools.length} tools).`);
            this.startPolling();
        } catch (error: any) {
            logger.error('[ToolManager] Failed to fetch initial tool list:', error);
            // Still start polling, it will retry
            this.startPolling();
        }
    }

    /**
     * Starts the tool polling interval timer.
     */
    public startPolling(): void {
        if (this.isPolling) {
            logger.debug('[ToolManager] Polling already active.');
            return;
        }
        this.stopPolling(); // Ensure any existing timer is cleared
        logger.info(`[ToolManager] Starting tool list polling interval (${this.pollingIntervalMs}ms).`);
        this.pollingIntervalId = setInterval(() => this.pollForTools(), this.pollingIntervalMs);
        this.isPolling = true;
    }

    /**
     * Stops the tool polling interval timer.
     */
    public stopPolling(): void {
        if (this.pollingIntervalId) {
            logger.info('[ToolManager] Stopping tool list polling.');
            clearInterval(this.pollingIntervalId);
            this.pollingIntervalId = null;
        }
        this.isPolling = false;
    }

    /**
     * Fetches the current tool list from the gateway and updates the known list.
     */
    private async pollForTools(): Promise<void> {
        logger.debug('[ToolManager] Polling for tool list updates...');
        try {
            // Use RequestManager to poll for tools
            const currentToolsResult = await this.requestManager.send<ListToolsResult>('mcp_listTools', {});
            this.updateKnownTools(currentToolsResult);
        } catch (error: any) {
            logger.warn('[ToolManager] Failed to poll for tool list:', error);
            // Don't stop polling on error, just log and wait for the next interval
        }
    }

    /**
     * Compares the newly fetched tool list with the known list, updates the cache,
     * and emits an event if changes are detected.
     * @param newToolsResult - The newly fetched ListToolsResult.
     */
    private updateKnownTools(newToolsResult: ListToolsResult): void {
        if (!newToolsResult || !Array.isArray(newToolsResult.tools)) {
            logger.warn('[ToolManager] Received invalid tool list format during update.');
            return;
        }

        const newTools = newToolsResult.tools;
        const oldToolMap = new Map(this.knownTools.map(t => [t.name, t]));
        const newToolMap = new Map(newTools.map(t => [t.name, t]));
        let changed = false;

        // Check for added/updated tools
        newToolMap.forEach((newTool, name) => {
            const oldTool = oldToolMap.get(name);
            if (!oldTool) {
                logger.info(`[ToolManager] Tool added: ${name}`);
                changed = true;
            } else if (JSON.stringify(oldTool) !== JSON.stringify(newTool)) {
                // Basic check for changes. Could be more sophisticated.
                logger.info(`[ToolManager] Tool updated: ${name}`);
                changed = true;
            }
        });

        // Check for removed tools
        oldToolMap.forEach((_, name) => {
            if (!newToolMap.has(name)) {
                logger.info(`[ToolManager] Tool removed: ${name}`);
                changed = true;
            }
        });

        if (changed) {
            this.knownTools = [...newTools]; // Update the known list (create new array)
            logger.debug(`[ToolManager] Tool list updated. Current count: ${this.knownTools.length}`);
            this.emit('toolsUpdated', this.knownTools); // Emit event with the new list
        } else {
            logger.debug('[ToolManager] Tool list polled, no changes detected.');
        }
    }

    /**
     * Returns the currently cached list of tools.
     */
    public getKnownTools(): McpToolSchema[] { // Use the standard schema type
        // Return a copy to prevent external modification
        return [...this.knownTools];
    }

    /**
     * Cleans up resources (e.g., stops polling).
     */
    public destroy(): void {
        this.stopPolling();
        this.removeAllListeners(); // Clean up event listeners
        logger.info('[ToolManager] Destroyed.');
    }
}
