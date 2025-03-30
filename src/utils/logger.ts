import { LogLevel } from '../types/loggingTypes.js';

// Defines the numeric level for each log type, used for filtering.
const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

/**
 * Simple console logger for the MCP Gateway Server.
 * Provides basic leveled logging and server output capture.
 */
export class Logger {
    private currentLevel: LogLevel = 'info'; // Default log level
    private currentLevelValue: number = LOG_LEVEL_VALUES[this.currentLevel];

    /**
     * Sets the minimum log level to output.
     * Messages with a level lower than this will be ignored.
     * @param level - The minimum log level ('error', 'warn', 'info', 'debug').
     */
    public setLevel(level: LogLevel): void {
        this.currentLevel = level;
        this.currentLevelValue = LOG_LEVEL_VALUES[level];
        this.info(`Log level set to: ${level}`);
    }

    /**
     * Gets the current log level.
     * @returns The current log level.
     */
    public getLevel(): LogLevel {
        return this.currentLevel;
    }

    /**
     * Logs a debug message (lowest level).
     * @param message - The message to log.
     * @param args - Additional arguments to log.
     */
    public debug(message: string, ...args: any[]): void {
        this.log('debug', message, args);
    }

    /**
     * Logs an informational message.
     * @param message - The message to log.
     * @param args - Additional arguments to log.
     */
    public info(message: string, ...args: any[]): void {
        this.log('info', message, args);
    }

    /**
     * Logs a warning message.
     * @param message - The message to log.
     * @param args - Additional arguments to log.
     */
    public warn(message: string, ...args: any[]): void {
        this.log('warn', message, args);
    }

    /**
     * Logs an error message (highest level).
     * @param message - The message to log.
     * @param args - Additional arguments to log (often an Error object).
     */
    public error(message: string, ...args: any[]): void {
        this.log('error', message, args);
    }

    /**
     * Captures and logs output (STDOUT/STDERR) from a managed MCP server process.
     * @param serverId - The identifier of the source server.
     * @param output - The raw output string (can contain multiple lines).
     * @param isErrorOutput - Flag indicating if the output came from STDERR.
     */
    public captureOutput(serverId: string, output: string, isErrorOutput: boolean = false): void {
        const level: LogLevel = isErrorOutput ? 'error' : 'debug'; // Log server errors as 'error', stdout as 'debug'
        const prefix = `[${serverId}${isErrorOutput ? '/ERR' : ''}]`;

        // Split potential multi-line output and log each line individually
        output.split(/(\r?\n)/).forEach(line => {
            const trimmedLine = line.trim();
            if (trimmedLine) { // Avoid logging empty lines
                this.log(level, `${prefix} ${trimmedLine}`);
            }
        });
    }

    /**
     * Internal log method to handle level checking and console output.
     * @param level - The level of the message.
     * @param message - The message string.
     * @param args - Additional arguments.
     */
    private log(level: LogLevel, message: string, args: any[] = []): void {
        if (LOG_LEVEL_VALUES[level] >= this.currentLevelValue) {
            const timestamp = new Date().toISOString();
            const levelUpper = level.toUpperCase();
            const logFn = console.error; // Use appropriate console method

            // Basic formatting
            const formattedMessage = `${timestamp} [${levelUpper}] ${message}`;

            if (args.length > 0) {
                logFn(formattedMessage, ...args);
            } else {
                logFn(formattedMessage);
            }
        }
    }
}

// Export a singleton instance
export const logger = new Logger();
