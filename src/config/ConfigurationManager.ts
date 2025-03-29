import * as fs from 'fs/promises';
import * as path from 'path';
import { Config, ServerConfig, GatewaySettings, ValidationResult } from '../types/configTypes.js';
import { logger } from '../utils/logger.js'; // Use the logger for internal messages

// Default values for gateway settings
const DEFAULT_GATEWAY_SETTINGS: Required<Omit<GatewaySettings, 'wsPort'>> & Pick<GatewaySettings, 'wsPort'> = {
    ssePort: 8080,
    sseHost: 'localhost',
    ssePath: '/events',
    logLevel: 'info',
    wsPort: 8081, // Default WebSocket port
};

// Default values for server config
const DEFAULT_SERVER_CONFIG: Pick<Required<ServerConfig>, 'args' | 'env' | 'workingDir' | 'autoRestart' | 'maxRestarts'> = {
    args: [],
    env: {},
    workingDir: process.cwd(), // Default to gateway's CWD
    autoRestart: false,
    maxRestarts: 3,
};

/**
 * Manages loading, validation, and access to the MCP Gateway configuration.
 * Implemented as a singleton.
 */
export class ConfigurationManager {
    private static instance: ConfigurationManager;
    private config: Config | null = null;
    private isInitialized = false;

    // Private constructor for singleton pattern
    private constructor() { }

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
     * This must be called before accessing configuration values.
     * @param configPath - The absolute or relative path to the configuration JSON file.
     * @returns A promise that resolves when configuration is loaded and validated, or rejects on error.
     * @throws If the configuration file cannot be read, parsed, or is invalid.
     */
    public async loadConfig(configPath: string): Promise<void> {
        if (this.isInitialized) {
            logger.warn('Configuration already initialized. Ignoring subsequent loadConfig call.');
            return;
        }

        logger.info(`Loading configuration from: ${configPath}`);
        const absolutePath = path.resolve(configPath);

        try {
            const fileContent = await fs.readFile(absolutePath, 'utf-8');
            const rawConfig = JSON.parse(fileContent);

            const validationResult = this.validateConfig(rawConfig);
            if (!validationResult.isValid) {
                throw new Error(`Invalid configuration:\n- ${validationResult.errors.join('\n- ')}`);
            }

            this.config = this.processConfig(rawConfig as Config); // Apply defaults and substitutions
            this.isInitialized = true;
            logger.info('Configuration loaded and validated successfully.');

            // Apply log level from config if present
            const gatewaySettings = this.getGatewaySettings();
            if (gatewaySettings.logLevel) {
                logger.setLevel(gatewaySettings.logLevel);
            }

        } catch (error: any) {
            logger.error(`Failed to load or validate configuration from ${absolutePath}: ${error.message}`);
            throw error; // Re-throw to halt initialization if config is critical
        }
    }

    /**
     * Validates the raw configuration object structure.
     * @param rawConfig - The raw object parsed from JSON.
     * @returns A ValidationResult object.
     */
    private validateConfig(rawConfig: any): ValidationResult {
        const errors: string[] = [];

        if (typeof rawConfig !== 'object' || rawConfig === null) {
            return { isValid: false, errors: ['Configuration must be a JSON object.'] };
        }

        if (typeof rawConfig.mcpServers !== 'object' || rawConfig.mcpServers === null) {
            errors.push('Missing or invalid "mcpServers" object.');
        } else {
            for (const serverId in rawConfig.mcpServers) {
                const serverConf = rawConfig.mcpServers[serverId];
                if (typeof serverConf !== 'object' || serverConf === null) {
                    errors.push(`Invalid configuration for server "${serverId}". Must be an object.`);
                    continue;
                }
                if (typeof serverConf.command !== 'string' || !serverConf.command) {
                    errors.push(`Missing or invalid "command" (string) for server "${serverId}".`);
                }
                if (serverConf.args !== undefined && !Array.isArray(serverConf.args)) {
                    errors.push(`Invalid "args" (must be an array of strings) for server "${serverId}".`);
                }
                if (serverConf.env !== undefined && typeof serverConf.env !== 'object') {
                    errors.push(`Invalid "env" (must be an object) for server "${serverId}".`);
                }
                // Add more checks for types (workingDir: string, autoRestart: boolean, maxRestarts: number)
            }
        }

        if (rawConfig.settings !== undefined && (typeof rawConfig.settings !== 'object' || rawConfig.settings === null)) {
            errors.push('Optional "settings" field must be an object if present.');
        } else if (rawConfig.settings) {
            const settings = rawConfig.settings;
            // Allow ssePort to be null or undefined, only validate if it's explicitly set to something else
            if (settings.ssePort !== undefined && settings.ssePort !== null && typeof settings.ssePort !== 'number') {
                errors.push('Invalid "settings.ssePort" (must be a number or null/undefined).');
            }
            // Allow wsPort to be null or undefined, only validate if it's explicitly set to something else
            if (settings.wsPort !== undefined && settings.wsPort !== null && typeof settings.wsPort !== 'number') {
                errors.push('Invalid "settings.wsPort" (must be a number).');
            }
            if (settings.logLevel !== undefined && !['error', 'warn', 'info', 'debug'].includes(settings.logLevel)) {
                errors.push('Invalid "settings.logLevel" (must be one of error, warn, info, debug).');
            }
            // Add checks for sseHost, ssePath
        }


        return { isValid: errors.length === 0, errors };
    }

