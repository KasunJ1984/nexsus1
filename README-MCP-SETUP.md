# Nexsus1 MCP Server Setup

This guide explains how to configure Claude Desktop to use the standalone Nexsus1 MCP server.

## Prerequisites

1. Node.js installed (>=18.0.0)
2. Claude Desktop installed
3. Nexsus1 built and ready (`npm run build`)

## Configuration Steps

### 1. Build Nexsus1

```bash
cd C:\Users\KasunJ\MCP\Nexsus1
npm install
npm run build
```

### 2. Configure Claude Desktop

Edit your Claude Desktop MCP configuration file:
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

Add the Nexsus1 server to the `mcpServers` section:

```json
{
  "mcpServers": {
    "nexsus1": {
      "command": "node",
      "args": [
        "C:\\Users\\KasunJ\\MCP\\Nexsus1\\dist\\console\\index.js"
      ],
      "env": {
        "UNIFIED_COLLECTION_NAME": "nexsus1_unified",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
```

**Note:** If you already have other MCP servers configured (like the original Nexsus), add Nexsus1 as another entry in the `mcpServers` object. Each server must have a unique key (e.g., `nexsus`, `nexsus1`, `nexsus2`, etc.).

**Example with multiple servers:**

```json
{
  "mcpServers": {
    "nexsus": {
      "command": "node",
      "args": ["C:\\Users\\KasunJ\\MCP\\Nexsus\\dist\\console\\index.js"]
    },
    "nexsus1": {
      "command": "node",
      "args": ["C:\\Users\\KasunJ\\MCP\\Nexsus1\\dist\\console\\index.js"],
      "env": {
        "UNIFIED_COLLECTION_NAME": "nexsus1_unified",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
```

### 3. Environment Variables

Ensure your `.env` file in the Nexsus1 directory is configured:

```bash
# Qdrant Vector Database
QDRANT_HOST=https://your-qdrant-host:6333
QDRANT_API_KEY=your_api_key

# Collection Name (isolated from main Nexsus)
UNIFIED_COLLECTION_NAME=nexsus1_unified

# Voyage AI Embeddings
VOYAGE_API_KEY=your_api_key
EMBEDDING_MODEL=voyage-3.5-lite
```

### 4. Restart Claude Desktop

After saving the configuration, completely quit and restart Claude Desktop for the changes to take effect.

## Verification

Once Claude Desktop restarts, you can verify Nexsus1 is working by asking Claude:

```
Show me the Nexsus1 system status
```

Claude should be able to call the `system_status` tool from the Nexsus1 MCP server.

## Collection Isolation

Nexsus1 uses its own Qdrant collection (`nexsus1_unified`) completely separate from the main Nexsus collection (`nexsus_unified`). This ensures:

- No data conflicts between Nexsus and Nexsus1
- Independent schema and data management
- Ability to run both servers simultaneously

## Troubleshooting

### Server Not Showing Up

1. Check that the path in `args` is correct
2. Verify the `dist/console/index.js` file exists (run `npm run build` if not)
3. Check Claude Desktop logs:
   - Windows: `%APPDATA%\Claude\logs\`
   - macOS: `~/Library/Logs/Claude/`
   - Linux: `~/.config/Claude/logs/`

### Connection Errors

1. Verify `.env` file has correct Qdrant credentials
2. Check `UNIFIED_COLLECTION_NAME` is set to `nexsus1_unified`
3. Ensure Qdrant server is accessible

### Build Errors

If `npm run build` fails:
1. Delete `node_modules` and `package-lock.json`
2. Run `npm install` again
3. Try `npm run build` again

## Next Steps

After successful setup:

1. Sync schema: `npm run sync -- sync schema`
2. Add Excel data files to `data/excel/`
3. Sync data: `npm run sync -- sync model <model_name>`
4. Query via Claude Desktop using semantic_search, nexsus_search, etc.
