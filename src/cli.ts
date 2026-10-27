#!/usr/bin/env node
import {StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import {createServer} from './server.js';
try {
  const {server,tools}=createServer();
  if (process.argv.includes('--list-tools')) console.log(JSON.stringify(tools.definitions().map(d=>({name:d.name,description:d.description})),null,2));
  else if (process.argv.includes('--version')) console.log('0.1.0-alpha.4');
  else await server.connect(new StdioServerTransport());
} catch { console.error('Unable to start ubc-mcp. Check UBC_PROFILE and personal connection configuration.'); process.exitCode=1; }
