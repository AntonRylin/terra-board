const fs = require('node:fs');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { tools } = require('./mcp-tools.cjs');
async function run(root) {
  const server = new McpServer({ name: 'terra-board', version: '1.0.0' });
  for (const tool of tools(() => {}))
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      async (args) => {
        const client = new Client({ name: 'terra-board-stdio', version: '1.0.0' });
        try {
          const config = JSON.parse(
            fs.readFileSync(path.join(root, 'settings', 'mcp.json'), 'utf8'),
          );
          if (!config.enabled) throw Error('Enable AI access in Terra Board Settings first.');
          await client.connect(
            new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.port}/mcp`), {
              requestInit: { headers: { Authorization: 'Bearer ' + config.token } },
            }),
          );
          return await client.callTool({ name: tool.name, arguments: args });
        } catch (e) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'Terra Board: ' + e.message + ' Keep the app open with MCP enabled.',
              },
            ],
          };
        } finally {
          await client.close();
        }
      },
    );
  await server.connect(new StdioServerTransport());
  return server;
}
module.exports = { run };
if (require.main === module)
  run(process.env.CANVAS_DATA_DIR).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
