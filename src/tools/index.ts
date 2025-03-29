import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConfigurationManager } from "../config/ConfigurationManager.js";
import { logger } from "../utils/index.js";

// Import tool registration functions
// import { yourTool } from "./yourTool.js"; // Add new tool imports here

/**
 * Register all defined tools with the MCP server instance.
 * This function centralizes tool registration logic.
 */
export function registerTools(server: McpServer): void {
    logger.info("Registering tools...");
    const configManager = ConfigurationManager.getInstance();

    // Register each tool, passing necessary config or services
    // yourTool(server, configManager.getYourServiceConfig()); // Add new tool registrations

    logger.info("All tools registered.");
}
