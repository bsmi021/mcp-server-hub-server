const { EventEmitter } = require('events');
const { z } = require('zod');
const path = require('path');

// Import MCP SDK modules
const { Tool, Client, StdioClientTransport } = require('@modelcontextprotocol/sdk/client/index.js');
const { Config } = require('../../src/types/configTypes');

// Define types for our mocks
type MockConfig = {
    mcpServers: Record<string, any>;
    hubTools: Record<string, any>;
} | null;

// --- Mocks ---

// Mock logger first
const { logger } = require('../../src/utils/logger');
jest.mock('../../src/utils/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

// Mock ConfigurationManager Module
const { ConfigurationManager } = require('../../src/config/ConfigurationManager');

// Initialize mock config with proper structure
let mockConfig: MockConfig = {
    mcpServers: {},
    hubTools: {}
};

const configEventEmitter = new EventEmitter();

const mockConfigManagerInstance = {
    getCurrentConfig: jest.fn(() => mockConfig),
    getServerConfig: jest.fn((id: string) => mockConfig?.mcpServers?.[id]),
    getAllServerConfigs: jest.fn(() => mockConfig?.mcpServers ?? {}),
    getGatewaySettings: jest.fn(() => ({ logLevel: 'info' })),
    on: jest.fn((event, listener) => configEventEmitter.on(event, listener)),
    off: jest.fn((event, listener) => configEventEmitter.off(event, listener)),
    loadConfig: jest.fn(async () => { }),
    closeWatcher: jest.fn(async () => { }),
};
jest.mock('../../src/config/ConfigurationManager', () => ({
    ConfigurationManager: {
        getInstance: jest.fn(() => mockConfigManagerInstance)
    }
}));

// Mock ServerManager Module
const { ServerManager } = require('../../src/managers/ServerManager');
const serverEventEmitter = new EventEmitter();

const mockServerManagerInstance = {
    onServerStatusChange: jest.fn((listener) => serverEventEmitter.on('statusChange', listener)),
    offServerStatusChange: jest.fn((listener) => serverEventEmitter.off('statusChange', listener)),
    getServerInstance: jest.fn(),
};
jest.mock('../../src/managers/ServerManager', () => ({
    ServerManager: jest.fn().mockImplementation(() => mockServerManagerInstance)
}));

// Mock SDK Client/Transport (needed for discoverTools test)
type ListToolsResponse = {
    tools: Array<typeof Tool>;
};

const mockSdkClientInstance = {
    listTools: jest.fn(async (): Promise<ListToolsResponse> => ({ tools: [] })),
    close: jest.fn(async () => { }),
    connect: jest.fn(async () => { }),
};
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: jest.fn(() => mockSdkClientInstance),
    Tool: jest.fn(),
}));
jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: jest.fn(() => ({ /* mock transport methods if needed */ }))
}));

// Mock tool handlers
const mockToolHandlers = {
    testTool1: jest.fn(async (args) => ({ content: [{ type: 'text', text: `testTool1 called with ${JSON.stringify(args)}` }] })),
    testTool2: jest.fn(async (args) => ({ content: [{ type: 'text', text: `testTool2 called` }] })),
    newTool: jest.fn(async (args) => ({ content: [] })),
    toolToRemove: jest.fn(async (args) => ({ content: [] })),
    toggleTool: jest.fn(async (args) => ({ content: [] })),
    reloadTool_v1: jest.fn(async (args) => ({ content: [] })),
    reloadTool_v2: jest.fn(async (args) => ({ content: [] })),
};

// Mock tool modules
const mockToolModules = {
    testTool1: { default: mockToolHandlers.testTool1, inputSchema: z.object({ param: z.string().optional() }) },
    testTool2: { default: mockToolHandlers.testTool2, inputSchema: z.object({ param: z.string().optional() }) },
    newTool: { default: mockToolHandlers.newTool, inputSchema: z.object({ param: z.string().optional() }) },
    toolToRemove: { default: mockToolHandlers.toolToRemove, inputSchema: z.object({ param: z.string().optional() }) },
    toggleTool: { default: mockToolHandlers.toggleTool, inputSchema: z.object({ param: z.string().optional() }) },
    reloadTool_v1: { default: mockToolHandlers.reloadTool_v1, inputSchema: z.object({ param: z.string().optional() }) },
    reloadTool_v2: { default: mockToolHandlers.reloadTool_v2, inputSchema: z.object({ param: z.string().optional() }) },
} as const;

// Mock dynamic import
const originalImport = jest.requireActual('module');
// @ts-ignore - TypeScript doesn't like mocking import
jest.spyOn(global, 'import').mockImplementation(async (modulePath) => {
    const baseName = path.basename(modulePath).split('.')[0].split('?')[0];
    if (baseName in mockToolModules) {
        return mockToolModules[baseName];
    }
    return originalImport(modulePath);
});

// --- Import module under test AFTER mocks ---
const { ToolRegistry } = require('../../src/managers/ToolRegistry');

