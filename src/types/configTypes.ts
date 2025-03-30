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
    // Add the new section for hub-specific tools
    hubTools: z.record(z.lazy(() => HubToolConfigSchema)).optional(), // Optional section, maps tool name to config. Use z.lazy if HubToolConfigSchema references itself indirectly, otherwise remove. Assuming simple structure for now.
}).strict(); // Disallow extra top-level properties


// --- Schema for individual Hub Tool Configuration ---
export const HubToolConfigSchema = z.object({
    description: z.string().optional(),
    // Path to the module exporting the tool handler function (relative to dist/tools/ ?)
    // Needs careful consideration of how paths resolve after compilation.
    // Example: './myTool.js' might resolve to 'dist/tools/myTool.js'
    modulePath: z.string().describe("Path to the module exporting the tool handler (relative to dist/tools/)"),
    // The name of the exported function within the module to use as the handler
    handlerExport: z.string().default('default').describe("Name of the exported handler function in the module"),
    // Flag to enable/disable the tool
    enabled: z.boolean().default(true),
    // Optional tool-specific configuration passed to the handler? Or maybe inputSchema defined here?
    // For now, keep it simple. Tool-specific config might be better handled internally by the tool module.
    // inputSchema: z.any().optional(), // Placeholder - Defining schema dynamically is complex. Tool modules should ideally export their own Zod input schemas.
}).strict();


// --- Derive and export types from Zod schemas ---
export type Config = z.infer<typeof ConfigSchema>;
// Add HubToolConfig type
export type HubToolConfig = z.infer<typeof HubToolConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type GatewaySettings = z.infer<typeof GatewaySettingsSchema>;
