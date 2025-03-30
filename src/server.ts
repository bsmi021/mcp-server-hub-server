import path from 'path';
import { fileURLToPath } from 'url'; // Needed to get __dirname in ES modules
import { ConfigurationManager } from './config/ConfigurationManager.js';
import { ServerManager } from './managers/ServerManager.js';
import { ToolRegistry } from './managers/ToolRegistry.js';
import { StdioInterface } from './interfaces/StdioInterface.js';
// import { SseInterface } from './interfaces/SseInterface.js'; // Comment out or remove SSE
import { WebSocketInterface } from './interfaces/WebSocketInterface.js'; // Import WebSocketInterface
import { ExampleConfigurableService } from './services/ExampleConfigurableService.js'; // Import Example Service
import { logger } from './utils/logger.js';

// --- Configuration Loading ---
// Determine the directory of the current script
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define the expected config file name and path relative to the script directory
const configFileName = 'mcp_hub_config.json';
const configPath = path.resolve(__dirname, configFileName); // Assumes config is in the same dir as built server.js

// --- Main Application ---
async function main() {
    logger.info('--- MCP Gateway Server Starting ---');

    // 1. Initialize Core Components
    const configManager = ConfigurationManager.getInstance();
    let serverManager: ServerManager | null = null;
    let toolRegistry: ToolRegistry | null = null;
    let stdioInterface: StdioInterface | null = null;
    // let sseInterface: SseInterface | null = null; // Comment out or remove SSE
    let webSocketInterface: WebSocketInterface | null = null;
    let exampleService: ExampleConfigurableService | null = null; // Add example service instance

    try {
        // 2. Initialize Managers (they need to exist to subscribe to config events)
        serverManager = new ServerManager(configManager);
        toolRegistry = new ToolRegistry(serverManager, configManager);
        // DO NOT instantiate services/interfaces yet

        // 3. Load Configuration (This will emit events that managers listen for)
        await configManager.loadConfig(configPath);
        // Logger level is set automatically by configManager after loading

        // 4. Initialize Services and Interfaces AFTER config is loaded
        // Now they will get the correct initial config in their constructors
        exampleService = new ExampleConfigurableService(configManager); // Instantiate example service
        stdioInterface = new StdioInterface(toolRegistry, serverManager, configManager); // Pass configManager
        // sseInterface = new SseInterface(toolRegistry, serverManager, configManager); // Comment out or remove SSE
        webSocketInterface = new WebSocketInterface(toolRegistry, serverManager, configManager); // Initialize WebSocketInterface

        // 5. Start Interfaces (Start listening for clients)
        // Start STDIO unconditionally as it's the primary interface
        await stdioInterface.start();
        // Start WebSocket only if configured
        await webSocketInterface.start(); // start() checks internally if wsPort is configured

        // 6. Start Managed Servers
        // This happens after interfaces are ready to potentially receive immediate client requests
        serverManager.startAllServers(); // Spawns processes, ToolRegistry handles discovery via events

        logger.info('--- MCP Gateway Server Ready ---');

    } catch (error: any) {
        logger.error(`Fatal error during startup: ${error.message}`, error);
        // Attempt graceful shutdown of any components that might have started
        await shutdown(stdioInterface, webSocketInterface, serverManager, exampleService, 1); // Pass exampleService
        return; // Ensure we don't proceed after fatal error
    }

    // --- Graceful Shutdown Handling ---
    const handleShutdown = async (signal: string) => {
        logger.info(`Received ${signal}. Shutting down gracefully...`);
        await shutdown(stdioInterface, webSocketInterface, serverManager, exampleService, 0); // Pass exampleService
    };

    process.on('SIGINT', () => handleShutdown('SIGINT')); // Ctrl+C
    process.on('SIGTERM', () => handleShutdown('SIGTERM')); // Termination signal
    process.on('uncaughtException', async (error) => {
        logger.error('Unhandled Exception:', error);
        await shutdown(stdioInterface, webSocketInterface, serverManager, exampleService, 1); // Pass exampleService
    });
    process.on('unhandledRejection', async (reason, promise) => {
        logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
        await shutdown(stdioInterface, webSocketInterface, serverManager, exampleService, 1); // Pass exampleService
    });

}

/**
 * Gracefully shuts down all components.
 */
async function shutdown(
    stdio: StdioInterface | null,
    ws: WebSocketInterface | null,
    manager: ServerManager | null,
    exampleSvc: ExampleConfigurableService | null, // Add example service
    exitCode: number
): Promise<void> {
    logger.info('Initiating shutdown sequence...');
    try {
        // Stop interfaces first
        await Promise.allSettled([
            stdio?.stop(),
            ws?.stop()
        ]);
        logger.info('Interfaces stopped.');

        // Stop services
        exampleSvc?.destroy(); // Call destroy on example service
        logger.info('Services stopped.');

        // Stop managed servers
        if (manager) {
            await manager.stopAllServers(); // This handles graceful shutdown of child processes
            logger.info('Server manager stopped.');
        }
    } catch (error: any) {
        logger.error(`Error during shutdown: ${error.message}`, error);
        exitCode = exitCode || 1; // Ensure non-zero exit code on shutdown error
    } finally {
        logger.info(`--- MCP Gateway Server Exiting (Code: ${exitCode}) ---`);
        process.exit(exitCode);
    }
}

// --- Run Main ---
main().catch(async (error) => {
    // Catch errors specifically from the main async function itself
    logger.error(`Unhandled error in main function: ${error.message}`, error);
    // Attempt shutdown even if main fails early
    await shutdown(null, null, null, null, 1); // Pass nulls for interfaces/services
});
