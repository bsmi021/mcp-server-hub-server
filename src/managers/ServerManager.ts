import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { ConfigurationManager } from '../config/ConfigurationManager.js';
import { ServerInstance, ServerStatus, ServerStatusChangeListener } from '../types/serverTypes.js';
import { ServerConfig } from '../types/configTypes.js';
import { logger } from '../utils/logger.js';

// Constants for restart logic
const RESTART_DELAY_MS = 5000; // Delay before attempting a restart
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5000; // Time to wait after SIGTERM before SIGKILL

/**
 * Manages the lifecycle of MCP server processes defined in the configuration.
 * Emits 'statusChange' events when a server's status changes.
 */
export class ServerManager extends EventEmitter {
    private configManager: ConfigurationManager;
    private servers: Map<string, ServerInstance> = new Map();
    private stoppingAll = false; // Flag to prevent restarts during shutdown

    constructor(configManager: ConfigurationManager) {
        super();
        this.configManager = configManager;
    }

    /**
     * Initializes the ServerManager by creating ServerInstance objects for each configured server.
     * Does not start the processes yet.
     */
    public initializeServers(): void {
        const serverConfigs = this.configManager.getAllServerConfigs();
        this.servers.clear(); // Clear any previous state

        for (const serverId in serverConfigs) {
            const config = serverConfigs[serverId] as Required<ServerConfig>; // Cast as Required because defaults are applied
            this.servers.set(serverId, {
                id: serverId,
                config: config,
                status: 'stopped',
                process: null,
                lastExitCode: null,
                lastExitSignal: null,
                restartAttempts: 0,
            });
            logger.debug(`Initialized server instance for: ${serverId}`);
        }
    }

    /**
     * Starts all configured MCP server processes.
     */
    public startAllServers(): void {
        this.stoppingAll = false;
        logger.info('Starting all configured MCP servers...');
        if (this.servers.size === 0) {
            this.initializeServers(); // Ensure instances are created if not already
        }
        for (const serverId of this.servers.keys()) {
            this.spawnServer(serverId).catch(err => {
                logger.error(`Failed initial spawn for server ${serverId}: ${err.message}`);
                // Status should already be 'error' from spawnServer failure handling
            });
        }
    }

    /**
     * Stops all running MCP server processes gracefully.
     * @returns A promise that resolves when all servers have stopped.
     */
    public async stopAllServers(): Promise<void> {
        this.stoppingAll = true;
        logger.info('Stopping all MCP servers...');
        const stopPromises: Promise<void>[] = [];
        for (const serverId of this.servers.keys()) {
            stopPromises.push(this.stopServer(serverId));
        }
        await Promise.allSettled(stopPromises); // Wait for all stops, regardless of individual success/failure
        logger.info('All MCP servers stopped.');
    }

    /**
     * Spawns or restarts a specific server process.
     * @param serverId - The ID of the server to spawn.
     * @returns A promise that resolves when the process is spawned (but not necessarily 'running').
     */
    public async spawnServer(serverId: string): Promise<void> {
        const instance = this.servers.get(serverId);
        if (!instance) {
            throw new Error(`Server configuration not found for ID: ${serverId}`);
        }

        if (instance.process || instance.status === 'starting' || instance.status === 'running' || instance.status === 'stopping') {
            logger.warn(`Server ${serverId} is already running or in transition (${instance.status}). Spawn request ignored.`);
            return;
        }

        this.updateStatus(serverId, 'starting');
        instance.lastStartTime = new Date();

        try {
            logger.info(`Spawning server ${serverId}: ${instance.config.command} ${instance.config.args.join(' ')}`);
            const serverProcess = spawn(instance.config.command, instance.config.args, {
                cwd: instance.config.workingDir,
                env: { ...process.env, ...instance.config.env }, // Merge OS env with config env
                stdio: ['pipe', 'pipe', 'pipe'], // Pipe stdin, stdout, stderr
                shell: false, // More secure and predictable
                detached: false // Typically false for managed processes
            });

            instance.process = serverProcess;

            // --- Event Handlers ---
            serverProcess.stdout?.on('data', (data) => this.onProcessOutput(serverId, data, false));
            serverProcess.stderr?.on('data', (data) => this.onProcessOutput(serverId, data, true));
            serverProcess.on('error', (err) => this.onProcessError(serverId, err));
            serverProcess.on('exit', (code, signal) => this.onProcessExit(serverId, code, signal));
            // Note: 'close' event could also be used, often fires after 'exit' when stdio streams close.

            // Basic check for successful spawn
            if (!serverProcess.pid) {
                throw new Error(`Failed to get PID for spawned process ${serverId}.`);
            }

            logger.debug(`Server ${serverId} spawned successfully with PID: ${serverProcess.pid}`);
            // Status remains 'starting' until confirmed running (e.g., by ToolRegistry)

        } catch (error: any) {
            logger.error(`Error spawning server ${serverId}: ${error.message}`);
            instance.process = null; // Ensure process is null on failure
            this.updateStatus(serverId, 'error');
            // Optionally attempt restart here if configured, or let exit handler do it
            this.handleRestart(serverId); // Attempt restart even on spawn error
            throw error; // Re-throw for the caller
        }
    }

