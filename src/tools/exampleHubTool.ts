import { z } from 'zod';
import { logger } from '../utils/logger.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Config } from '../types/configTypes.js'; // Import Config type

// Define the input schema for the tool using Zod
export const inputSchema = z.object({
    message: z.string().optional().describe("An optional message to include in the log."),
});

// Define the handler function signature, including the 'extra' object which might contain the config snapshot
// Adjust the 'extra' type based on how ToolRegistry passes it (currently { config: Config | null })
type ExampleToolArgs = z.infer<typeof inputSchema>;
type HandlerExtra = { config: Config | null };

/**
 * An example hub tool handler function.
 * Logs a message and returns a simple text response.
 */
const handleExampleTool = async (args: ExampleToolArgs, extra: HandlerExtra): Promise<CallToolResult> => {
    const toolName = 'exampleHubTool'; // Hardcoded for logging clarity
    logger.info(`[${toolName}] Hub tool called.`);
    logger.debug(`[${toolName}] Received args: ${JSON.stringify(args)}`);
    logger.debug(`[${toolName}] Config snapshot available: ${!!extra.config}`);

    const responseMessage = `Hub tool '${toolName}' executed successfully.${args.message ? ` Message: "${args.message}"` : ''}`;
    logger.info(`[${toolName}] Responding: ${responseMessage}`);

    // Return result conforming to CallToolResult schema
    return {
        content: [{ type: 'text', text: responseMessage }]
    };
};

// Export the handler as the default export
export default handleExampleTool;
