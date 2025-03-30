import * as fs from 'fs/promises';
import * as path from 'path';
import { EventEmitter } from 'events';
import chokidar, { FSWatcher } from 'chokidar';
import { z } from 'zod';
import { Config, ServerConfig, GatewaySettings, ConfigSchema } from '../types/configTypes.js';
import { logger } from '../utils/logger.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'; // Correct import with .js extension

// Default values for gateway settings - Ensure this aligns with ConfigSchema defaults if any
const DEFAULT_GATEWAY_SETTINGS: Required<Omit<GatewaySettings, 'wsPort'>> & Pick<GatewaySettings, 'wsPort'> = {
    ssePort: 8080,
    sseHost: 'localhost',
    ssePath: '/events',
    logLevel: 'info',
    wsPort: 8081, // Default WebSocket port
};

// Default values for server config - Note: workingDir default applied in processConfig
const DEFAULT_SERVER_CONFIG: Pick<Required<ServerConfig>, 'args' | 'env' | 'autoRestart' | 'maxRestarts'> = {
    args: [],
    env: {},
    autoRestart: false,
    maxRestarts: 3,
};

/**
 * Manages loading, validation, dynamic reloading, and access to the MCP Gateway configuration.
 * Emits 'configChanged' event when the configuration is successfully reloaded.
 * Implemented as a singleton.
 */
export class ConfigurationManager extends EventEmitter {
    private static instance: ConfigurationManager;
    private config: Config | null = null;
    private configPath: string | null = null;
    private watcher: FSWatcher | null = null;
    private isLoading = false; // Prevent concurrent reloads
    private debounceTimer: NodeJS.Timeout | null = null;

    // Private constructor for singleton pattern
    private constructor() {
        super();
        // Increase max listeners if many components might listen
        this.setMaxListeners(20);
    }

    /**
     * Gets the singleton instance of the ConfigurationManager.
     * @returns The singleton instance.
     */
    public static getInstance(): ConfigurationManager {
        if (!ConfigurationManager.instance) {
            ConfigurationManager.instance = new ConfigurationManager();
        }
        return ConfigurationManager.instance;
    }

