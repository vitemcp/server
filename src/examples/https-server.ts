import { z } from "zod";

import { ViteMCP } from "../ViteMCP.js";

/**
 * HTTPS support, using the self-signed certs in src/fixtures/certs/.
 *
 * Run: `npx tsx src/examples/https-server.ts`
 * Test: `curl -k https://localhost:8443/health`
 *
 * For production use a real CA (e.g. `certbot certonly --standalone -d yourdomain.com`).
 */

const server = new ViteMCP({
  name: "HTTPS Example Server",
  version: "1.0.0",
});

server.addTool({
  description: "Greet someone over HTTPS",
  execute: async ({ name }) => {
    return `Hello, ${name}! This response came over HTTPS.`;
  },
  name: "greet",
  parameters: z.object({
    name: z.string(),
  }),
});

server.start({
  httpStream: {
    port: 8443,
    sslCert: "./src/fixtures/certs/server-cert.pem",
    sslKey: "./src/fixtures/certs/server-key.pem",
    // sslCa: "./ca.pem",   // Optional: CA certificate for client cert auth
  },
  transportType: "httpStream",
});
