#!/usr/bin/env node
// PeopleOS as an MCP server: any MCP client (Claude Desktop, Cursor, an ADK/LangGraph agent...)
// gets the same governed HR tools the in-app agents use — same RBAC, same approval rules.
//
// Identity comes from the environment (PEOPLEOS_USER), never from the model:
//   PEOPLEOS_USER=E1003 node src/mcp/server.js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { tools } from '../tools/registry.js';
import { PERSONAS } from '../db/index.js';
import { policyIndex } from '../lib/bm25.js';

const user = PERSONAS[process.env.PEOPLEOS_USER || 'E1001'];
if (!user) { console.error('Unknown PEOPLEOS_USER'); process.exit(1); }
const ctx = { user, access: user.access };

const server = new McpServer({ name: 'peopleos', version: '1.0.0' });
const asText = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });

for (const [name, t] of Object.entries(tools)) {
  const input = t.writes ? { ...t.input, confirm: z.boolean().optional().describe('Set true only after the human has approved the preview') } : t.input;
  server.registerTool(name, {
    title: name.replace(/_/g, ' '),
    description: t.writes ? `${t.description} First call WITHOUT confirm to get a preview; show it to the human; call again with confirm=true only after they approve.` : t.description,
    inputSchema: input,
    annotations: { readOnlyHint: !t.writes, destructiveHint: false },
  }, async (args) => {
    try {
      if (t.writes) {
        const { confirm, ...rest } = args;
        const err = t.validate(rest, ctx);
        if (err) return { ...asText(`VALIDATION_ERROR: ${err}`), isError: true };
        if (!confirm) return asText(`PREVIEW (not submitted): ${t.preview(rest)}\nAsk the user to approve, then call again with confirm=true.`);
        return asText(await t.run(rest, ctx));
      }
      return asText(await t.run(args, ctx));
    } catch (e) {
      return { ...asText(`ERROR: ${e.message}`), isError: true };
    }
  });
}

// Policies are also exposed as MCP resources so clients can browse/attach them.
for (const c of policyIndex.chunks) {
  server.registerResource(c.id, `policy://${c.id}`, { title: `${c.doc} › ${c.heading}`, mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, text: `## ${c.heading}\n${c.text}` }] }));
}

await server.connect(new StdioServerTransport());
console.error(`PeopleOS MCP server ready (acting as ${user.name}, access=${user.access})`);
