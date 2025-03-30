import * as fs from 'fs/promises';
import * as path from 'path';
import { EventEmitter } from 'events';
import chokidar, { FSWatcher } from 'chokidar';
import { z } from 'zod';
import { Config, ServerConfig, GatewaySettings, ConfigSchema, HubToolConfig } from '../types/configTypes.js'; // Import HubToolConfig
import { logger } from '../utils/logger.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'; // Correct import with .js extension
import { ConfigEvents, ServerAddedPayload, ServerRemovedPayload, ServerUpdatedPayload, HubToolAddedPayload, HubToolRemovedPayload, HubToolUpdatedPayload, SettingsUpdatedPayload, ExampleServiceUpdatedPayload, ConfigProcessedPayload } from '../types/eventTypes.js'; // Import new event types (Added ExampleServiceUpdatedPayload)

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
            const errorMessage = `FATAL: Failed to load initial configuration from ${this.configPath ?? configPath}: ${error.message}`;
            logger.error(errorMessage, error); // Log the original error too
            // Use InternalError for initial load failures as InitializationError isn't standard
            throw new McpError(ErrorCode.InternalError, `Failed to load initial config: ${error.message}`, error);
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

            // --- Diffing and Emitting Granular Events ---
            const oldParsedConfig = oldConfig ? JSON.parse(oldConfig) as Config : null;
            let changesDetected = false;

            if (oldParsedConfig) { // Only diff if there was a previous config
                changesDetected = this.diffAndEmitChanges(oldParsedConfig, this.config);
            } else {
                // Initial load: emit 'added' events for everything present
                logger.info('Initial configuration processed. Emitting initial state events.');
                this.emitInitialStateEvents(this.config);
                changesDetected = true; // Mark as changed for the final event
            }

            // Emit a final event indicating processing is complete, regardless of specific changes found (unless identical)
            if (oldConfig !== newConfigString) {
                this.emit(ConfigEvents.CONFIG_CHANGED_PROCESSED, { oldConfig: oldParsedConfig, newConfig: this.config } as ConfigProcessedPayload);
            } else if (oldConfig === null) {
                // Also emit for initial load completion
                this.emit(ConfigEvents.CONFIG_CHANGED_PROCESSED, { oldConfig: null, newConfig: this.config } as ConfigProcessedPayload);
            }
            else {
                logger.info('Configuration file reloaded, but no effective changes detected after processing.');
            }

        } catch (error: any) {
            const loadError = new Error(`Failed to load, parse, or validate configuration from ${filePath}: ${error.message}`);
            logger.error(loadError.message, error); // Log original error as details
            // Don't update this.config on error, keep the old valid one active
            throw loadError; // Re-throw as a generic error for reload failures
        }
    }

    /**
     * Compares the old and new configuration to identify changes and emit specific events.
     * @param oldConfig - The previous configuration object.
     * @param newConfig - The new configuration object.
     * @returns True if any changes were detected and events emitted, false otherwise.
     */
    private diffAndEmitChanges(oldConfig: Config, newConfig: Config): boolean {
        let changed = false;
        const oldServers = oldConfig.mcpServers || {};
        const newServers = newConfig.mcpServers || {};
        const oldHubTools = oldConfig.hubTools || {};
        const newHubTools = newConfig.hubTools || {};
        const oldSettings = oldConfig.settings || {};
        const newSettings = newConfig.settings || {};

        const oldServerIds = new Set(Object.keys(oldServers));
        const newServerIds = new Set(Object.keys(newServers));
        const oldHubToolNames = new Set(Object.keys(oldHubTools));
        const newHubToolNames = new Set(Object.keys(newHubTools));

        // Check for added/updated servers
        for (const serverId of newServerIds) {
            const newConf = newServers[serverId] as Required<ServerConfig>; // Assume processed
            if (!oldServerIds.has(serverId)) {
                logger.info(`Detected added server: ${serverId}`);
                this.emit(ConfigEvents.SERVER_ADDED, { serverId, config: newConf } as ServerAddedPayload);
                changed = true;
            } else {
                const oldConf = oldServers[serverId] as Required<ServerConfig>;
                if (JSON.stringify(oldConf) !== JSON.stringify(newConf)) {
                    logger.info(`Detected updated server: ${serverId}`);
                    this.emit(ConfigEvents.SERVER_UPDATED, { serverId, newConfig: newConf, oldConfig: oldConf } as ServerUpdatedPayload);
                    changed = true;
                }
            }
        }
        // Check for removed servers
        for (const serverId of oldServerIds) {
            if (!newServerIds.has(serverId)) {
                logger.info(`Detected removed server: ${serverId}`);
                this.emit(ConfigEvents.SERVER_REMOVED, { serverId } as ServerRemovedPayload);
                changed = true;
            }
        }

        // Check for added/updated hub tools
        for (const toolName of newHubToolNames) {
            const newConf = newHubTools[toolName];
            const gatewayToolName = `hub__${toolName}`; // Consistent naming
            if (!oldHubToolNames.has(toolName)) {
                logger.info(`Detected added hub tool: ${toolName}`);
                this.emit(ConfigEvents.HUB_TOOL_ADDED, { toolName, gatewayToolName, config: newConf } as HubToolAddedPayload);
                changed = true;
            } else {
                const oldConf = oldHubTools[toolName];
                if (JSON.stringify(oldConf) !== JSON.stringify(newConf)) {
                    logger.info(`Detected updated hub tool: ${toolName}`);
                    this.emit(ConfigEvents.HUB_TOOL_UPDATED, { toolName, gatewayToolName, newConfig: newConf, oldConfig: oldConf } as HubToolUpdatedPayload);
                    changed = true;
                }
            }
        }
        // Check for removed hub tools
        for (const toolName of oldHubToolNames) {
            if (!newHubToolNames.has(toolName)) {
                const gatewayToolName = `hub__${toolName}`;
                logger.info(`Detected removed hub tool: ${toolName}`);
                this.emit(ConfigEvents.HUB_TOOL_REMOVED, { toolName, gatewayToolName } as HubToolRemovedPayload);
                changed = true;
            }
        }

        // Check for updated settings
        // Ensure comparison handles defaults correctly by comparing processed/defaulted objects
        const processedOldSettings = { ...DEFAULT_GATEWAY_SETTINGS, ...oldSettings };
        const processedNewSettings = { ...DEFAULT_GATEWAY_SETTINGS, ...newSettings };
        if (JSON.stringify(processedOldSettings) !== JSON.stringify(processedNewSettings)) {
            logger.info(`Detected updated settings.`);
            this.emit(ConfigEvents.SETTINGS_UPDATED, { newSettings: processedNewSettings, oldSettings: processedOldSettings } as SettingsUpdatedPayload);
            changed = true;
        }

        // Check for updated exampleService settings
        // Import DEFAULT_EXAMPLE_SETTINGS if needed, or define it here/in configTypes
        // Assuming DEFAULT_EXAMPLE_SETTINGS is accessible or defined in configTypes
        const oldExampleSettings = oldConfig.exampleService; // Already processed/defaulted if it existed
        const newExampleSettings = newConfig.exampleService; // Already processed/defaulted
        // Need to handle cases where the section might not exist in old/new config after processing
        // Let's assume processConfig ensures the section exists with defaults if defined in schema
        if (JSON.stringify(oldExampleSettings) !== JSON.stringify(newExampleSettings)) {
            // Need to ensure we have the Required<> type after defaults applied by Zod/processConfig
            // This might require adjusting processConfig or using defaults here.
            // For now, assume they are correctly defaulted if present.
            // We need the DEFAULT_EXAMPLE_SETTINGS from ExampleConfigurableService or configTypes.
            // Let's import it or define it. For simplicity, assume it's imported/available.
            // const DEFAULT_EXAMPLE_SETTINGS = ... // Assume imported or defined
            const processedOldExample = { /* ...DEFAULT_EXAMPLE_SETTINGS, */ ...(oldExampleSettings || {}) };
            const processedNewExample = { /* ...DEFAULT_EXAMPLE_SETTINGS, */ ...(newExampleSettings || {}) };

            // Re-check after applying defaults explicitly if needed
            if (JSON.stringify(processedOldExample) !== JSON.stringify(processedNewExample)) {
                logger.info(`Detected updated exampleService settings.`);
                // TODO: Ensure the payload types match Required<ExampleServiceSettings>
                this.emit(ConfigEvents.EXAMPLE_SERVICE_UPDATED, {
                    newSettings: processedNewExample, // Cast might be needed
                    oldSettings: processedOldExample  // Cast might be needed
                } as ExampleServiceUpdatedPayload);
                changed = true;
            }
        }


        if (!changed) {
            logger.info('Configuration file reloaded, but no effective changes detected after diffing.');
        }
        return changed;
    }

    /**
     * Emits initial 'added' events for all items present in the first loaded configuration.
     * @param initialConfig - The initially loaded and processed configuration.
     */
    private emitInitialStateEvents(initialConfig: Config): void {
        // Emit server added events
        for (const serverId in initialConfig.mcpServers) {
            this.emit(ConfigEvents.SERVER_ADDED, {
                serverId,
                config: initialConfig.mcpServers[serverId] as Required<ServerConfig>
            } as ServerAddedPayload);
        }
        // Emit hub tool added events
        for (const toolName in initialConfig.hubTools) {
            const gatewayToolName = `hub__${toolName}`;
            this.emit(ConfigEvents.HUB_TOOL_ADDED, {
                toolName,
                gatewayToolName,
                config: initialConfig.hubTools[toolName]
            } as HubToolAddedPayload);
        }
        // Emit initial settings (treat as update from defaults)
        const processedSettings = { ...DEFAULT_GATEWAY_SETTINGS, ...(initialConfig.settings || {}) };
        this.emit(ConfigEvents.SETTINGS_UPDATED, {
            newSettings: processedSettings,
            oldSettings: DEFAULT_GATEWAY_SETTINGS // Compare against initial defaults
        } as SettingsUpdatedPayload);
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
     * Gets the currently loaded and processed configuration object.
     * Returns null if the configuration has not been successfully loaded yet.
     * Use getters like `getServerConfig` or `getGatewaySettings` for type safety and guaranteed structure.
     * @returns The current Config object or null.
     */
    public getCurrentConfig(): Config | null {
        // No ensureConfigLoaded() check here, as it might be called before initial load completes
        return this.config;
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