    /**
     * Loads, validates, and processes the configuration from a JSON file.
     * Sets up file watching for dynamic reloads.
     * This must be called once during application initialization.
     * @param configPath - The absolute or relative path to the configuration JSON file.
     * @returns A promise that resolves when configuration is loaded and validated, or rejects on error.
     * @throws If the configuration file cannot be read, parsed, or is invalid during initial load.
     */
    public async loadConfig(configPath: string): Promise<void> {
        // Prevent re-initialization or loading during reload
        if (this.configPath || this.isLoading) {
            logger.warn('Configuration already initialized or currently loading. Ignoring subsequent loadConfig call.');
            return;
        }

        this.isLoading = true; // Set loading flag immediately

        try {
            this.configPath = path.resolve(configPath);
            logger.info(`Loading initial configuration from: ${this.configPath}`);

            await this.loadAndProcessConfig(this.configPath); // Load, validate, process
            this.setupWatcher(); // Setup watcher only after successful initial load

        } catch (error: any) {
            logger.error(`FATAL: Failed to load initial configuration from ${this.configPath ?? configPath}: ${error.message}`);
            // In a real app, might want to exit or enter a degraded state
            throw new McpError(ErrorCode.InvalidParams, `Failed to load initial config: ${error.message}`, error);
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * Internal method to load, parse, validate, and process the configuration file.
     * Updates the internal config state and emits 'configChanged' event if successful and changed.
     * @param filePath The absolute path to the configuration file.
     * @throws If reading, parsing, or validation fails.
     */
    private async loadAndProcessConfig(filePath: string): Promise<void> {
        const oldConfig = this.config ? JSON.stringify(this.config) : null; // Store old state for comparison

        try {
            const fileContent = await fs.readFile(filePath, 'utf-8');
            const rawConfig = JSON.parse(fileContent);

            // Validate using Zod schema
            const validationResult = ConfigSchema.safeParse(rawConfig);
            if (!validationResult.success) {
                const errorMessages = validationResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
                throw new Error(`Invalid configuration schema:\n- ${errorMessages.join('\n- ')}`);
            }

            // Use validated data (Zod applies defaults)
            const validatedConfig = validationResult.data;

            // Apply further processing like env var substitution and path resolution
            const newProcessedConfig = this.processConfig(validatedConfig);
            const newConfigString = JSON.stringify(newProcessedConfig);

            // Update internal state only if validation and processing succeed
            this.config = newProcessedConfig;
            logger.info(`Configuration from ${filePath} loaded and validated successfully.`);

            // Apply log level immediately if changed
            const newLogLevel = this.getGatewaySettings().logLevel;
            if (newLogLevel && newLogLevel !== logger.getLevel()) {
                logger.setLevel(newLogLevel);
                // No need to log here, setLevel already logs
            }

            // Emit event only if config actually changed
            if (oldConfig !== newConfigString) {
                logger.info('Configuration change detected, emitting event.');
                // Provide the processed new config and potentially the old raw string or parsed object
                // For simplicity, just emitting the new config for now. Listeners can fetch old via getter if needed before update.
                this.emit('configChanged', { /* oldConfig: oldConfig ? JSON.parse(oldConfig) : null, */ newConfig: this.config });
            } else if (oldConfig === null) { // Check if it was the initial load
                logger.info('Initial configuration processed.');
            } else {
                logger.info('Configuration file reloaded, but no effective changes detected after processing.');
            }

        } catch (error: any) {
            logger.error(`Failed to load, parse, or validate configuration from ${filePath}: ${error.message}`);
            // Don't update this.config on error, keep the old valid one active
            throw error; // Re-throw to be handled by caller (initial load or watcher handler)
        }
    }

    /**
    * Sets up the file watcher using chokidar.
    */
    private setupWatcher(): void {
        if (!this.configPath) {
            logger.error('Cannot set up watcher without a config path.');
            return; // Should not happen if loadConfig succeeded
        }
        if (this.watcher) {
            logger.warn('Watcher already exists. Closing existing one before creating new.');
            this.watcher.close(); // Close previous watcher if any
        }

        logger.info(`Setting up watcher for configuration file: ${this.configPath}`);
        this.watcher = chokidar.watch(this.configPath, {
            persistent: true,
            ignoreInitial: true, // Don't fire 'add'/'change' on initial scan
            awaitWriteFinish: { // Helps avoid reading incomplete files
                stabilityThreshold: 500,
                pollInterval: 100
            },
            usePolling: process.platform === 'win32' // Use polling on Windows if needed, though awaitWriteFinish might suffice
        });

        this.watcher
            .on('change', () => this.handleFileChange())
            .on('error', (error) => logger.error(`Watcher error: ${error}`))
            .on('ready', () => logger.info(`File watcher ready for ${this.configPath}`));
    }

    /**
     * Handles the file change event from the watcher, debouncing the reload.
     */
    private handleFileChange(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        // Debounce to handle rapid saves or editor behaviors
        this.debounceTimer = setTimeout(async () => {
            if (this.isLoading || !this.configPath) {
                logger.warn('Skipping config reload: Already loading or config path missing.');
                return;
            }

            logger.info(`Configuration file change detected: ${this.configPath}. Debounced reload triggered.`);
            this.isLoading = true;
            try {
                await this.loadAndProcessConfig(this.configPath);
                // Success logged within loadAndProcessConfig
            } catch (error: any) {
                logger.error(`Failed to reload configuration after change: ${error.message}. Keeping previous configuration active.`);
                // Optionally emit a 'configError' event for components to react to failed reloads
                this.emit('configError', error);
            } finally {
                this.isLoading = false;
                this.debounceTimer = null; // Clear timer reference
            }
        }, 500); // 500ms debounce window
    }


    /**
     * Processes the validated configuration by applying substitutions and resolving paths.
     * Assumes input config is already validated by Zod (which applies defaults).
     * @param config - The validated configuration object from Zod.
     * @returns The fully processed configuration object ready for use.
     */
    private processConfig(config: Config): Config {
        // Deep clone to prevent modification of the object returned by Zod parse, if necessary.
        // JSON parse/stringify is a simple way for deep clone without external libs for plain objects.
        const processedConfig: Config = JSON.parse(JSON.stringify(config));

        // Process server configs
        for (const serverId in processedConfig.mcpServers) {
            const serverConf = processedConfig.mcpServers[serverId];

            // Substitute env vars in the env record (Zod default ensures env exists)
            serverConf.env = this.substituteEnvVars(serverConf.env ?? {});

            // Ensure workingDir is absolute and apply default if necessary
            serverConf.workingDir = path.resolve(serverConf.workingDir || process.cwd());

            // Substitute env vars in args (Zod default ensures args exists)
            serverConf.args = (serverConf.args ?? []).map(arg =>
                this.substituteEnvVarInString(arg)
            );

            // Substitute env var in command string
            serverConf.command = this.substituteEnvVarInString(serverConf.command);
        }

        // Process gateway settings if they exist
        if (processedConfig.settings?.ssePath) {
            processedConfig.settings.ssePath = this.substituteEnvVarInString(processedConfig.settings.ssePath);
        }
        // Add substitutions for other settings fields if needed (e.g., sseHost)

        return processedConfig;
    }


    /**
    * Substitutes environment variables in the format ${VAR_NAME} within a record's string values.
    * @param envRecord - The record containing environment variables.
    * @returns A new record with substituted values.
    */
    private substituteEnvVars(envRecord: Record<string, string>): Record<string, string> {
        const substitutedEnv: Record<string, string> = {};
        for (const key in envRecord) {
            substitutedEnv[key] = this.substituteEnvVarInString(envRecord[key]);
        }
        return substitutedEnv;
    }

    /**
     * Substitutes environment variables in the format ${VAR_NAME} within a single string.
     * @param value - The string potentially containing environment variables.
     * @returns The string with substitutions applied.
     */
    private substituteEnvVarInString(value: string): string {
        // Regex to find ${VAR_NAME} patterns
        return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
            return process.env[varName] || ''; // Replace with env var or empty string if not found
        });
    }


