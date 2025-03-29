import { z } from 'zod';

/**
 * Zod schema for a standard MCP ping request.
 */
export const PingRequestSchema = z.object({
    method: z.literal('ping'),
    params: z.object({}).optional(), // Ping has no params
});

// Add other common types here if needed in the future
