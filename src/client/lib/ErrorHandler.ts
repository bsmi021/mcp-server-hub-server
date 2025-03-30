import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../../utils/logger.js'; // Assuming shared logger

/**
 * Provides standardized error handling for the MCP Gateway Client.
 * Converts various error types into McpError instances.
 */
export class McpErrorHandler {

    /**
     * Handles an unknown error, attempting to convert it into a standardized McpError.
     * Logs the original error for debugging purposes.
     * @param error The error object caught.
     * @param context Optional context string (e.g., the operation being performed).
     * @returns An McpError instance.
     */
    static handle(error: unknown, context?: string): McpError {
        const prefix = context ? `[${context}] ` : '';

        if (error instanceof McpError) {
            // If it's already an McpError, just return it (maybe log it?)
            logger.warn(`${prefix}Encountered McpError: ${error.code} - ${error.message}`, error.data);
            return error;
        }

        if (error instanceof Error) {
            // For standard JavaScript errors, wrap them in an InternalError McpError
            logger.error(`${prefix}Encountered standard error: ${error.message}`, error.stack);
            return new McpError(
                ErrorCode.InternalError,
                `${prefix}${error.message}`,
                { originalErrorName: error.name, originalErrorStack: error.stack } // Include original details
            );
        }

        // For unknown error types, create a generic InternalError
        logger.error(`${prefix}Encountered unknown error type:`, error);
        return new McpError(
            ErrorCode.InternalError,
            `${prefix}An unknown error occurred`,
            { originalError: String(error) } // Try to stringify the unknown error
        );
    }

    /**
     * Creates and logs an McpError. Useful for generating errors internally.
     * @param code The McpError code.
     * @param message The error message.
     * @param data Optional additional data.
     * @param context Optional context string.
     * @returns The created McpError instance.
     */
    static create(code: ErrorCode, message: string, data?: any, context?: string): McpError {
        const prefix = context ? `[${context}] ` : '';
        const error = new McpError(code, `${prefix}${message}`, data);
        logger.error(`${prefix}Creating McpError: ${code} - ${message}`, data);
        return error;
    }
}