describe('ToolRegistry', () => {
    let toolRegistry;
    // Get instances from the mocked modules
    let configManager = ConfigurationManager.getInstance();
    // Instantiate ServerManager using its mocked constructor
    let serverManager = new ServerManager(configManager);

    beforeEach(async () => {
        // Reset mocks
        jest.clearAllMocks();
        // Reset config manager mock state
        mockConfig = {
            mcpServers: {},
            hubTools: {}
        };
        configManager.getCurrentConfig.mockReturnValue(mockConfig);
        // Clear event listeners
        configEventEmitter.removeAllListeners();
        serverEventEmitter.removeAllListeners();

        // Reset all mock handlers
        Object.values(mockToolHandlers).forEach(handler => {
            handler.mockClear();
        });

        // Reset SDK client mocks
        mockSdkClientInstance.listTools.mockReset().mockResolvedValue({ tools: [] });
        mockSdkClientInstance.close.mockReset().mockResolvedValue();
        mockSdkClientInstance.connect.mockReset().mockResolvedValue();

        // Instantiate ToolRegistry after mocks are ready
        toolRegistry = new ToolRegistry(serverManager, configManager);

        // Allow any initial async processing in constructor to settle
        await new Promise(resolve => setTimeout(resolve, 100));
    });

    it('should initialize without hub tools if initial config is null', () => {
        mockConfig = null;
        configManager.getCurrentConfig.mockReturnValue(null);
        toolRegistry = new ToolRegistry(serverManager, configManager);
        expect(toolRegistry.getAllTools().size).toBe(0);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Initial config not available'));
    });

    it('should load initial hub tools from config', async () => {
        // Define initial config with required fields
        mockConfig = {
            mcpServers: {},
            hubTools: {
                testTool1: { modulePath: './testTool1.js', handlerExport: 'default', enabled: true, description: 'Test Tool 1' }
            }
        };
        configManager.getCurrentConfig.mockReturnValue(mockConfig);

        // Re-initialize ToolRegistry *after* setting mockConfig
        toolRegistry = new ToolRegistry(serverManager, configManager);
        await new Promise(process.nextTick); // Allow async processing

        expect(toolRegistry.getAllTools().size).toBe(1);
        const toolDef = toolRegistry.getTool('hub__testTool1');
        expect(toolDef).toBeDefined();
        expect(toolDef?.isHubTool).toBe(true);
        expect(toolDef?.name).toBe('testTool1');
        expect(toolDef?.gatewayToolName).toBe('hub__testTool1');
        expect(toolDef?.description).toBe('Test Tool 1');
        expect(toolDef?.enabled).toBe(true);
        expect(toolDef?.handler).toBeDefined();
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Successfully loaded and registered hub tool: hub__testTool1'));
    });

    it('should register tools from a starting server', async () => {
        const serverId = 'serverA';
        const serverTool: Tool = { name: 'serverTool1', description: 'Server Tool 1', inputSchema: { type: 'object' } };
        mockSdkClientInstance.listTools.mockResolvedValue({ tools: [serverTool] } as ListToolsResponse);

        // Simulate server starting event
        serverEventEmitter.emit('statusChange', serverId, 'starting', { id: serverId, config: { command: 'cmd' } }); // Simplified instance

        // Wait for async discovery to potentially complete
        await new Promise(resolve => setTimeout(resolve, 100)); // Adjust timing if needed

        expect(mockSdkClientInstance.listTools).toHaveBeenCalled();
        expect(toolRegistry.getAllTools().size).toBe(1);
        const toolDef = toolRegistry.getTool('serverA__serverTool1');
        expect(toolDef).toBeDefined();
        expect(toolDef?.isHubTool).toBe(false);
        expect(toolDef?.serverId).toBe(serverId);
        expect(toolDef?.name).toBe('serverTool1');
    });

    it('should remove tools when a server stops', async () => {
        // First register a server tool (manually call the private method for test setup)
        // Provide a valid minimal JSON schema
        toolRegistry['registerServerTool']('serverA', { name: 'serverTool1', inputSchema: { type: 'object' } });
        expect(toolRegistry.getAllTools().size).toBe(1);

        // Simulate server stopping event
        serverEventEmitter.emit('statusChange', 'serverA', 'stopped', { id: 'serverA', config: {} });

        expect(toolRegistry.getAllTools().size).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Removed 1 tools for stopped/errored server: serverA'));
    });


    it('should add a hub tool when config changes', async () => {
        mockConfig = { mcpServers: {} }; // Start with no hub tools
        toolRegistry = new ToolRegistry(serverManager, configManager);
        await new Promise(process.nextTick); // Allow initial processing

        expect(toolRegistry.getAllTools().size).toBe(0);

        // Define new config with required fields
        const newConfig: Config = {
            mcpServers: {},
            hubTools: {
                newTool: { modulePath: './newTool.js', handlerExport: 'default', enabled: true }
            }
        };

        // Simulate config change event
        configEventEmitter.emit('configChanged', { newConfig });
        await new Promise(resolve => setTimeout(resolve, 10)); // Allow async processing

        expect(toolRegistry.getAllTools().size).toBe(1);
        expect(toolRegistry.getTool('hub__newTool')).toBeDefined();
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Successfully loaded and registered hub tool: hub__newTool'));
    });

    it('should remove a hub tool when config changes', async () => {
        // Define initial config with required fields
        mockConfig = {
            mcpServers: {},
            hubTools: {
                toolToRemove: { modulePath: './toolToRemove.js', handlerExport: 'default', enabled: true }
            }
        };
        configManager.getCurrentConfig.mockReturnValue(mockConfig);
        toolRegistry = new ToolRegistry(serverManager, configManager);
        await new Promise(process.nextTick); // Allow initial load

        expect(toolRegistry.getAllTools().size).toBe(1);

        const newConfig: Config = { mcpServers: {}, hubTools: {} }; // Empty hubTools

        // Simulate config change event
        configEventEmitter.emit('configChanged', { newConfig });
        await new Promise(resolve => setTimeout(resolve, 10)); // Allow async processing

        expect(toolRegistry.getAllTools().size).toBe(0);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Unloaded and removed hub tool "toolToRemove" (hub__toolToRemove)'));
    });

    it('should disable/enable a hub tool when config changes', async () => {
        // Define initial config with required fields
        const toolName = 'toggleTool';
        const initialHubToolConfig: Config = {
            mcpServers: {},
            hubTools: {
                [toolName]: { modulePath: './toggleTool.js', handlerExport: 'default', enabled: true }
            }
        };
        mockConfig = initialHubToolConfig;
        configManager.getCurrentConfig.mockReturnValue(mockConfig);
        toolRegistry = new ToolRegistry(serverManager, configManager);
        await new Promise(process.nextTick);

        expect(toolRegistry.getTool(`hub__${toolName}`)?.enabled).toBe(true);

        // Disable tool
        const disableConfig: Config = {
            mcpServers: {},
            hubTools: {
                [toolName]: { ...initialHubToolConfig.hubTools[toolName], enabled: false }
            }
        };
        configEventEmitter.emit('configChanged', { newConfig: disableConfig });
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(toolRegistry.getTool(`hub__${toolName}`)?.enabled).toBe(false);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(`Hub tool "${toolName}" (hub__${toolName}) disabled via configuration.`));

        // Re-enable tool
        const enableConfig: Config = {
            mcpServers: {},
            hubTools: {
                [toolName]: { ...initialHubToolConfig.hubTools[toolName], enabled: true }
            }
        };
        configEventEmitter.emit('configChanged', { newConfig: enableConfig });
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(toolRegistry.getTool(`hub__${toolName}`)?.enabled).toBe(true);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(`Hub tool "${toolName}" (hub__${toolName}) re-enabled.`));
    });

    it('should reload a hub tool if modulePath changes', async () => {
        // Define initial config with required fields
        const toolName = 'reloadTool';
        const v1Config: Config = {
            mcpServers: {},
            hubTools: {
                [toolName]: { modulePath: './reloadTool_v1.js', handlerExport: 'default', enabled: true }
            }
        };
        mockConfig = v1Config;
        configManager.getCurrentConfig.mockReturnValue(mockConfig);
        toolRegistry = new ToolRegistry(serverManager, configManager);
        await new Promise(process.nextTick);

        const initialToolDef = toolRegistry.getTool(`hub__${toolName}`);
        expect(initialToolDef?.modulePath).toBe('./reloadTool_v1.js');

        // Define updated config with required fields
        const v2Config: Config = {
            mcpServers: {},
            hubTools: {
                [toolName]: { ...v1Config.hubTools[toolName], modulePath: './reloadTool_v2.js' }
            }
        };
        const updatedConfig: Config = v2Config;

        configEventEmitter.emit('configChanged', { newConfig: updatedConfig });
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(`Hub tool "${toolName}" configuration changed, attempting reload...`));
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(`Successfully loaded and registered hub tool: hub__${toolName}`));
        const updatedToolDef = toolRegistry.getTool(`hub__${toolName}`);
        expect(updatedToolDef?.modulePath).toBe('./reloadTool_v2.js');
    });

    it('should handle errors when loading a hub tool module', async () => {
        mockConfig = { mcpServers: {} };
        configManager.getCurrentConfig.mockReturnValue(mockConfig);
        toolRegistry = new ToolRegistry(serverManager, configManager);
        await new Promise(process.nextTick);

        // Define config with required fields
        const errorConfig: Config = {
            mcpServers: {},
            hubTools: {
                errorTool: { modulePath: './errorTool.js', handlerExport: 'default', enabled: true }
            }
        };
        // Simulate import failure by *not* setting up a mock module for errorTool.js
        // The dynamic import in loadAndRegisterHubTool should fail.

        configEventEmitter.emit('configChanged', { newConfig: errorConfig });
        await new Promise(resolve => setTimeout(resolve, 10)); // Allow async processing

        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to load hub tool "errorTool"'), expect.any(Error));
        expect(toolRegistry.getTool('hub__errorTool')).toBeUndefined(); // Should not be registered
    });

    // TODO: Add tests for callTool routing (hub vs server)
    // TODO: Add tests for listTools schema conversion (requires zod-to-json-schema)

});
