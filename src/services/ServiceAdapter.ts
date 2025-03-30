import { EventEmitter } from 'events';
import { ConfigurationManager } from '../config/ConfigurationManager.js';
import { Config } from '../types/configTypes.js';
import { logger } from '../utils/logger.js';

/**
 * Abstract base class for services that need to react to configuration changes.
 * Provides common functionality for subscribing to config updates.
 */
export abstract class ServiceAdapter extends EventEmitter {
    protected configManager: ConfigurationManager;
    protected currentConfig: Config | null; // Store the relevant config snapshot

    constructor(configManager: ConfigurationManager) {
        super();
        this.configManager = configManager;
        this.currentConfig = this.configManager.getCurrentConfig(); // Get initial config

        // Subscribe to future changes
        this.configManager.on('configChanged', this.handleConfigUpdate.bind(this));
        logger.debug(`Service adapter "${this.constructor.name}" initialized and listening for config changes.`);
    }

    /**
     * Internal handler called when the global configuration changes.
     * Stores the new config and calls the abstract update method.
     */
    private handleConfigUpdate({ newConfig }: { newConfig: Config }): void {
        logger.debug(`Service adapter "${this.constructor.name}" received config update.`);
        const oldConfig = this.currentConfig;
        this.currentConfig = newConfig;
        // Call the implementation-specific update logic
        try {
            this.updateServiceConfig(newConfig, oldConfig);
        } catch (error: any) {
            logger.error(`Error updating service "${this.constructor.name}" config: ${error.message}`);
            // Optionally revert currentConfig or handle error state?
        }
    }

    /**
     * Abstract method to be implemented by subclasses.
     * This method is called when the configuration has changed, allowing the
     * service to adapt its behavior or internal state.
     * @param newConfig - The complete new configuration object.
     * @param oldConfig - The previous configuration object (can be null on initial load).
     */
    protected abstract updateServiceConfig(newConfig: Config, oldConfig: Config | null): void;

    /**
     * Cleans up resources, like removing the configuration listener.
     * Should be called when the service is stopped or destroyed.
     */
    public destroy(): void {
        logger.debug(`Destroying service adapter "${this.constructor.name}".`);
        this.configManager.off('configChanged', this.handleConfigUpdate.bind(this));
        this.removeAllListeners(); // Clean up any listeners attached to this service
    }
}
