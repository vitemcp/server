# ViteMCP

A TypeScript framework for building [MCP](https://glama.ai/mcp) servers.

> [!IMPORTANT]
>
> ViteMCP targets MCP revision **2026-07-28**, which made the protocol
> stateless. There is no `initialize` handshake and no `Mcp-Session-Id`: every
> request is self-contained and carries its own protocol version and client
> capabilities.
>
> If you are coming from a session-based version, see
> [Migrating from the session-based API](#migrating-from-the-session-based-api).

## Features

- Simple Tool, Resource, Prompt definition
- [Authentication](#authentication)
- [Per-request auth context](#authentication)
- [Image content](#returning-an-image)
- [Audio content](#returning-an-audio)
- [Embedded](#embedded-resources)
- [Error handling](#errors)
- [HTTP Streaming](#http-streaming)
- [HTTPS Support](#https-support) for secure connections
- [Custom HTTP routes](#custom-http-routes) for REST APIs, webhooks, and admin interfaces
- [Edge Runtime Support](#edge-runtime-support) for Cloudflare Workers, Deno Deploy, and more
- Stateless by construction — every request stands alone, so serverless just works
- CORS (enabled by default)
- [Progress notifications](#progress)
- [Multi round-trip requests](#multi-round-trip-requests) for asking the client for more input
- [Prompt argument auto-completion](#prompt-argument-auto-completion)
- [Cacheable list results](#cacheable-results) (`ttlMs` / `cacheScope`)
- [Health-check endpoint](#health-check-endpoint)
- [In-memory transport](#unit-testing-with-an-in-memory-transport) for unit testing without binding a port
- CLI for [testing](#test-with-mcp-cli) and [debugging](#inspect-with-mcp-inspector)

## When to use ViteMCP over the official SDK?

ViteMCP is built on top of the official SDK.

The official SDK provides foundational blocks for building MCPs, but leaves many implementation details to you:

- [Initiating and configuring](https://github.com/vitemcp/vitemcp/blob/06c2af7a3d7e3d8c638deac1964ce269ce8e518b/src/FastMCP.ts#L664-L744) all the server components
- [Handling of connections](https://github.com/vitemcp/vitemcp/blob/06c2af7a3d7e3d8c638deac1964ce269ce8e518b/src/FastMCP.ts#L760-L850)
- [Handling of tools](https://github.com/vitemcp/vitemcp/blob/06c2af7a3d7e3d8c638deac1964ce269ce8e518b/src/FastMCP.ts#L1303-L1498)
- [Handling of responses](https://github.com/vitemcp/vitemcp/blob/06c2af7a3d7e3d8c638deac1964ce269ce8e518b/src/FastMCP.ts#L989-L1060)
- [Handling of resources](https://github.com/vitemcp/vitemcp/blob/06c2af7a3d7e3d8c638deac1964ce269ce8e518b/src/FastMCP.ts#L1151-L1242)
- Adding [prompts](https://github.com/vitemcp/vitemcp/blob/06c2af7a3d7e3d8c638deac1964ce269ce8e518b/src/FastMCP.ts#L760-L850), [resources](https://github.com/vitemcp/vitemcp/blob/06c2af7a3d7e3d8c638deac1964ce269ce8e518b/src/FastMCP.ts#L960-L962), [resource templates](https://github.com/vitemcp/vitemcp/blob/06c2af7a3d7e3d8c638deac1964ce269ce8e518b/src/FastMCP.ts#L964-L987)
- Embedding [resources](https://github.com/vitemcp/vitemcp/blob/06c2af7a3d7e3d8c638deac1964ce269ce8e518b/src/FastMCP.ts#L1569-L1643), [image](https://github.com/vitemcp/vitemcp/blob/06c2af7a3d7e3d8c638deac1964ce269ce8e518b/src/FastMCP.ts#L51-L111) and [audio](https://github.com/vitemcp/vitemcp/blob/06c2af7a3d7e3d8c638deac1964ce269ce8e518b/src/FastMCP.ts#L113-L173) content blocks

ViteMCP eliminates this complexity by providing an opinionated framework that:

- Handles all the boilerplate automatically
- Provides simple, intuitive APIs for common tasks
- Includes built-in best practices and error handling
- Lets you focus on your MCP's core functionality

**When to choose ViteMCP:** You want to build MCP servers quickly without dealing with low-level implementation details.

**When to use the official SDK:** You need maximum control or have specific architectural requirements. In this case, we encourage referencing ViteMCP's implementation to avoid common pitfalls.

## Installation

```bash
npm install @vitemcp/server
```

## Quickstart

> [!NOTE]
>
> There are many real-world examples of using ViteMCP in the wild. See the [Showcase](#showcase) for examples.

```ts
import { ViteMCP } from "@vitemcp/server";
import { z } from "zod"; // Or any validation library that supports Standard Schema

const server = new ViteMCP({
  name: "My Server",
  version: "1.0.0",
});

server.addTool({
  name: "add",
  description: "Add two numbers",
  parameters: z.object({
    a: z.number(),
    b: z.number(),
  }),
  execute: async (args) => {
    return String(args.a + args.b);
  },
});

server.start({
  transportType: "stdio",
});
```

_That's it!_ You have a working MCP server.

You can test the server in terminal with:

```bash
git clone https://github.com/vitemcp/vitemcp.git
cd vitemcp

pnpm install
pnpm build

# Test the addition server example using CLI:
npx @vitemcp/server dev src/examples/addition.ts
# Test the addition server example using MCP Inspector:
npx @vitemcp/server inspect src/examples/addition.ts
```

If you are looking for a boilerplate repository to build your own MCP server, check out [fastmcp-boilerplate](https://github.com/punkpeye/fastmcp-boilerplate).

### Remote Server Options

ViteMCP supports multiple transport options for remote communication, allowing an MCP hosted on a remote machine to be accessed over the network.

#### HTTP Streaming

[HTTP streaming](https://www.cloudflare.com/learning/video/what-is-http-live-streaming/) provides a more efficient alternative to SSE in environments that support it, with potentially better performance for larger payloads.

You can run the server with HTTP streaming support:

```ts
server.start({
  transportType: "httpStream",
  httpStream: {
    port: 8080,
  },
});
```

This will start the server and listen for HTTP streaming connections on `http://localhost:8080/mcp`.

> **Note:** You can also customize the endpoint path using the `httpStream.endpoint` option (default is `/mcp`).

> **Note:** To serve HTTP streaming and built-in OAuth routes under an issuer path, set `httpStream.basePath` (for example, `/issuer1`). This exposes authorization server metadata at `/.well-known/oauth-authorization-server/issuer1` per RFC 8414.

> **Note:** This also starts an SSE server on `http://localhost:8080/sse`.

You can connect to these servers using the appropriate client transport.

For HTTP streaming connections:

```ts
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client(
  {
    name: "example-client",
    version: "1.0.0",
  },
  {
    capabilities: {},
  },
);

const transport = new StreamableHTTPClientTransport(
  new URL(`http://localhost:8080/mcp`),
);

await client.connect(transport);
```

For SSE connections:

```ts
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const client = new Client(
  {
    name: "example-client",
    version: "1.0.0",
  },
  {
    capabilities: {},
  },
);

const transport = new SSEClientTransport(new URL(`http://localhost:8080/sse`));

await client.connect(transport);
```

##### HTTPS Support

ViteMCP supports HTTPS for secure connections by providing SSL certificate options:

```ts
server.start({
  transportType: "httpStream",
  httpStream: {
    port: 8443,
    sslCert: "./path/to/cert.pem",
    sslKey: "./path/to/key.pem",
    sslCa: "./path/to/ca.pem", // Optional: for client certificate authentication
  },
});
```

This will start the server with HTTPS on `https://localhost:8443/mcp`.

**SSL Options:**

- `sslCert` - Path to SSL certificate file
- `sslKey` - Path to SSL private key file
- `sslCa` - (Optional) Path to CA certificate for mutual TLS authentication

**For testing**, you can generate self-signed certificates:

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"
```

**For production**, obtain certificates from a trusted CA like Let's Encrypt.

See the [https-server example](src/examples/https-server.ts) for a complete demonstration.

##### CORS Configuration

By default, ViteMCP enables CORS with a standard set of allowed headers. You can customize the CORS behavior by passing a `cors` option:

```ts
server.start({
  transportType: "httpStream",
  httpStream: {
    port: 8080,
    cors: {
      origin: "http://localhost:3000",
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "Accept",
        "Mcp-Session-Id",
        "Mcp-Protocol-Version",
        "Last-Event-Id",
        "X-Custom-Header",
      ],
      credentials: true,
    },
  },
});
```

The `cors` option accepts:

- `true` (default) - enable CORS with default settings
- `false` - disable CORS entirely
- An object with these fields:
  - `origin` - a string, array of strings, or a function `(origin: string) => boolean`
  - `allowedHeaders` - a string or array of strings
  - `methods` - array of allowed HTTP methods
  - `exposedHeaders` - array of headers to expose
  - `credentials` - boolean to allow credentials
  - `maxAge` - preflight cache duration in seconds

The `CorsOptions` type is exported from `vitemcp` for convenience.

#### Custom HTTP Routes

ViteMCP allows you to add custom HTTP routes alongside MCP endpoints, enabling you to build comprehensive HTTP services that include REST APIs, webhooks, admin interfaces, and more - all within the same server process.

```ts
const app = server.getApp();

// Add REST API endpoints with Hono's native API
app.get("/api/users", async (c) => {
  return c.json({ users: [] });
});

// Handle path parameters
app.get("/api/users/:id", async (c) => {
  return c.json({
    userId: c.req.param("id"),
    query: c.req.query(), // Access query parameters
  });
});

// Handle POST requests with body parsing
app.post("/api/users", async (c) => {
  const body = await c.req.json();
  return c.json({ created: body }, 201);
});

// Serve HTML content
app.get("/admin", async (c) => {
  return c.html("<html><body><h1>Admin Panel</h1></body></html>");
});

// Handle webhooks
app.post("/webhook/github", async (c) => {
  const payload = await c.req.json();
  const event = c.req.header("x-github-event");

  // Process webhook...
  return c.json({ received: true });
});
```

Custom routes use the underlying [Hono](https://hono.dev/) app returned by `server.getApp()` and support:

- Hono's HTTP methods: `get`, `post`, `put`, `delete`, `patch`, `options`, and more
- Path parameters (`:param`) and wildcards (`*`)
- Query string parsing
- JSON, text, form, and other body helpers from `c.req`
- Custom status codes and headers
- Middleware and route groups through Hono

Routes are matched in the order they are registered, allowing you to define specific routes before catch-all patterns.

##### Public and Protected Routes

Custom Hono routes are public unless you add your own route middleware or authentication checks. For protected custom routes, put your auth logic in a reusable helper and call it from both ViteMCP's `authenticate` option and your Hono route handlers:

```ts
import type { IncomingMessage } from "node:http";
import type { Context } from "hono";
import { ViteMCP } from "@vitemcp/server";

async function authenticateRequest(request: IncomingMessage) {
  const apiKey = request.headers["x-api-key"];
  return apiKey === "123" ? { userId: "123" } : undefined;
}

const server = new ViteMCP({
  name: "My Server",
  version: "1.0.0",
  authenticate: authenticateRequest,
});

const app = server.getApp();

async function requireAuth(c: Context) {
  const auth = await authenticateRequest(c.env.incoming);

  if (!auth) {
    return c.json({ error: "Authentication required" }, 401);
  }

  return auth;
}

// Public route - no authentication required
app.get("/.well-known/openid-configuration", async (c) => {
  return c.json({
    issuer: "https://example.com",
    authorization_endpoint: "https://example.com/auth",
    token_endpoint: "https://example.com/token",
  });
});

// Private route - requires authentication
app.get("/api/users", async (c) => {
  const auth = await requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }

  return c.json({ users: [] });
});

// Public static files
app.get("/public/*", async (c) => {
  return c.text(`File: ${c.req.path}`);
});
```

Public routes are perfect for:

- OAuth discovery endpoints (`.well-known/*`)
- Health checks and status pages
- Static assets and documentation
- Webhook endpoints from external services
- Public APIs that don't require user authentication

See the [custom-routes example](src/examples/custom-routes.ts) for a complete demonstration.

#### Edge Runtime Support

ViteMCP supports edge runtimes like Cloudflare Workers, enabling deployment of MCP servers to the edge with minimal latency worldwide.

##### Choosing Between ViteMCP and EdgeViteMCP

| Use Case                        | Class         | Import                                               |
| ------------------------------- | ------------- | ---------------------------------------------------- |
| Node.js, Express, Bun           | `ViteMCP`     | `import { ViteMCP } from "@vitemcp/server"`          |
| Cloudflare Workers, Deno Deploy | `EdgeViteMCP` | `import { EdgeViteMCP } from "@vitemcp/server/edge"` |

| Feature              | ViteMCP                        | EdgeViteMCP                            |
| -------------------- | ------------------------------ | -------------------------------------- |
| Runtime              | Node.js                        | Edge (V8 isolates)                     |
| Start method         | `server.start({ port })`       | `export default server`                |
| Transport            | stdio, httpStream              | HTTP Streamable only                   |
| File system          | Yes                            | No                                     |
| OAuth/Authentication | Built-in `authenticate` option | Use Hono middleware (built-in planned) |
| Custom routes        | `server.getApp()`              | `server.getApp()`                      |

> **Note:** Built-in authentication for EdgeViteMCP is planned for a future release. Both ViteMCP and EdgeViteMCP use Hono internally, so there's no technical barrier. `ViteMCP`'s `authenticate` already takes a web-standard `Request`, so the same hook shape works on both.
>
> In the meantime, use Hono middleware:
>
> ```ts
> const app = server.getApp();
> app.use("/api/*", async (c, next) => {
>   if (c.req.header("authorization") !== "Bearer secret") {
>     return c.json({ error: "Unauthorized" }, 401);
>   }
>   await next();
> });
> ```

##### Cloudflare Workers

To deploy ViteMCP to Cloudflare Workers, use the `EdgeViteMCP` class from the `/edge` subpath:

```ts
import { EdgeViteMCP } from "@vitemcp/server/edge";
import { z } from "zod";

const server = new EdgeViteMCP({
  name: "My Edge Server",
  version: "1.0.0",
  description: "MCP server running on Cloudflare Workers",
});

// Add tools, resources, prompts as usual
server.addTool({
  name: "greet",
  description: "Greet someone",
  parameters: z.object({
    name: z.string(),
  }),
  execute: async ({ name }) => {
    return `Hello, ${name}! Served from the edge.`;
  },
});

// Export the server as the default (required for Cloudflare Workers)
export default server;
```

##### Edge Runtime Differences

When running on edge runtimes:

- **No shared state**: Each request is handled independently — which is simply how the protocol works now
- **No filesystem access**: Use fetch APIs for external data
- **V8 Isolates**: Fast cold starts and efficient resource usage
- **Global deployment**: Automatic distribution to edge locations

##### Custom Routes on Edge

You can access the underlying Hono app to add custom HTTP routes:

```ts
const app = server.getApp();

// Add a landing page
app.get("/", (c) => c.html("<h1>Welcome to my MCP server</h1>"));

// Add REST API endpoints
app.get("/api/status", (c) => c.json({ status: "ok" }));
```

##### Deployment

Configure your `wrangler.toml`:

```toml
name = "my-mcp-server"
main = "src/index.ts"
compatibility_date = "2024-01-01"
```

Deploy with:

```bash
wrangler deploy
```

See the [edge-cloudflare-worker example](src/examples/edge-cloudflare-worker.ts) for a complete demonstration.

## Core Concepts

### Tools

[Tools](https://modelcontextprotocol.io/docs/concepts/tools) in MCP allow servers to expose executable functions that can be invoked by clients and used by LLMs to perform actions.

ViteMCP uses the [Standard Schema](https://standardschema.dev) specification for defining tool parameters. This allows you to use your preferred schema validation library (like Zod, ArkType, or Valibot) as long as it implements the spec.

**Zod Example:**

```typescript
import { z } from "zod";

server.addTool({
  name: "fetch-zod",
  description: "Fetch the content of a url (using Zod)",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args) => {
    return await fetchWebpageContent(args.url);
  },
});
```

**ArkType Example:**

```typescript
import { type } from "arktype";

server.addTool({
  name: "fetch-arktype",
  description: "Fetch the content of a url (using ArkType)",
  parameters: type({
    url: "string",
  }),
  execute: async (args) => {
    return await fetchWebpageContent(args.url);
  },
});
```

**Valibot Example:**

Valibot requires the peer dependency @valibot/to-json-schema.

```typescript
import * as v from "valibot";

server.addTool({
  name: "fetch-valibot",
  description: "Fetch the content of a url (using Valibot)",
  parameters: v.object({
    url: v.string(),
  }),
  execute: async (args) => {
    return await fetchWebpageContent(args.url);
  },
});
```

**Plain JSON Schema Example:**

If you already have a JSON Schema — from an OpenAPI document, a config file, or
another server — `jsonSchemaAdapter` wraps it so it can be used directly, with
no schema library in between.

It requires the peer dependency `ajv`, which does the validation, plus
`ajv-formats` if your schema uses `format` keywords such as `email` or `uri`.
Both are imported the first time a tool is called, so servers that don't use
this pay nothing for it.

```bash
npm install ajv ajv-formats
```

```typescript
import { jsonSchemaAdapter } from "@vitemcp/server";

server.addTool({
  name: "fetch-json-schema",
  description: "Fetch the content of a url (using plain JSON Schema)",
  parameters: jsonSchemaAdapter({
    type: "object",
    properties: {
      url: { type: "string", format: "uri" },
    },
    required: ["url"],
  }),
  execute: async (args) => {
    const { url } = args as { url: string };
    return await fetchWebpageContent(url);
  },
});
```

Works for `outputSchema` too. Note that ViteMCP advertises every tool schema
with `additionalProperties: false`, whatever your schema said — the same
treatment Zod and Valibot schemas get.

Unlike the schema libraries above, a plain JSON Schema carries no TypeScript
types, so `execute` receives `unknown` arguments. Cast or narrow them yourself.

#### Tools Without Parameters

When creating tools that don't require parameters, you have two options:

1. Omit the parameters property entirely:

   ```typescript
   server.addTool({
     name: "sayHello",
     description: "Say hello",
     // No parameters property
     execute: async () => {
       return "Hello, world!";
     },
   });
   ```

2. Explicitly define empty parameters:

   ```typescript
   import { z } from "zod";

   server.addTool({
     name: "sayHello",
     description: "Say hello",
     parameters: z.object({}), // Empty object
     execute: async () => {
       return "Hello, world!";
     },
   });
   ```

> [!NOTE]
>
> Both approaches are fully compatible with all MCP clients, including Cursor. ViteMCP automatically generates the proper schema in both cases.

#### Structured Tool Output

Tools can declare an `outputSchema` and return structured data. ViteMCP exposes that value as MCP `structuredContent`, while also returning a JSON text fallback for clients that only render text content.

```typescript
server.addTool({
  name: "get-weather",
  description: "Get weather for a city",
  parameters: z.object({
    city: z.string(),
  }),
  outputSchema: z.object({
    temperature: z.number(),
    humidity: z.number(),
  }),
  execute: async ({ city }) => {
    const weather = await getWeather(city);

    return {
      temperature: weather.temperature,
      humidity: weather.humidity,
    };
  },
});
```

You can also return explicit text content and structured content together:

```typescript
server.addTool({
  name: "get-weather",
  description: "Get weather for a city",
  parameters: z.object({
    city: z.string(),
  }),
  outputSchema: z.object({
    temperature: z.number(),
    humidity: z.number(),
  }),
  execute: async ({ city }) => {
    const weather = await getWeather(city);

    return {
      content: [
        {
          type: "text",
          text: `${city}: ${weather.temperature}F`,
        },
      ],
      structuredContent: {
        temperature: weather.temperature,
        humidity: weather.humidity,
      },
    };
  },
});
```

When `outputSchema` is provided, ViteMCP validates `structuredContent` before sending the tool result. Invalid structured output is returned to the client as a tool error instead of silently violating the advertised schema.

#### Tool Authorization

You can control which tools are available to authenticated users by adding an optional `canAccess` function to a tool's definition. This function receives the authentication context and should return `true` if the user is allowed to access the tool.

```typescript
server.addTool({
  name: "admin-tool",
  description: "An admin-only tool",
  canAccess: (auth) => auth?.role === "admin",
  execute: async () => "Welcome, admin!",
});
```

#### Returning a string

`execute` can return a string:

```js
server.addTool({
  name: "download",
  description: "Download a file",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args) => {
    return "Hello, world!";
  },
});
```

The latter is equivalent to:

```js
server.addTool({
  name: "download",
  description: "Download a file",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args) => {
    return {
      content: [
        {
          type: "text",
          text: "Hello, world!",
        },
      ],
    };
  },
});
```

#### Returning a list

If you want to return a list of messages, you can return an object with a `content` property:

```js
server.addTool({
  name: "download",
  description: "Download a file",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args) => {
    return {
      content: [
        { type: "text", text: "First message" },
        { type: "text", text: "Second message" },
      ],
    };
  },
});
```

#### Returning an image

Use the `imageContent` to create a content object for an image:

```js
import { imageContent } from "@vitemcp/server";

server.addTool({
  name: "download",
  description: "Download a file",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args) => {
    return imageContent({
      url: "https://example.com/image.png",
    });

    // or...
    // return imageContent({
    //   path: "/path/to/image.png",
    // });

    // or...
    // return imageContent({
    //   buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"),
    // });

    // or...
    // return {
    //   content: [
    //     await imageContent(...)
    //   ],
    // };
  },
});
```

The `imageContent` function takes the following options:

- `url`: The URL of the image.
- `timeoutMs`: Optional timeout for a URL download in milliseconds (defaults to 30 seconds).
- `path`: The path to the image file.
- `buffer`: The image data as a buffer.

Only one of `url`, `path`, or `buffer` must be specified.

The above example is equivalent to:

```js
server.addTool({
  name: "download",
  description: "Download a file",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args) => {
    return {
      content: [
        {
          type: "image",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          mimeType: "image/png",
        },
      ],
    };
  },
});
```

### Health-check Endpoint

When you run ViteMCP with the `httpStream` transport you can optionally expose a
simple HTTP endpoint that returns a plain-text response useful for load-balancer
or container orchestration liveness checks.

Enable (or customise) the endpoint via the `health` key in the server options:

```ts
const server = new ViteMCP({
  name: "My Server",
  version: "1.0.0",
  health: {
    // Enable / disable (default: true)
    enabled: true,
    // Body returned by the endpoint (default: 'ok')
    message: "healthy",
    // Path that should respond (default: '/health')
    path: "/healthz",
    // HTTP status code to return (default: 200)
    status: 200,
  },
});

await server.start({
  transportType: "httpStream",
  httpStream: { port: 8080 },
});
```

Now a request to `http://localhost:8080/healthz` will return:

```
HTTP/1.1 200 OK
content-type: text/plain

healthy
```

The endpoint is ignored when the server is started with the `stdio` transport.

### Returning an audio

Use the `audioContent` to create a content object for an audio:

```js
import { audioContent } from "@vitemcp/server";

server.addTool({
  name: "download",
  description: "Download a file",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args) => {
    return audioContent({
      url: "https://example.com/audio.mp3",
    });

    // or...
    // return audioContent({
    //   path: "/path/to/audio.mp3",
    // });

    // or...
    // return audioContent({
    //   buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"),
    // });

    // or...
    // return {
    //   content: [
    //     await audioContent(...)
    //   ],
    // };
  },
});
```

The `audioContent` function takes the following options:

- `url`: The URL of the audio.
- `timeoutMs`: Optional timeout for a URL download in milliseconds (defaults to 30 seconds).
- `path`: The path to the audio file.
- `buffer`: The audio data as a buffer.

Only one of `url`, `path`, or `buffer` must be specified.

The above example is equivalent to:

```js
server.addTool({
  name: "download",
  description: "Download a file",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args) => {
    return {
      content: [
        {
          type: "audio",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          mimeType: "audio/mpeg",
        },
      ],
    };
  },
});
```

#### Return combination type

You can combine various types in this way and send them back to AI

```js
server.addTool({
  name: "download",
  description: "Download a file",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args) => {
    return {
      content: [
        {
          type: "text",
          text: "Hello, world!",
        },
        {
          type: "image",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          mimeType: "image/png",
        },
        {
          type: "audio",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          mimeType: "audio/mpeg",
        },
      ],
    };
  },

  // or...
  // execute: async (args) => {
  //   const imgContent = await imageContent({
  //     url: "https://example.com/image.png",
  //   });
  //   const audContent = await audioContent({
  //     url: "https://example.com/audio.mp3",
  //   });
  //   return {
  //     content: [
  //       {
  //         type: "text",
  //         text: "Hello, world!",
  //       },
  //       imgContent,
  //       audContent,
  //     ],
  //   };
  // },
});
```

#### Custom Logger

ViteMCP allows you to provide a custom logger implementation to control how the server logs messages. This is useful for integrating with existing logging infrastructure or customizing log formatting.

```ts
import { ViteMCP, Logger } from "@vitemcp/server";

class CustomLogger implements Logger {
  debug(...args: unknown[]): void {
    console.log("[DEBUG]", new Date().toISOString(), ...args);
  }

  error(...args: unknown[]): void {
    console.error("[ERROR]", new Date().toISOString(), ...args);
  }

  info(...args: unknown[]): void {
    console.info("[INFO]", new Date().toISOString(), ...args);
  }

  log(...args: unknown[]): void {
    console.log("[LOG]", new Date().toISOString(), ...args);
  }

  warn(...args: unknown[]): void {
    console.warn("[WARN]", new Date().toISOString(), ...args);
  }
}

const server = new ViteMCP({
  name: "My Server",
  version: "1.0.0",
  logger: new CustomLogger(),
});
```

See `src/examples/custom-logger.ts` for examples with Winston, Pino, and file-based logging.

#### Logging

Tools can log messages to the client using the `log` object in the context object:

```js
server.addTool({
  name: "download",
  description: "Download a file",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args, { log }) => {
    log.info("Downloading file...", {
      url,
    });

    // ...

    log.info("Downloaded file");

    return "done";
  },
});
```

The `log` object has the following methods:

- `debug(message: string, data?: SerializableValue)`
- `error(message: string, data?: SerializableValue)`
- `info(message: string, data?: SerializableValue)`
- `warn(message: string, data?: SerializableValue)`

#### Errors

The errors that are meant to be shown to the user should be thrown as `UserError` instances:

```js
import { UserError } from "@vitemcp/server";

server.addTool({
  name: "download",
  description: "Download a file",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args) => {
    if (args.url.startsWith("https://example.com")) {
      throw new UserError("This URL is not allowed");
    }

    return "done";
  },
});
```

#### Progress

Tools can report progress by calling `reportProgress` in the context object:

```js
server.addTool({
  name: "download",
  description: "Download a file",
  parameters: z.object({
    url: z.string(),
  }),
  execute: async (args, { reportProgress }) => {
    await reportProgress({
      progress: 0,
      total: 100,
    });

    // ...

    await reportProgress({
      progress: 100,
      total: 100,
    });

    return "done";
  },
});
```

`reportProgress` accepts an optional human-readable `message` alongside the numeric fields, which clients can display next to the progress indicator:

```js
await reportProgress({
  progress: 40,
  total: 100,
  message: "Downloading chunk 4 of 10…",
});
```

Progress notifications are only emitted when the client opts in by supplying a `progressToken` on the tool call; otherwise `reportProgress` is a no-op. `notifications/progress` is part of the specification, so this is the portable way to send incremental updates during a long-running tool call.

#### Tool Annotations

As of the MCP Specification (2025-03-26), tools can include annotations that provide richer context and control by adding metadata about a tool's behavior:

```typescript
server.addTool({
  name: "fetch-content",
  description: "Fetch content from a URL",
  parameters: z.object({
    url: z.string(),
  }),
  annotations: {
    title: "Web Content Fetcher", // Human-readable title for UI display
    readOnlyHint: true, // Tool doesn't modify its environment
    openWorldHint: true, // Tool interacts with external entities
  },
  execute: async (args) => {
    return await fetchWebpageContent(args.url);
  },
});
```

The available annotations are:

| Annotation        | Type    | Default | Description                                                                                                                          |
| :---------------- | :------ | :------ | :----------------------------------------------------------------------------------------------------------------------------------- |
| `title`           | string  | -       | A human-readable title for the tool, useful for UI display                                                                           |
| `readOnlyHint`    | boolean | `false` | If true, indicates the tool does not modify its environment                                                                          |
| `destructiveHint` | boolean | `true`  | If true, the tool may perform destructive updates (only meaningful when `readOnlyHint` is false)                                     |
| `idempotentHint`  | boolean | `false` | If true, calling the tool repeatedly with the same arguments has no additional effect (only meaningful when `readOnlyHint` is false) |
| `openWorldHint`   | boolean | `true`  | If true, the tool may interact with an "open world" of external entities                                                             |

These annotations help clients and LLMs better understand how to use the tools and what to expect when calling them.

### Resources

[Resources](https://modelcontextprotocol.io/docs/concepts/resources) represent any kind of data that an MCP server wants to make available to clients. This can include:

- File contents
- Screenshots and images
- Log files
- And more

Each resource is identified by a unique URI and can contain either text or binary data.

```ts
server.addResource({
  uri: "file:///logs/app.log",
  name: "Application Logs",
  mimeType: "text/plain",
  async load() {
    return {
      text: await readLogFile(),
    };
  },
});
```

> [!NOTE]
>
> `load` can return multiple resources. This could be used, for example, to return a list of files inside a directory when the directory is read.
>
> ```ts
> async load() {
>   return [
>     {
>       text: "First file content",
>     },
>     {
>       text: "Second file content",
>     },
>   ];
> }
> ```

You can also return binary contents in `load`:

```ts
async load() {
  return {
    blob: 'base64-encoded-data'
  };
}
```

`load` receives a `context` object mirroring what `tool.execute` gets — `auth`, `log`, `requestId` and the multi-round-trip helpers. `reportProgress` is not included, since it is tied to a tool call's progress token:

```ts
server.addResource({
  uri: "file:///logs/app.log",
  name: "Application Logs",
  mimeType: "text/plain",
  async load(auth, context) {
    context.log.info("loading application logs", { requestedBy: auth?.userId });

    return {
      text: await readLogFile(),
    };
  },
});
```

#### Subscribing to resource updates

Clients can subscribe to a resource with the MCP [`resources/subscribe`](https://modelcontextprotocol.io/specification/2025-06-18/server/resources#subscriptions) method to be notified whenever its contents change. ViteMCP advertises the `subscribe` capability automatically for any server that exposes resources, tracks each client's subscriptions, and lets you emit an update with `sendResourceUpdated`:

```ts
server.addResource({
  uri: "file:///logs/app.log",
  name: "Application Logs",
  mimeType: "text/plain",
  async load() {
    return { text: await readLogFile() };
  },
});

// Whenever the underlying data changes, notify subscribed clients:
await server.sendResourceUpdated("file:///logs/app.log");
```

`sendResourceUpdated` only notifies clients that have subscribed to the given URI, so it is safe to call whenever your data changes. ViteMCP also advertises the `listChanged` capability for resources and prompts and emits `notifications/resources/list_changed` / `notifications/prompts/list_changed` automatically when you add or remove resources, resource templates, or prompts at runtime.

### Resource templates

You can also define resource templates:

```ts
server.addResourceTemplate({
  uriTemplate: "file:///logs/{name}.log",
  name: "Application Logs",
  mimeType: "text/plain",
  arguments: [
    {
      name: "name",
      description: "Name of the log",
      required: true,
    },
  ],
  async load({ name }) {
    return {
      text: `Example log content for ${name}`,
    };
  },
});
```

Like plain resources, `load` also receives `auth` and `context` as its second and third arguments (see [Resources](#resources)).

#### Resource template argument auto-completion

Provide `complete` functions for resource template arguments to enable automatic completion:

```ts
server.addResourceTemplate({
  uriTemplate: "file:///logs/{name}.log",
  name: "Application Logs",
  mimeType: "text/plain",
  arguments: [
    {
      name: "name",
      description: "Name of the log",
      required: true,
      complete: async (value) => {
        if (value === "Example") {
          return {
            values: ["Example Log"],
          };
        }

        return {
          values: [],
        };
      },
    },
  ],
  async load({ name }) {
    return {
      text: `Example log content for ${name}`,
    };
  },
});
```

### Embedded Resources

ViteMCP provides a convenient `embedded()` method that simplifies including resources in tool responses. This feature reduces code duplication and makes it easier to reference resources from within tools.

#### Basic Usage

```js
server.addTool({
  name: "get_user_data",
  description: "Retrieve user information",
  parameters: z.object({
    userId: z.string(),
  }),
  execute: async (args) => {
    return {
      content: [
        {
          type: "resource",
          resource: await server.embedded(`user://profile/${args.userId}`),
        },
      ],
    };
  },
});
```

#### Working with Resource Templates

The `embedded()` method works seamlessly with resource templates:

```js
// Define a resource template
server.addResourceTemplate({
  uriTemplate: "docs://project/{section}",
  name: "Project Documentation",
  mimeType: "text/markdown",
  arguments: [
    {
      name: "section",
      required: true,
    },
  ],
  async load(args) {
    const docs = {
      "getting-started": "# Getting Started\n\nWelcome to our project!",
      "api-reference": "# API Reference\n\nAuthentication is required.",
    };
    return {
      text: docs[args.section] || "Documentation not found",
    };
  },
});

// Use embedded resources in a tool
server.addTool({
  name: "get_documentation",
  description: "Retrieve project documentation",
  parameters: z.object({
    section: z.enum(["getting-started", "api-reference"]),
  }),
  execute: async (args) => {
    return {
      content: [
        {
          type: "resource",
          resource: await server.embedded(`docs://project/${args.section}`),
        },
      ],
    };
  },
});
```

#### Working with Direct Resources

It also works with directly defined resources:

```js
// Define a direct resource
server.addResource({
  uri: "system://status",
  name: "System Status",
  mimeType: "text/plain",
  async load() {
    return {
      text: "System operational",
    };
  },
});

// Use in a tool
server.addTool({
  name: "get_system_status",
  description: "Get current system status",
  parameters: z.object({}),
  execute: async () => {
    return {
      content: [
        {
          type: "resource",
          resource: await server.embedded("system://status"),
        },
      ],
    };
  },
});
```

### Prompts

[Prompts](https://modelcontextprotocol.io/docs/concepts/prompts) enable servers to define reusable prompt templates and workflows that clients can easily surface to users and LLMs. They provide a powerful way to standardize and share common LLM interactions.

```ts
server.addPrompt({
  name: "git-commit",
  description: "Generate a Git commit message",
  arguments: [
    {
      name: "changes",
      description: "Git diff or description of changes",
      required: true,
    },
  ],
  load: async (args) => {
    return `Generate a concise but descriptive commit message for these changes:\n\n${args.changes}`;
  },
});
```

Like resources, `load` also receives `auth` and `context` as its second and third arguments (see [Resources](#resources)):

```ts
server.addPrompt({
  name: "git-commit",
  description: "Generate a Git commit message",
  arguments: [
    {
      name: "changes",
      description: "Git diff or description of changes",
      required: true,
    },
  ],
  load: async (args, auth, context) => {
    context.log.debug("generating git commit prompt", { user: auth?.userId });

    return `Generate a concise but descriptive commit message for these changes:\n\n${args.changes}`;
  },
});
```

#### Prompt argument auto-completion

Prompts can provide auto-completion for their arguments:

```js
server.addPrompt({
  name: "countryPoem",
  description: "Writes a poem about a country",
  load: async ({ name }) => {
    return `Hello, ${name}!`;
  },
  arguments: [
    {
      name: "name",
      description: "Name of the country",
      required: true,
      complete: async (value) => {
        if (value === "Germ") {
          return {
            values: ["Germany"],
          };
        }

        return {
          values: [],
        };
      },
    },
  ],
});
```

#### Prompt argument auto-completion using `enum`

If you provide an `enum` array for an argument, the server will automatically provide completions for the argument.

```js
server.addPrompt({
  name: "countryPoem",
  description: "Writes a poem about a country",
  load: async ({ name }) => {
    return `Hello, ${name}!`;
  },
  arguments: [
    {
      name: "name",
      description: "Name of the country",
      required: true,
      enum: ["Germany", "France", "Italy"],
    },
  ],
});
```

### Authentication

ViteMCP supports OAuth 2.1 authentication with pre-configured providers, allowing you to secure your server with minimal setup.

#### OAuth with Pre-configured Providers

Use the `auth` option with a provider to enable OAuth authentication:

```ts
import {
  ViteMCP,
  getAuthSession,
  GoogleProvider,
  requireAuth,
} from "@vitemcp/server";

const server = new ViteMCP({
  auth: new GoogleProvider({
    baseUrl: "https://your-server.com",
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  }),
  name: "My Server",
  version: "1.0.0",
});

server.addTool({
  canAccess: requireAuth,
  description: "Get user profile",
  execute: async (_args, { session }) => {
    const { accessToken } = getAuthSession(session);
    const response = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    return JSON.stringify(await response.json());
  },
  name: "get-profile",
});
```

**Available Providers:**

| Provider         | Import    | Use Case               |
| :--------------- | :-------- | :--------------------- |
| `GoogleProvider` | `vitemcp` | Google OAuth           |
| `GitHubProvider` | `vitemcp` | GitHub OAuth           |
| `AzureProvider`  | `vitemcp` | Azure/Entra ID         |
| `OAuthProvider`  | `vitemcp` | Any OAuth 2.0 provider |

**Generic OAuth Provider** (for SAP, Auth0, Okta, etc.):

```ts
import { ViteMCP, OAuthProvider } from "@vitemcp/server";

const server = new ViteMCP({
  auth: new OAuthProvider({
    authorizationEndpoint: process.env.OAUTH_AUTH_ENDPOINT!,
    baseUrl: "https://your-server.com",
    clientId: process.env.OAUTH_CLIENT_ID!,
    clientSecret: process.env.OAUTH_CLIENT_SECRET!,
    scopes: ["openid", "profile"],
    tokenEndpoint: process.env.OAUTH_TOKEN_ENDPOINT!,
  }),
  name: "My Server",
  version: "1.0.0",
});
```

#### Tool Authorization

Control tool access using the `canAccess` property with built-in helper functions:

```ts
import {
  requireAuth,
  requireScopes,
  requireRole,
  requireAll,
  requireAny,
  getAuthSession,
} from "@vitemcp/server";

// Require any authenticated user
server.addTool({
  canAccess: requireAuth,
  name: "user-tool",
  // ...
});

// Require specific OAuth scopes
server.addTool({
  canAccess: requireScopes("read:user", "write:data"),
  name: "scoped-tool",
  // ...
});

// Require specific role
server.addTool({
  canAccess: requireRole("admin"),
  name: "admin-tool",
  // ...
});

// Combine with AND logic
server.addTool({
  canAccess: requireAll(requireAuth, requireRole("admin")),
  name: "admin-only",
  // ...
});

// Combine with OR logic
server.addTool({
  canAccess: requireAny(requireRole("admin"), requireRole("moderator")),
  name: "staff-tool",
  // ...
});
```

**Custom Authorization:**

For custom logic, pass a function directly:

```typescript
server.addTool({
  name: "custom-auth-tool",
  canAccess: (auth) =>
    auth?.role === "admin" && auth?.department === "engineering",
  execute: async () => "Access granted!",
});
```

**Extracting Session Data:**

Use `getAuthSession` for type-safe access to the OAuth session in your tool execute functions:

```typescript
import { getAuthSession, GoogleSession } from "@vitemcp/server";

server.addTool({
  canAccess: requireAuth,
  name: "get-profile",
  execute: async (_args, { session }) => {
    // Type-safe destructuring (throws if not authenticated)
    const { accessToken } = getAuthSession(session);

    // Or with provider-specific typing:
    // const { accessToken } = getAuthSession<GoogleSession>(session);

    const response = await fetch("https://api.example.com/user", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return JSON.stringify(await response.json());
  },
});
```

> **Note:** You can also access `session.accessToken` directly, but you must handle the case where `session` is undefined. The `getAuthSession` helper throws a clear error if the session is not authenticated, making it safer when used with `canAccess: requireAuth`.

#### Custom Authentication

For non-OAuth scenarios (API keys, custom tokens), use the `authenticate` option:

```ts
const server = new ViteMCP({
  name: "My Server",
  version: "1.0.0",
  authenticate: (request) => {
    const apiKey = request.headers["x-api-key"];

    if (apiKey !== "123") {
      throw new Response(null, {
        status: 401,
        statusText: "Unauthorized",
      });
    }

    return { id: 1, role: "user" };
  },
});

server.addTool({
  name: "sayHello",
  execute: async (args, { session }) => {
    return `Hello, ${session.id}!`;
  },
});
```

#### OAuth Proxy

The `auth` option uses ViteMCP's built-in **OAuth Proxy** that acts as a secure intermediary between MCP clients and upstream OAuth providers. The proxy handles the complete OAuth 2.1 authorization flow, including Dynamic Client Registration (DCR), PKCE, consent management, and token management with encryption and token swap patterns enabled by default.

**Key Features:**

- 🔐 **Secure by Default**: Automatic encryption (AES-256-GCM) and token swap pattern
- 🚀 **Zero Configuration**: Auto-generates keys and handles OAuth flows automatically
- 🔌 **Pre-configured Providers**: Built-in support for Google, GitHub, and Azure
- 🎯 **RFC Compliant**: Implements DCR (RFC 7591), PKCE, and OAuth 2.1
- 🔑 **Optional JWKS**: Support for RS256/ES256 token verification (via optional `jose` dependency)

**Quick Start:**

```ts
import {
  ViteMCP,
  getAuthSession,
  GoogleProvider,
  requireAuth,
} from "@vitemcp/server";

const server = new ViteMCP({
  auth: new GoogleProvider({
    baseUrl: "https://your-server.com",
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  }),
  name: "My Server",
  version: "1.0.0",
});

server.addTool({
  canAccess: requireAuth,
  name: "protected-tool",
  execute: async (_args, { session }) => {
    const { accessToken } = getAuthSession(session);
    // Use accessToken to call upstream APIs
    return "Authenticated!";
  },
});
```

**Advanced Configuration:**

For more control over OAuth behavior, you can use the `oauth` option directly:

```ts
import { ViteMCP } from "@vitemcp/server";
import { GoogleProvider } from "@vitemcp/server/auth";

const authProvider = new GoogleProvider({
  baseUrl: "https://your-server.com",
  clientId: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  scopes: ["openid", "profile", "email"],
});

const server = new ViteMCP({
  name: "My Server",
  oauth: {
    authorizationServer: authProvider
      .getProxy()
      .getAuthorizationServerMetadata(),
    enabled: true,
    proxy: authProvider.getProxy(),
  },
  version: "1.0.0",
});
```

**Documentation:**

- [OAuth Proxy Features](docs/oauth-proxy-features.md) - Complete feature list and capabilities
- [OAuth Proxy Implementation Guide](docs/oauth-proxy-guide.md) - Setup and configuration

#### OAuth Discovery Endpoints

ViteMCP also supports OAuth discovery endpoints for direct integration with OAuth providers, supporting both **MCP Specification 2025-03-26** and **MCP Specification 2025-06-18**. This provides standard discovery endpoints that comply with RFC 8414 (OAuth 2.0 Authorization Server Metadata) and RFC 9470 (OAuth 2.0 Protected Resource Metadata):

```ts
import { ViteMCP } from "@vitemcp/server";
import buildGetJwks from "get-jwks";
import fastJwt, { type DecodedJwt } from "fast-jwt";

const server = new ViteMCP({
  name: "My Server",
  version: "1.0.0",
  oauth: {
    enabled: true,
    authorizationServer: {
      issuer: "https://auth.example.com",
      authorizationEndpoint: "https://auth.example.com/oauth/authorize",
      tokenEndpoint: "https://auth.example.com/oauth/token",
      jwksUri: "https://auth.example.com/.well-known/jwks.json",
      responseTypesSupported: ["code"],
    },
    protectedResource: {
      resource: "mcp://my-server",
      authorizationServers: ["https://auth.example.com"],
    },
  },
  authenticate: async (request) => {
    const authHeader = request.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      throw new Response(null, {
        status: 401,
        statusText: "Missing or invalid authorization header",
      });
    }

    const token = authHeader.slice(7); // Remove 'Bearer ' prefix

    // Validate OAuth JWT access token using OpenID Connect discovery
    try {
      // Create JWKS client for token verification
      const getJwks = buildGetJwks();

      // Create JWT verifier
      const verify = fastJwt.createVerifier({
        async key({ header }: DecodedJwt) {
          const publicKey = await getJwks.getPublicKey({
            kid: header.kid,
            alg: header.alg,
            domain: "https://auth.example.com",
          });
          return publicKey;
        },
        algorithms: ["RS256"],
      });

      // Verify the JWT token
      const payload = await verify(token);

      return {
        userId: payload.sub,
        scope: payload.scope,
        email: payload.email,
        // Include other claims as needed
      };
    } catch (error) {
      throw new Response(null, {
        status: 401,
        statusText: "Invalid OAuth token",
      });
    }
  },
});
```

If your MCP server is published below an issuer path, configure the HTTP
stream base path as well:

```ts
server.start({
  transportType: "httpStream",
  httpStream: {
    basePath: "/issuer1",
    endpoint: "/mcp",
    port: 8080,
  },
});
```

With this configuration, ViteMCP serves the issuer-path authorization server
metadata at `/.well-known/oauth-authorization-server/issuer1`, while protected
resource metadata remains available for the MCP endpoint at
`/.well-known/oauth-protected-resource/issuer1/mcp`.

This configuration automatically exposes OAuth discovery endpoints:

- `/.well-known/oauth-authorization-server` - Authorization server metadata (RFC 8414)
- `/.well-known/oauth-authorization-server<basePath>` - Authorization server metadata when `httpStream.basePath` is set (RFC 8414 Section 3)
- `/.well-known/oauth-protected-resource` - Protected resource metadata (RFC 9728)
- `/.well-known/oauth-protected-resource<endpoint>` - Protected resource metadata at sub-path (MCP 2025-11-25)

**Discovery Mechanism (MCP Specification 2025-11-25):**

Clients discover protected resource metadata using the following search order:

1. **WWW-Authenticate header** - Primary method (handled automatically by mcp-proxy)
2. **Sub-path well-known** - `/.well-known/oauth-protected-resource<endpoint>` (e.g., `/.well-known/oauth-protected-resource/mcp`)
3. **Root well-known** - `/.well-known/oauth-protected-resource` (fallback)

Both the sub-path and root endpoints return identical metadata, ensuring compatibility with all MCP client implementations.

For JWT token validation, you can use libraries like [`get-jwks`](https://github.com/nearform/get-jwks) and [`fast-jwt`](https://github.com/nearform/fast-jwt) for OAuth JWT tokens.

#### Passing Headers Through Context

If you are exposing your MCP server via HTTP, you may wish to allow clients to supply sensitive keys via headers, which can then be passed along to APIs that your tools interact with, allowing each client to supply their own API keys. This can be done by capturing the HTTP headers in the `authenticate` section and storing them in the session to be referenced by the tools later.

```ts
import { ViteMCP } from "@vitemcp/server";
import { IncomingHttpHeaders } from "http";

// Define the session data type
interface SessionData {
  headers: IncomingHttpHeaders;
  [key: string]: unknown; // Add index signature to satisfy Record<string, unknown>
}

// Create a server instance
const server = new ViteMCP({
  name: "My Server",
  version: "1.0.0",
  authenticate: async (request: any): Promise<SessionData> => {
    // Authentication logic
    return {
      headers: request.headers,
    };
  },
});

// Tool to display HTTP headers
server.addTool({
  name: "headerTool",
  description: "Reads HTTP headers from the request",
  execute: async (args: any, context: any) => {
    const session = context.session as SessionData;
    const headers = session?.headers ?? {};

    const getHeaderString = (header: string | string[] | undefined) =>
      Array.isArray(header) ? header.join(", ") : (header ?? "N/A");

    const userAgent = getHeaderString(headers["user-agent"]);
    const authorization = getHeaderString(headers["authorization"]);
    return `User-Agent: ${userAgent}\nAuthorization: ${authorization}\nAll Headers: ${JSON.stringify(headers, null, 2)}`;
  },
});

// Start the server
server.start({
  transportType: "httpStream",
  httpStream: {
    port: 8080,
  },
});
```

A client that would connect to this may look something like this:

```ts
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const transport = new StreamableHTTPClientTransport(
  new URL(`http://localhost:8080/mcp`),
  {
    requestInit: {
      headers: {
        Authorization: "Test 123",
      },
    },
  },
);

const client = new Client({
  name: "example-client",
  version: "1.0.0",
});

(async () => {
  await client.connect(transport);

  // Call a tool
  const result = await client.callTool({
    name: "headerTool",
    arguments: {
      arg1: "value",
    },
  });

  console.log("Tool result:", result);
})().catch(console.error);
```

What would show up in the console after the client runs is something like this:

```
Tool result: {
  content: [
    {
      type: 'text',
      text: 'User-Agent: node\n' +
        'Authorization: Test 123\n' +
        'All Headers: {\n' +
        '  "host": "localhost:8080",\n' +
        '  "connection": "keep-alive",\n' +
        '  "authorization": "Test 123",\n' +
        '  "content-type": "application/json",\n' +
        '  "accept": "application/json, text/event-stream",\n' +
        '  "accept-language": "*",\n' +
        '  "sec-fetch-mode": "cors",\n' +
        '  "user-agent": "node",\n' +
        '  "accept-encoding": "gzip, deflate",\n' +
        '  "content-length": "163"\n' +
        '}'
    }
  ]
}
```

### Providing Instructions

You can provide instructions to the server using the `instructions` option:

```ts
const server = new ViteMCP({
  name: "My Server",
  version: "1.0.0",
  instructions:
    'Instructions describing how to use the server and its features.\n\nThis can be used by clients to improve the LLM\'s understanding of available tools, resources, etc. It can be thought of like a "hint" to the model. For example, this information MAY be added to the system prompt.',
});
```

### Multi round-trip requests

On the stateless protocol a server cannot pause mid-execution and ask the
client a question — there is no session to hold the suspended call. Instead the
handler _returns_ a request for more input, and the client re-issues the whole
call with the answers attached.

```ts
import { z } from "zod";

const confirmSchema = z.object({ confirmed: z.boolean() });

server.addTool({
  name: "delete-everything",
  parameters: z.object({ target: z.string() }),
  execute: async ({ target }, ctx) => {
    if (!ctx.inputResponses) {
      return ctx.inputRequired(
        {
          confirm: ctx.elicit({
            message: `Really delete ${target}?`,
            requestedSchema: confirmSchema,
          }),
        },
        // Optional opaque state, echoed back verbatim on the retry.
        JSON.stringify({ target }),
      );
    }

    const answer = ctx.input("confirm", confirmSchema);
    return answer?.confirmed ? `Deleted ${target}` : "Cancelled";
  },
});
```

Two consequences worth internalising:

- **Handlers are re-entrant.** `execute` runs again from the top on the retry.
  Do not do irreversible work before you have the input you need.
- **`requestState` is attacker-controlled on the way back.** It round-trips
  through the client. If it influences authorization or resource access, sign
  or encrypt it and reject anything that fails verification — ViteMCP does not
  do that for you.

### Cacheable results

`tools/list`, `prompts/list`, `resources/list`, `resources/templates/list` and
`resources/read` carry cache hints on this revision. Set them per resource:

```ts
server.addResource({
  name: "Changelog",
  uri: "docs://changelog",
  cache: { cacheScope: "public", ttlMs: 60_000 },
  load: async () => ({ text: await readChangelog() }),
});
```

`cacheScope: "private"` restricts caching to the requesting client; `"public"`
permits shared intermediaries.

### Migrating from the session-based API

Revision 2026-07-28 removed protocol sessions, the `initialize` handshake,
`ping`, `logging/setLevel`, roots, `resources/subscribe` and SSE resumability.
The corresponding ViteMCP surface went with them:

| Removed                                                                     | Replacement                                           |
| --------------------------------------------------------------------------- | ----------------------------------------------------- |
| `ViteMCPSession`, `server.sessions`, `server.on("connect" \| "disconnect")` | Nothing — requests are self-contained                 |
| `context.session`                                                           | `context.auth` (per-request `authenticate` result)    |
| `context.sessionId`                                                         | Nothing. Correlate with your own identifier if needed |
| `await context.elicit(...)`                                                 | Return `ctx.inputRequired({ ... })` — see above       |
| `session.requestSampling(...)`                                              | Call your LLM provider directly                       |
| `session.roots`, `session.clientCapabilities`, `session.loggingLevel`       | Nothing                                               |
| `context.streamContent(...)`                                                | `context.reportProgress(...)`                         |
| `httpStream.stateless`                                                      | Nothing — every deployment is stateless               |
| `httpStream.eventStore`                                                     | Nothing — stream resumability was removed             |
| `ping` / `roots` server options                                             | Nothing                                               |

`authenticate` now receives a web-standard `Request` rather than a Node
`IncomingMessage`, so read headers with `request.headers.get("...")`.

## Running Your Server

### Unit testing with an in-memory transport

`server.connect(transport)` attaches the server to a transport you construct yourself, instead of letting `start()` create one. Paired with the SDK's `InMemoryTransport`, this lets you drive a server in-process — no port to bind, no subprocess to spawn — which is usually what you want for testing a `stdio` server:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

async function createTestClient(server: ViteMCP) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test-client", version: "0.0.0" });

  const [session] = await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { client, session };
}

test("adds two numbers", async () => {
  const { client } = await createTestClient(server);

  expect(
    await client.callTool({ arguments: { a: 2, b: 3 }, name: "add" }),
  ).toEqual({
    content: [{ text: "5", type: "text" }],
  });

  await client.close();
});
```

The session is built from the tools, resources and prompts registered on the instance, exactly as `start()` builds it, so your tests exercise the same wiring the real server uses — including `canAccess` filtering and the `connect`/`disconnect` events.

Pass session auth as the second argument, equivalent to what your `authenticate` function would return:

```ts
await server.connect(serverTransport, { id: 7, role: "admin" });
```

The transport's lifecycle belongs to you: `stop()` does not close transports passed to `connect`, so close the client when the test finishes.

### Test with `mcp-cli`

The fastest way to test and debug your server is with `vitemcp dev`:

```bash
npx @vitemcp/server dev server.js
npx @vitemcp/server dev server.ts
```

This will run your server with [`mcp-cli`](https://github.com/wong2/mcp-cli) for testing and debugging your MCP server in the terminal.

To call a tool non-interactively (for example, in scripts or automated tests), pass `--tool` and optional JSON `--args`:

```bash
npx @vitemcp/server dev server.ts --tool add --args '{"a":1,"b":2}'
```

This prints the tool result as JSON and exits, instead of opening the interactive inspector. `--watch` has no effect in this mode, since the server is started for a single call.

### Inspect with `MCP Inspector`

Another way is to use the official [`MCP Inspector`](https://modelcontextprotocol.io/docs/tools/inspector) to inspect your server with a Web UI:

```bash
npx @vitemcp/server inspect server.ts
```

## FAQ

### How to use with Claude Desktop?

Follow the guide https://modelcontextprotocol.io/quickstart/user and add the following configuration:

```json
{
  "mcpServers": {
    "my-mcp-server": {
      "command": "npx",
      "args": ["tsx", "/PATH/TO/YOUR_PROJECT/src/index.ts"],
      "env": {
        "YOUR_ENV_VAR": "value"
      }
    }
  }
}
```

### How to run ViteMCP behind a proxy?

Refer to this [issue](https://github.com/vitemcp/vitemcp/issues/25#issuecomment-3004568732) for an example of using ViteMCP with `express` and `http-proxy-middleware`.

## Showcase

> [!NOTE]
>
> If you've developed a server using ViteMCP, please [submit a PR](https://github.com/vitemcp/vitemcp) to showcase it here!

> [!NOTE]
>
> If you are looking for a boilerplate repository to build your own MCP server, check out [fastmcp-boilerplate](https://github.com/punkpeye/fastmcp-boilerplate).

- [apinetwork/piapi-mcp-server](https://github.com/apinetwork/piapi-mcp-server) - generate media using Midjourney/Flux/Kling/LumaLabs/Udio/Chrip/Trellis
- [domdomegg/computer-use-mcp](https://github.com/domdomegg/computer-use-mcp) - controls your computer
- [LiterallyBlah/Dradis-MCP](https://github.com/LiterallyBlah/Dradis-MCP) – manages projects and vulnerabilities in Dradis
- [Meeting-Baas/meeting-mcp](https://github.com/Meeting-Baas/meeting-mcp) - create meeting bots, search transcripts, and manage recording data
- [drumnation/unsplash-smart-mcp-server](https://github.com/drumnation/unsplash-smart-mcp-server) – enables AI agents to seamlessly search, recommend, and deliver professional stock photos from Unsplash
- [ssmanji89/halopsa-workflows-mcp](https://github.com/ssmanji89/halopsa-workflows-mcp) - HaloPSA Workflows integration with AI assistants
- [aiamblichus/mcp-chat-adapter](https://github.com/aiamblichus/mcp-chat-adapter) – provides a clean interface for LLMs to use chat completion
- [eyaltoledano/claude-task-master](https://github.com/eyaltoledano/claude-task-master) – advanced AI project/task manager powered by ViteMCP
- [cswkim/discogs-mcp-server](https://github.com/cswkim/discogs-mcp-server) - connects to the Discogs API for interacting with your music collection
- [Panzer-Jack/feuse-mcp](https://github.com/Panzer-Jack/feuse-mcp) - Frontend Useful MCP Tools - Essential utilities for web developers to automate API integration and code generation
- [sunra-ai/sunra-clients](https://github.com/sunra-ai/sunra-clients/tree/main/mcp-server) - Sunra.ai is a generative media platform built for developers, providing high-performance AI model inference capabilities.
- [foxtrottwist/shortcuts-mcp](https://github.com/foxtrottwist/shortcuts-mcp) - connects Claude to macOS Shortcuts for system automation, app integration, and interactive workflows

## Acknowledgements

- Parts of codebase were adopted from [LiteMCP](https://github.com/wong2/litemcp).
- Parts of codebase were adopted from [Model Context protocolでSSEをやってみる](https://dev.classmethod.jp/articles/mcp-sse/).

This project is tested with BrowserStack.
