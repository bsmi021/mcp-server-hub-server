# MCP Server Hub / Gateway

**Purpose:** This project provides a central gateway to manage multiple MCP (Model Context Protocol) servers, preventing the need to configure and run duplicate server processes for each LLM client (like Cline, Cursor, etc.). Connect your LLM client to the single `gateway-client` endpoint provided by this project to access tools from all your managed MCP servers through one interface.

## Architecture

The system consists of two main components within this repository:

1. **Gateway Server (`src/server.ts`):**
    * The core hub process that runs persistently.
    * Reads a central configuration file (`dist/mcp_hub_config.json`) listing the actual MCP servers to manage.
    * Spawns, monitors, and manages the lifecycle of these underlying MCP server processes.
    * Listens for WebSocket connections from Gateway Clients.
    * Discovers tools from managed servers and exposes them with a namespaced format (`serverId__toolName`) to prevent naming conflicts.
    * Routes tool calls received from Gateway Clients to the appropriate managed server.

2. **Gateway Client (`src/client/client.ts`):**
    * Acts as the proxy server that LLM clients connect to.
    * Connects to the running Gateway Server via WebSocket (with auto-reconnect).
    * Listens on STDIO for connections from LLM Clients.
    * Forwards MCP requests (like `mcp_listTools`, `mcp_callTool`) from the LLM Client to the Gateway Server.
    * Returns responses from the Gateway Server back to the LLM Client.

**Workflow Diagram:**

```mermaid
graph LR
    subgraph LLM Client Application (e.g., Cline)
        LLM_Client -- STDIO --> GatewayClientProxy;
    end

    subgraph Gateway Client Process (Started by LLM Client)
        GatewayClientProxy[Gateway Client (client.ts)] -- WebSocket --> GatewayServerWS;
    end

    subgraph Gateway Server Process (npm start)
        GatewayServerWS[Gateway Server (server.ts)];
        GatewayServerWS -- Manages --> ManagedMCPServer1[Managed Server 1];
        GatewayServerWS -- Manages --> ManagedMCPServerN[Managed Server N];
        GatewayServerWS -- Reads --> ConfigFile[dist/mcp_hub_config.json];
    end

    style GatewayClientProxy fill:#f9f,stroke:#333,stroke-width:2px;
    style GatewayServerWS fill:#ccf,stroke:#333,stroke-width:2px;
```

## Getting Started

### 1. Prerequisites

* Node.js (v20+ recommended)
* npm
* The underlying MCP servers you want to manage must be installed/accessible.

### 2. Installation & Build

```bash
# Clone the repository (if you haven't already)
# git clone ...
# cd mcp-server-hub-server

# Install dependencies
npm install

# Build the Gateway Server and Client code
npm run build
```

This compiles the TypeScript code into the `dist/` directory.

### 3. Configuration (`dist/mcp_hub_config.json`)

The Gateway Server requires a configuration file named `mcp_hub_config.json`.

**IMPORTANT:** You must place this file inside the `dist/` directory *after* running `npm run build`, as the build process might clean the `dist` folder.

This file tells the Gateway Server which underlying MCP servers to start and manage.

**Example `dist/mcp_hub_config.json`:**

```json
{
  "mcpServers": {
    "thought-server": {
      "command": "node",
      "args": [
        "D:\\Projects\\mcp-thought-server\\build\\index.js"
      ],
      "env": {}
    },
    "file-ops": { 
      "command": "node",
      "args": [
        "D:/Projects/mcp-servers/Cline/MCP/file-operations-server/build/index.js"
      ]
    }
    // Add entries for other MCP servers here...
  },
  "settings": {
    "logLevel": "info", // Optional: 'error', 'warn', 'info', 'debug'
    "wsPort": 8081,     // Port for Gateway Clients to connect to
    "ssePort": null     // SSE interface is disabled by default
  }
}
```

**Key Configuration Fields:**

