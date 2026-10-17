import https from "https";
import path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { ViteMCP } from "./ViteMCP.js";

describe("HTTPS support", () => {
  let server: ViteMCP;

  beforeEach(() => {
    server = new ViteMCP({
      name: "HTTPS Test Server",
      version: "1.0.0",
    });

    server.addTool({
      description: "Test tool",
      execute: async ({ message }) => {
        return `Received: ${message}`;
      },
      name: "test",
      parameters: z.object({
        message: z.string(),
      }),
    });
  });

  afterEach(async () => {
    await server.stop();
  });

  test("starts server with HTTPS when SSL options provided", async () => {
    const certPath = path.join(
      process.cwd(),
      "src/fixtures/certs/server-cert.pem",
    );
    const keyPath = path.join(
      process.cwd(),
      "src/fixtures/certs/server-key.pem",
    );

    // Port 0, so the OS assigns one that is free as the server binds it. A
    // number picked in advance could already be taken or, on Windows, reserved.
    await server.start({
      httpStream: {
        port: 0,
        sslCert: certPath,
        sslKey: keyPath,
      },
      transportType: "httpStream",
    });

    const port = server.port!;

    // Test that the server responds to HTTPS requests
    const response = await new Promise<{ statusCode?: number; text: string }>(
      (resolve, reject) => {
        https
          .get(
            {
              hostname: "localhost",
              path: "/health",
              port,
              rejectUnauthorized: false, // Accept self-signed cert
            },
            (res) => {
              let data = "";
              res.on("data", (chunk) => {
                data += chunk;
              });
              res.on("end", () => {
                resolve({ statusCode: res.statusCode, text: data });
              });
              res.on("error", reject);
            },
          )
          .on("error", reject);
      },
    );

    expect(response.statusCode).toBe(200);
    expect(response.text).toBe("ok");
  });

  test("starts server with HTTP when no SSL options provided", async () => {
    await server.start({
      httpStream: {
        port: 0,
      },
      transportType: "httpStream",
    });

    // Test that the server responds to HTTP requests
    const response = await fetch(`http://localhost:${server.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});
