/**
 * Edge-compatible ViteMCP server for Cloudflare Workers, Deno, and Bun.
 *
 * Web-standard APIs only. `createMcpHandler` already exposes the
 * `(Request) => Response` shape edge runtimes want; this is a thin wrapper.
 */
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { StandardSchemaV1 } from "@standard-schema/spec";
import { Hono } from "hono";
import { z } from "zod";

import { formatBytes } from "../formatBytes.js";
import {
  type JsonSchemaConverter,
  toSdkSchema,
  valibotToJsonSchema,
} from "../toSdkSchema.js";

export type EdgeFetchHandler = (request: Request) => Promise<Response>;

/**
 * Logger interface for edge environments
 */
export interface EdgeLogger {
  debug(...args: unknown[]): void;
  error(...args: unknown[]): void;
  info(...args: unknown[]): void;
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/**
 * Prompt definition for EdgeViteMCP
 */
export interface EdgePrompt {
  arguments?: Array<{ description?: string; name: string; required?: boolean }>;
  description?: string;
  load: (args: Record<string, string>) => Promise<string>;
  name: string;
}

/**
 * Resource definition for EdgeViteMCP
 */
export interface EdgeResource {
  description?: string;
  load: () => Promise<
    { blob?: string; mimeType?: string; text?: string } | string
  >;
  mimeType?: string;
  name: string;
  uri: string;
}

/**
 * Tool definition for EdgeViteMCP
 */
export interface EdgeTool<TParams = unknown> {
  description: string;
  execute: (params: TParams) => Promise<
    | {
        content: Array<{
          data?: string;
          mimeType?: string;
          text?: string;
          type: string;
        }>;
      }
    | string
  >;
  name: string;
  parameters?: StandardSchemaV1<TParams> | z.ZodType<TParams>;
}

/**
 * Options for EdgeViteMCP
 */
export interface EdgeViteMCPOptions {
  description?: string;
  logger?: EdgeLogger;
  /**
   * Largest request body the MCP endpoint accepts, in bytes (default: 1 MiB,
   * as on the Node transport). A larger one is refused without being held in
   * memory. Routes added through `getApp()` are not covered.
   */
  maxBodySize?: number;
  /**
   * Base path for MCP endpoints (default: "/mcp")
   */
  mcpPath?: string;
  name: string;
  version: string;
}

/**
 * JSON Schema for a schema that carries none, from the one converter this
 * entry point can afford. `ViteMCP` hands every other library to xsschema,
 * which reaches each converter through an `import()` a bundler has to resolve:
 * an edge bundle would then fail to build for want of Effect or Sury, whichever
 * library the server was actually written in.
 */
const convertToJsonSchema: JsonSchemaConverter = async (schema, io) => {
  const { vendor } = schema["~standard"];

  if (vendor !== "valibot") {
    throw new Error(
      `Schema library "${vendor}" carries no JSON Schema (\`~standard.jsonSchema\`), and EdgeViteMCP converts only Valibot's. Use Zod 4, ArkType or Valibot.`,
    );
  }

  return valibotToJsonSchema(schema, io);
};

/**
 * The request with its body read under a hard cap, or `null` when the body is
 * larger than that.
 *
 * The SDK reads whatever it is handed in full, so the cap has to be applied
 * before it sees the request — and while reading, not after: a declared
 * `Content-Length` over the cap is refused before a byte is read, and a body
 * that declares none is abandoned at the first chunk past it.
 */
const readCappedRequest = async (
  request: Request,
  maxBytes: number,
): Promise<null | Request> => {
  if (!request.body) {
    return request;
  }

  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) {
    return null;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    size += value.byteLength;

    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }

    chunks.push(value);
  }

  const body = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // Rebuilt rather than cloned: the original's body is spent.
  return new Request(request.url, {
    body,
    headers: request.headers,
    method: request.method,
    signal: request.signal,
  });
};

/** The Node transport's default for `httpStream.maxBodySize`. */
const DEFAULT_MAX_BODY_SIZE = 1024 * 1024;

/** A refusal in the shape the Node transport gives a body it will not take. */
const invalidRequest = (description: string): Response =>
  Response.json(
    { error: "invalid_request", error_description: description },
    { status: 400 },
  );

export class EdgeViteMCP {
  #handler: null | ReturnType<typeof createMcpHandler> = null;
  #honoApp = new Hono();
  #logger: EdgeLogger;
  #maxBodySize: number;
  #mcpPath: string;
  #name: string;
  #prompts: EdgePrompt[] = [];
  #resources: EdgeResource[] = [];
  #tools: EdgeTool[] = [];
  /** Each tool's input schema, as `#sdkSchemaFor` converted it. */
  #toolSchemas = new WeakMap<
    EdgeTool,
    Promise<{ inputSchema: unknown } | undefined>
  >();
  #version: string;

