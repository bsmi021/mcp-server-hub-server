import { ChildProcess } from 'child_process';
import { ServerConfig } from './configTypes.js';

/**
 * Defines the possible lifecycle states of a managed MCP server process.
 */
export type ServerStatus =
    | 'starting'   // Process launched, waiting for initial communication or stabilization
    | 'running'    // Server is operational and responsive (e.g., successfully listed tools)
    | 'stopping'   // Termination signal sent, waiting for exit
    | 'stopped'    // Process is not running (cleanly exited or never started)
    | 'restarting' // Attempting to restart after a crash
    | 'error';     // Process exited with an error or failed to start

/**
 * Represents a managed MCP server instance within the gateway.
 */
export interface ServerInstance {
    /**
     * The unique identifier for the server, matching the key in the configuration.
     */
    id: string;
    /**
     * The configuration object used to launch this server instance.
     */
    config: Required<ServerConfig>; // Use Required to ensure defaults are applied
    /**
     * The current lifecycle status of the server process.
     */
    status: ServerStatus;
    /**
     * The underlying Node.js child process object. Null if not currently running.
     */
    process: ChildProcess | null;
    /**
     * Timestamp of when the server was last started. Undefined if never started.
     */
    lastStartTime?: Date;
    /**
     * Timestamp of when the server last exited. Undefined if never stopped.
     */
    lastStopTime?: Date;
    /**
     * The exit code of the process the last time it stopped. Null if stopped via signal or never stopped.
     */
    lastExitCode: number | null;
    /**
    * The signal that caused the process to stop (e.g., 'SIGTERM'). Null if exited normally or never stopped.
    */
    lastExitSignal: NodeJS.Signals | null;
    /**
     * A count of restart attempts made since the last successful run or initial start.
     * Reset when the server reaches 'running' state or is manually stopped.
     */
    restartAttempts: number;
    /**
     * A buffer or store for recent output lines from the server's STDOUT/STDERR.
     * (Implementation detail - might be handled directly by logger or kept here).
     */
    // outputBuffer?: string[]; // Decided to handle output directly via logger for simplicity
}

/**
 * Type for the listener function used with ServerManager status change events.
 */
export type ServerStatusChangeListener = (serverId: string, status: ServerStatus, instance: ServerInstance) => void;
