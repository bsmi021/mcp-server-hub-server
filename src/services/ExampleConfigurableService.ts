import { ServiceAdapter } from './ServiceAdapter.js'; // Base class doesn't need change for this
import { ConfigurationManager } from '../config/ConfigurationManager.js';
import { Config, ExampleServiceSettings } from '../types/configTypes.js';
import { logger } from '../utils/logger.js';
// Import the specific event type and payload
import { ConfigEvents, ExampleServiceUpdatedPayload } from '../types/eventTypes.js';

// Define default settings for this service, aligning with the schema defaults
const DEFAULT_EXAMPLE_SETTINGS: Required<ExampleServiceSettings> = {
    featureFlag: false,
    messagePrefix: "DEFAULT",
};

/**
 * An example service demonstrating how to use ServiceAdapter to react to config changes.
 */
export class ExampleConfigurableService extends ServiceAdapter {
    private serviceSettings: Required<ExampleServiceSettings>;

    constructor(configManager: ConfigurationManager) {
        super(configManager); // Base constructor still needed

        // Initialize with current settings or defaults from the manager
        // Note: Base class constructor already gets initial config, but service might need specific section
        const initialSettings = this.configManager.getCurrentConfig()?.exampleService;
        this.serviceSettings = {
            ...DEFAULT_EXAMPLE_SETTINGS,
            ...(initialSettings || {}),
        };
        logger.info(`ExampleConfigurableService initialized with settings: ${JSON.stringify(this.serviceSettings)}`);

        // Subscribe to the SPECIFIC event for this service's settings
        this.configManager.on(ConfigEvents.EXAMPLE_SERVICE_UPDATED, this.handleServiceConfigUpdate.bind(this));

        // Perform any initial setup based on settings
        this.applyFeatureFlag();
    }

    /**
     * Handler specifically for EXAMPLE_SERVICE_UPDATED events.
     * @param payload - The event payload containing old and new settings for this service.
     */
    private handleServiceConfigUpdate(payload: ExampleServiceUpdatedPayload): void {
        const { newSettings } = payload; // Destructure the specific payload

        // The diffing already happened in ConfigurationManager, so we know settings changed.
        // We receive the already defaulted+processed settings objects.
        logger.info(`ExampleConfigurableService detected settings change. Applying new settings: ${JSON.stringify(newSettings)}`);
        this.serviceSettings = newSettings; // Directly assign the new settings

        // Re-apply settings or trigger actions based on changes
        this.applyFeatureFlag();
        // Example: Notify other parts of the system if needed
        // this.emit('settingsChanged', this.serviceSettings);
    }

    /**
     * Example action based on the current feature flag setting.
     */
    private applyFeatureFlag(): void {
        if (this.serviceSettings.featureFlag) {
            logger.info(`[ExampleService] Feature flag is ENABLED. Performing special action...`);
            // ... logic for when feature is enabled ...
        } else {
            logger.info(`[ExampleService] Feature flag is DISABLED.`);
            // ... logic for when feature is disabled ...
        }
    }

    /**
     * Example method that uses a configured setting.
     */
    public getPrefixedMessage(message: string): string {
        return `[${this.serviceSettings.messagePrefix}] ${message}`;
    }

    /**
     * Overrides the base destroy method to add any service-specific cleanup.
     */
    public override destroy(): void {
        logger.info('ExampleConfigurableService destroying...');
        // Unsubscribe from the specific event
        this.configManager.off(ConfigEvents.EXAMPLE_SERVICE_UPDATED, this.handleServiceConfigUpdate.bind(this));
        // Add any other specific cleanup for this service here
        super.destroy(); // Call base class destroy (which might do nothing now, but good practice)
    }
}