  constructor(options: EdgeViteMCPOptions) {
    this.#name = options.name;
    this.#version = options.version;
    this.#logger = options.logger ?? console;
    this.#maxBodySize = options.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
    this.#mcpPath = options.mcpPath ?? "/mcp";
  }

  addPrompt(prompt: EdgePrompt): this {
    this.#prompts.push(prompt);
    this.#handler = null;
    return this;
  }

  addResource(resource: EdgeResource): this {
    this.#resources.push(resource);
    this.#handler = null;
    return this;
  }

  addTool<TParams>(tool: EdgeTool<TParams>): this {
    this.#tools.push(tool as EdgeTool);
    this.#handler = null;
    return this;
  }

  /** Main entry point for edge runtimes. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === this.#mcpPath) {
      let capped: null | Request;

      try {
        capped = await readCappedRequest(request, this.#maxBodySize);
      } catch (error) {
        // A body that aborts mid-stream rejects here. Answer it, as the Node
        // transport does, rather than let the rejection escape the handler.
        this.#logger.debug(`[EdgeViteMCP] request body failed:`, error);

        return invalidRequest("Request body could not be read");
      }

      if (!capped) {
        return invalidRequest(
          `Request body exceeds ${formatBytes(this.#maxBodySize)}`,
        );
      }

      this.#handler ??= createMcpHandler(() => this.#buildServer());
      return this.#handler.fetch(capped);
    }

    return this.#honoApp.fetch(request);
  }

  /** The Hono app, for adding custom routes alongside the MCP endpoint. */
  getApp(): Hono {
    return this.#honoApp;
  }

  async #buildServer(): Promise<McpServer> {
    const server = new McpServer({
      name: this.#name,
      version: this.#version,
    });

    // A tool whose schema cannot be advertised is left out rather than allowed
    // to fail the request: `tools/list` describes every tool at once, so one
    // such tool took the list down for all of them.
    const tools = (
      await Promise.all(
        this.#tools.map(async (tool) => {
          const schema = await this.#sdkSchemaFor(tool);

          return schema && { schema, tool };
        }),
      )
    ).filter((entry) => entry !== undefined);

    for (const { schema, tool } of tools) {
      const call = async (args: unknown) => {
        const result = await tool.execute(args as never);
        return typeof result === "string"
          ? { content: [{ text: result, type: "text" }] }
          : result;
      };

      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: schema.inputSchema as never,
        },
        // The SDK passes arguments only to a tool that declares an input
        // schema; one that does not is called with the request context alone,
        // which must not reach `execute` as its parameters.
        (schema.inputSchema ? call : () => call(undefined)) as never,
      );
    }

    for (const resource of this.#resources) {
      server.registerResource(
        resource.name,
        resource.uri,
        { description: resource.description, mimeType: resource.mimeType },
        (async (uri: URL) => {
          const loaded = await resource.load();
          const body = typeof loaded === "string" ? { text: loaded } : loaded;
          return {
            contents: [
              {
                ...body,
                mimeType: body.mimeType ?? resource.mimeType,
                uri: uri.toString(),
              },
            ],
          };
        }) as never,
      );
    }

    for (const prompt of this.#prompts) {
      const shape: Record<string, z.ZodType> = {};
      for (const arg of prompt.arguments ?? []) {
        shape[arg.name] = arg.required ? z.string() : z.string().optional();
      }

      const argsSchema = prompt.arguments?.length ? z.object(shape) : undefined;

      const load = async (args?: Record<string, string>) => {
        const text = await prompt.load(args ?? {});
        return {
          messages: [
            { content: { text, type: "text" }, role: "user" as const },
          ],
        };
      };

      server.registerPrompt(
        prompt.name,
        { argsSchema, description: prompt.description } as never,
        // As for tools: without `argsSchema` the SDK passes the request
        // context alone.
        (argsSchema ? load : () => load()) as never,
      );
    }

    this.#logger.debug(`[EdgeViteMCP] built server ${this.#name}`);

    return server;
  }

  /**
   * A tool's input schema in the form the SDK registers it, or `undefined` for
   * a tool whose schema cannot be converted — reported when that is found.
   *
   * Converted once per tool: `#buildServer` runs on every request, so a tool
   * that cannot be served would otherwise be reported on each of them.
   */
  #sdkSchemaFor(tool: EdgeTool): Promise<{ inputSchema: unknown } | undefined> {
    let schema = this.#toolSchemas.get(tool);

    if (!schema) {
      schema = toSdkSchema(tool.parameters, "input", convertToJsonSchema).then(
        (inputSchema) => ({ inputSchema }),
        (error: unknown) => {
          this.#logger.error(
            `[EdgeViteMCP] Tool "${tool.name}" is not served:`,
            error,
          );

          return undefined;
        },
      );
      this.#toolSchemas.set(tool, schema);
    }

    return schema;
  }
}
