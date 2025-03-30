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
        // No longer call an abstract method here. Subclasses handle specific events.
        // The 'configChanged' event listener on the base class might not even be needed
        // if all updates are handled via specific events from ConfigurationManager.
        // For now, just update the internal currentConfig state.
    }

    // Remove the abstract method - subclasses should listen to specific events now
    // protected abstract updateServiceConfig(newConfig: Config, oldConfig: Config | null): void;

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