    /**
     * Stops a specific server process gracefully.
     * @param serverId - The ID of the server to stop.
     * @param force - If true, sends SIGKILL immediately if SIGTERM fails.
     * @returns A promise that resolves when the server process has exited.
     */
    public stopServer(serverId: string, force = false): Promise<void> {
        return new Promise((resolve) => {
            const instance = this.servers.get(serverId);
            if (!instance || !instance.process || !instance.process.pid) {
                logger.debug(`Server ${serverId} not running or already stopped.`);
                if (instance && instance.status !== 'stopped') {
                    this.updateStatus(serverId, 'stopped'); // Ensure status is correct
                }
                resolve();
                return;
            }

            if (instance.status === 'stopping' || instance.status === 'stopped') {
                logger.debug(`Server ${serverId} is already stopping or stopped.`);
                resolve(); // Assume already handled
                return;
            }

            this.updateStatus(serverId, 'stopping');
            logger.info(`Stopping server ${serverId} (PID: ${instance.process.pid})...`);

            const pid = instance.process.pid;
            let timeoutId: NodeJS.Timeout | null = null;

            const cleanup = () => {
                if (timeoutId) clearTimeout(timeoutId);
                instance.process?.removeAllListeners(); // Clean up listeners to prevent leaks
                resolve();
            };

            // Listener for the actual exit
            instance.process.once('exit', (code, signal) => {
                logger.info(`Server ${serverId} (PID: ${pid}) exited with code ${code}, signal ${signal}.`);
                // Status update is handled by the main 'exit' handler (onProcessExit)
                cleanup();
            });

            // Attempt graceful shutdown
            instance.process.kill('SIGTERM'); // Standard termination signal

            // Set timeout for forceful termination
            timeoutId = setTimeout(() => {
                const currentInstance = this.servers.get(serverId); // Re-check instance
                if (currentInstance?.process && currentInstance.status === 'stopping') {
                    logger.warn(`Server ${serverId} (PID: ${pid}) did not stop gracefully after ${GRACEFUL_SHUTDOWN_TIMEOUT_MS}ms. Sending SIGKILL.`);
                    currentInstance.process.kill('SIGKILL'); // Force kill
                }
                // Cleanup will happen when the 'exit' event fires after SIGKILL
            }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
        });
    }

    /**
     * Handles the 'exit' event from a child process.
     */
    private onProcessExit(serverId: string, code: number | null, signal: NodeJS.Signals | null): void {
        const instance = this.servers.get(serverId);
        if (!instance) return; // Should not happen

        const statusBeforeExit = instance.status;
        instance.process = null; // Clear the process object
        instance.lastStopTime = new Date();
        instance.lastExitCode = code;
        instance.lastExitSignal = signal;

        if (statusBeforeExit === 'stopping') {
            // Clean stop initiated by stopServer
            logger.info(`Server ${serverId} stopped cleanly.`);
            this.updateStatus(serverId, 'stopped');
        } else {
            // Unexpected exit (crash or error)
            logger.error(`Server ${serverId} exited unexpectedly with code ${code}, signal ${signal}.`);
            this.updateStatus(serverId, 'error');
            this.handleRestart(serverId); // Attempt restart if configured
        }
    }

    /**
     * Handles the 'error' event from a child process (e.g., spawn errors).
     */
    private onProcessError(serverId: string, err: Error): void {
        const instance = this.servers.get(serverId);
        if (!instance) return;

        logger.error(`Server ${serverId} encountered an error: ${err.message}`);
        instance.process = null; // Assume process is unusable
        // The 'exit' event might or might not follow, depending on the error.
        // Update status here to be safe, exit handler can refine it.
        if (instance.status !== 'error' && instance.status !== 'stopping') {
            this.updateStatus(serverId, 'error');
            this.handleRestart(serverId); // Attempt restart
        }
    }

    /**
     * Handles data received from a child process's stdout or stderr.
     */
    private onProcessOutput(serverId: string, data: Buffer | string, isError: boolean): void {
        const instance = this.servers.get(serverId);
        if (!instance) return;
        logger.captureOutput(serverId, data.toString(), isError);
    }

    /**
     * Decides whether to restart a server based on its configuration and current state.
     */
    private handleRestart(serverId: string): void {
        const instance = this.servers.get(serverId);
        if (!instance || this.stoppingAll) {
            return; // Don't restart if shutting down or instance is gone
        }

        if (instance.config.autoRestart && instance.restartAttempts < instance.config.maxRestarts) {
            instance.restartAttempts++;
            logger.info(`Attempting restart ${instance.restartAttempts}/${instance.config.maxRestarts} for server ${serverId} in ${RESTART_DELAY_MS / 1000}s...`);
            this.updateStatus(serverId, 'restarting');
            setTimeout(() => {
                // Double-check status before restarting, might have been stopped manually
                const currentInstance = this.servers.get(serverId);
                if (currentInstance && currentInstance.status === 'restarting') {
                    this.spawnServer(serverId).catch(err => {
                        logger.error(`Restart spawn attempt failed for ${serverId}: ${err.message}`);
                        // Status should be 'error' from spawnServer failure
                    });
                } else {
                    logger.warn(`Restart for ${serverId} aborted, status changed to ${currentInstance?.status}.`);
                }
            }, RESTART_DELAY_MS);
        } else if (instance.config.autoRestart) {
            logger.error(`Server ${serverId} reached maximum restart attempts (${instance.config.maxRestarts}). Will not restart automatically.`);
            // Status remains 'error'
        } else {
            logger.info(`Auto-restart disabled for server ${serverId}.`);
            // Status remains 'error'
        }
    }

    /**
     * Updates the status of a server instance and emits an event.
     * Resets restart attempts if the server reaches 'running' state.
     */
    public updateStatus(serverId: string, status: ServerStatus): void {
        const instance = this.servers.get(serverId);
        if (!instance) return;

        if (instance.status === status) return; // No change

        const oldStatus = instance.status;
        instance.status = status;
        logger.debug(`Server ${serverId} status changed: ${oldStatus} -> ${status}`);

        // Reset restart counter if server becomes stable/running or is manually stopped
        if (status === 'running' || status === 'stopped') {
            instance.restartAttempts = 0;
        }

        // Emit event AFTER updating internal state
        this.emit('statusChange', serverId, status, instance);
    }

    /**
     * Registers a listener for server status change events.
     * @param listener - The function to call when a status changes.
     */
    public onServerStatusChange(listener: ServerStatusChangeListener): void {
        this.on('statusChange', listener);
    }

    /**
     * Removes a listener for server status change events.
     * @param listener - The listener function to remove.
     */
    public offServerStatusChange(listener: ServerStatusChangeListener): void {
        this.off('statusChange', listener);
    }


    /**
     * Gets the current status of a specific server.
     * @param serverId - The ID of the server.
     * @returns The ServerStatus, or 'stopped' if the server is not found.
     */
    public getServerStatus(serverId: string): ServerStatus {
        return this.servers.get(serverId)?.status ?? 'stopped';
    }

    /**
    * Gets the ServerInstance object for a specific server.
    * @param serverId - The ID of the server.
    * @returns The ServerInstance or undefined if not found.
    */
    public getServerInstance(serverId: string): ServerInstance | undefined {
        return this.servers.get(serverId);
    }


    /**
     * Gets a map of all managed server instances.
     * @returns A Map where keys are server IDs and values are ServerInstance objects.
     */
    public getAllServers(): Map<string, ServerInstance> {
        // Return a shallow copy to prevent external modification of the internal map
        return new Map(this.servers);
    }
}
