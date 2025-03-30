import { Config, ServerConfig, HubToolConfig, GatewaySettings, ExampleServiceSettings } from './configTypes.js'; // Added ExampleServiceSettings

// --- Event Names ---
export const ConfigEvents = {
    CONFIG_ERROR: 'configError', // Error during reload
    // Specific change events
    SERVER_ADDED: 'serverAdded',
    SERVER_REMOVED: 'serverRemoved',
    SERVER_UPDATED: 'serverUpdated',
    HUB_TOOL_ADDED: 'hubToolAdded',
    HUB_TOOL_REMOVED: 'hubToolRemoved',
    HUB_TOOL_UPDATED: 'hubToolUpdated',
    SETTINGS_UPDATED: 'settingsUpdated',
    EXAMPLE_SERVICE_UPDATED: 'exampleServiceUpdated', // Added event for example service
    // Maybe keep a general one for broader listeners? Or remove if specific ones cover all cases.
    CONFIG_CHANGED_PROCESSED: 'configChangedProcessed' // Signifies processing complete, even if specific changes emitted
} as const;

// --- Event Payload Types ---

export interface ServerAddedPayload {
    serverId: string;
    config: Required<ServerConfig>; // Use Required as defaults are applied
}

export interface ServerRemovedPayload {
    serverId: string;
    // Optionally include the old config if needed by listeners
    // oldConfig: Required<ServerConfig>;
}

export interface ServerUpdatedPayload {
    serverId: string;
    newConfig: Required<ServerConfig>;
    oldConfig: Required<ServerConfig>;
}

export interface HubToolAddedPayload {
    toolName: string; // Original name
    gatewayToolName: string; // Namespaced name
    config: HubToolConfig;
}

export interface HubToolRemovedPayload {
    toolName: string; // Original name
    gatewayToolName: string; // Namespaced name
    // Optionally include the old config if needed
    // oldConfig: HubToolConfig;
}

export interface HubToolUpdatedPayload {
    toolName: string; // Original name
    gatewayToolName: string; // Namespaced name
    newConfig: HubToolConfig;
    oldConfig: HubToolConfig;
}

export interface SettingsUpdatedPayload {
    newSettings: Required<Omit<GatewaySettings, 'wsPort'>> & Pick<GatewaySettings, 'wsPort'>;
    oldSettings: Required<Omit<GatewaySettings, 'wsPort'>> & Pick<GatewaySettings, 'wsPort'>;
}

// Added payload for example service update
export interface ExampleServiceUpdatedPayload {
    newSettings: Required<ExampleServiceSettings>;
    oldSettings: Required<ExampleServiceSettings>;
}

export interface ConfigProcessedPayload {
    newConfig: Config;
    oldConfig: Config | null;
}

// Type helper for listeners (example)
// type ServerAddedListener = (payload: ServerAddedPayload) => void;