    /**
     * Processes the validated configuration by applying defaults and substitutions.
     * @param config - The validated configuration object.
     * @returns The processed configuration object with defaults applied.
     */
    private processConfig(config: Config): Config {
        const processedConfig: Config = {
            mcpServers: {},
            settings: { ...DEFAULT_GATEWAY_SETTINGS, ...(config.settings || {}) },
        };

        for (const serverId in config.mcpServers) {
            const originalServerConf = config.mcpServers[serverId];
            const processedServerConf: Required<ServerConfig> = {
                ...DEFAULT_SERVER_CONFIG,
                ...originalServerConf, // Override defaults with provided values
                command: originalServerConf.command, // Ensure command is not overwritten by defaults spread
                env: this.substituteEnvVars({ ...DEFAULT_SERVER_CONFIG.env, ...(originalServerConf.env || {}) }), // Substitute after merging
            };
            // Ensure workingDir is absolute
            processedServerConf.workingDir = path.resolve(processedServerConf.workingDir);

            processedConfig.mcpServers[serverId] = processedServerConf;
        }

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
            substitutedEnv[key] = envRecord[key].replace(/\$\{([^}]+)\}/g, (_, varName) => {
                return process.env[varName] || ''; // Replace with env var or empty string if not found
            });
        }
        return substitutedEnv;
    }


    /**
     * Gets the configuration for a specific server.
     * @param serverId - The unique identifier of the server.
     * @returns The ServerConfig object or undefined if not found or not initialized.
     */
    public getServerConfig(serverId: string): ServerConfig | undefined {
        this.ensureInitialized();
        return this.config?.mcpServers[serverId];
    }

    /**
     * Gets all server configurations.
     * @returns A map of serverId to ServerConfig, or an empty map if not initialized.
     */
    public getAllServerConfigs(): { [serverId: string]: ServerConfig } {
        this.ensureInitialized();
        return this.config?.mcpServers || {};
    }


    /**
 * Gets the gateway-specific settings.
 * @returns The GatewaySettings object with defaults applied, or default settings if not initialized.
 */
    public getGatewaySettings(): Required<Omit<GatewaySettings, 'wsPort'>> & Pick<GatewaySettings, 'wsPort'> {
        // Return defaults even if not fully initialized, as logger might need level early
        // Need to handle the potentially optional wsPort correctly if we didn't give it a default
        // But since we gave it a default, casting should be okay.
        return this.config?.settings as Required<Omit<GatewaySettings, 'wsPort'>> & Pick<GatewaySettings, 'wsPort'> ?? DEFAULT_GATEWAY_SETTINGS;
    }

    /**
     * Throws an error if the configuration manager hasn't been initialized.
     */
    private ensureInitialized(): void {
        if (!this.isInitialized || !this.config) {
            throw new Error('ConfigurationManager not initialized. Call loadConfig() first.');
        }
    }
}