* `mcpServers`: An object where each key is a unique `serverId` you choose (e.g., `thought-server`, `file-ops`). This ID is used for namespacing tools.
  * `command`: The executable command to start the server.
  * `args`: An array of string arguments.
  * `env` (Optional): Environment variables for the server process.
  * `workingDir` (Optional): Working directory for the server process.
  * `autoRestart` (Optional): `true` or `false` (default).
  * `maxRestarts` (Optional): Max restart attempts (default: 3).
* `settings`: Gateway Server specific settings.
  * `wsPort`: TCP port the Gateway Server listens on for WebSocket connections.
  * `logLevel`: Logging verbosity for Gateway Server and Client.

### 4. Running the Gateway Server

Open a terminal in the project root directory (`mcp-server-hub-server`) and run:

```bash
npm start
```

This will read `dist/mcp_hub_config.json`, start the managed servers, start the WebSocket listener, and keep running until manually stopped (Ctrl+C).

### 5. Configuring Your LLM Client (e.g., Cline)

Your LLM client only needs **one** MCP server configured: the `gateway-client`.

Add the following entry to your client's MCP server settings file (e.g., Cline's `cline_mcp_settings.json`), **making sure to use the correct absolute path to this project**:

```json
{
  "mcpServers": {
    // Remove configurations for individual servers like thought-server, file-operations, etc.
    "gateway-client": {
      "command": "node",
      "args": [
        // Use the FULL, absolute path to the compiled client script
        "d:/Projects/mcp-server-hub-server/dist/client/client.js" 
      ],
      "options": {
        // CWD should be the project root
        "cwd": "d:/Projects/mcp-server-hub-server"
      },
      "env": {},
      "disabled": false,
      "autoApprove": [] 
    }
    // Only the gateway-client entry is needed here
  }
}
```

When the LLM client connects to `gateway-client`, it will automatically start the client process (`node dist/client/client.js`), which then connects to the already running Gateway Server via WebSocket.

### 6. Using Tools

Once the Gateway Server is running and your LLM Client is connected to the `gateway-client`:

* List tools in your LLM Client. You should see namespaced tool names like `thought-server__integratedThinking`, `file-ops__list_directory`, etc. The namespacing (`serverId__toolName`) prevents conflicts between tools from different servers that might share the same original name.
* Call tools using these full, namespaced names.

## Troubleshooting

* **ENOENT Error Starting `gateway-client` in LLM Client:** Ensure the `command` (`node`), `args` (absolute path to `dist/client/client.js`), and `options.cwd` (absolute path to project root) in the LLM Client's MCP settings are correct for your system.
* **Tool Name Validation Error (`String should match pattern...`):** This indicates an invalid character or length in a tool name reported to the LLM client. This gateway uses `serverId__toolName` which should be valid. Ensure your `serverId` keys in `mcp_hub_config.json` only contain `a-zA-Z0-9_-`. The gateway attempts to truncate long server IDs to keep the total length <= 60 characters.
* **Gateway Client Cannot Connect to Server:** Verify the Gateway Server (`npm start`) is running. Check the `wsPort` in `dist/mcp_hub_config.json` matches the URL in `src/client/client.ts` (default `ws://localhost:8081`). Check firewalls.
* **Cline Initial `listTools` Fails/Times Out:** This is a known caveat. Cline sometimes sends its first `listTools` request *immediately* upon starting the `gateway-client`, potentially before the client has finished connecting to the Gateway Server's WebSocket. The client queues the request to prevent errors, but Cline might display a timeout initially. Subsequent `listTools` calls or other tool calls should work correctly once the connection is established (usually within milliseconds). Check the Gateway Client logs (`npm run start:client` terminal) for messages about queueing.
* **Managed Server Errors (`[serverId/ERR]`):** Errors logged with a specific server ID prefix indicate problems within that underlying managed server, not the Gateway itself. Troubleshoot that server directly.

## Development

* **Run Dev Server:** `npm run dev` (uses nodemon for auto-restart of the Gateway Server). Does not restart the client or managed servers.
* **Linting/Formatting:** `npm run lint`, `npm run format` (also run via pre-commit hook).
