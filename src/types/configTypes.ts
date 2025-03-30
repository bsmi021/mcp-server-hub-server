import { z } from 'zod';

// Keep this interface as it's not derived from Zod
export interface ValidationResult {
    isValid: boolean;
    errors: string[]; // List of validation error messages
}


// --- Zod Schemas for Validation ---

const LogLevelSchema = z.enum(['error', 'warn', 'info', 'debug']);

// Define GatewaySettings schema first as it's used in ConfigSchema
export const GatewaySettingsSchema = z.object({
    ssePort: z.number().int().positive().optional().nullable(), // Allow null/undefined
    sseHost: z.string().min(1).default('localhost'),
    ssePath: z.string().min(1).default('/events'),
    wsPort: z.number().int().positive().optional().nullable(), // Allow null/undefined
    logLevel: LogLevelSchema.default('info'),
}).strict(); // Disallow extra properties in settings

export const ServerConfigSchema = z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    workingDir: z.string().optional(), // Default applied during processing
    autoRestart: z.boolean().default(false),
    maxRestarts: z.number().int().min(0).default(3),
}).strict(); // Disallow extra properties in server config

// Define the main Config schema using the above schemas
export const ConfigSchema = z.object({
    mcpServers: z.record(ServerConfigSchema),
    settings: GatewaySettingsSchema.optional(), // Settings block is optional
}).strict(); // Disallow extra top-level properties

// --- Derive and export types from Zod schemas ---
export type Config = z.infer<typeof ConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type GatewaySettings = z.infer<typeof GatewaySettingsSchema>;