    /**
     * Gets the processed configuration for a specific server.
     * Throws error if config not loaded.
     * @param serverId - The unique identifier of the server.
     * @returns The processed ServerConfig object.
     * @throws McpError if configuration is not loaded or serverId is not found.
     */
    public getServerConfig(serverId: string): Required<ServerConfig> {
        this.ensureConfigLoaded();
        const serverConfig = this.config?.mcpServers[serverId];
        if (!serverConfig) {
            throw new McpError(ErrorCode.InvalidParams, `Server configuration not found for ID: ${serverId}`);
        }
        // Type assertion is safe here because processConfig ensures all required fields are present based on defaults
        return serverConfig as Required<ServerConfig>;
    }

    /**
     * Gets all processed server configurations.
     * Throws error if config not loaded.
     * @returns A map of serverId to processed ServerConfig.
     * @throws McpError if configuration is not loaded.
     */
    public getAllServerConfigs(): { [serverId: string]: Required<ServerConfig> } {
        this.ensureConfigLoaded();
        // Type assertion is safe here because processConfig ensures all required fields are present
        return (this.config?.mcpServers ?? {}) as { [serverId: string]: Required<ServerConfig> };
    }


    /**
     * Gets the processed gateway-specific settings.
     * Returns defaults if settings are not specified in the config file.
     * Throws error if config not loaded initially (though defaults might be desired even then).
     * @returns The processed GatewaySettings object.
     */
    public getGatewaySettings(): Required<Omit<GatewaySettings, 'wsPort'>> & Pick<GatewaySettings, 'wsPort'> {
        // Return processed settings if config is loaded, otherwise return static defaults
        // Type assertion okay because Zod/processConfig ensures structure matches defaults + overrides
        const settings = this.config?.settings ?? DEFAULT_GATEWAY_SETTINGS;
        // Ensure the returned type matches the complex Required/Pick structure
        return settings as Required<Omit<GatewaySettings, 'wsPort'>> & Pick<GatewaySettings, 'wsPort'>;
    }

    /**
     * Closes the file watcher gracefully. Should be called on application shutdown.
     */
    public async closeWatcher(): Promise<void> {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.watcher) {
            logger.info('Closing configuration file watcher.');
            await this.watcher.close();
            this.watcher = null; // Clear watcher reference
        }
    }


    /**
     * Throws an error if the configuration hasn't been loaded yet.
     * Used internally before accessing config properties.
     */
    private ensureConfigLoaded(): void {
        if (!this.config || !this.configPath) {
            throw new McpError(ErrorCode.InvalidParams, 'ConfigurationManager not initialized or config not loaded. Call loadConfig() first.');
        }
    }
}
