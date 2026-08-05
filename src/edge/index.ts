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
   * Base path for MCP endpoints (default: "/mcp")
   */
  mcpPath?: string;
  name: string;
  version: string;
}

export class EdgeViteMCP {
  #handler: null | ReturnType<typeof createMcpHandler> = null;
  #honoApp = new Hono();
  #logger: EdgeLogger;
  #mcpPath: string;
  #name: string;
  #prompts: EdgePrompt[] = [];
  #resources: EdgeResource[] = [];
  #tools: EdgeTool[] = [];
  #version: string;

  constructor(options: EdgeViteMCPOptions) {
    this.#name = options.name;
    this.#version = options.version;
    this.#logger = options.logger ?? console;
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
      this.#handler ??= createMcpHandler(() => this.#buildServer());
      return this.#handler.fetch(request);
    }

    return this.#honoApp.fetch(request);
  }

  /** The Hono app, for adding custom routes alongside the MCP endpoint. */
  getApp(): Hono {
    return this.#honoApp;
  }

  #buildServer(): McpServer {
    const server = new McpServer({
      name: this.#name,
      version: this.#version,
    });

    for (const tool of this.#tools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.parameters as never,
        },
        (async (args: unknown) => {
          const result = await tool.execute(args as never);
          return typeof result === "string"
            ? { content: [{ text: result, type: "text" }] }
            : result;
        }) as never,
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

      server.registerPrompt(
        prompt.name,
        {
          argsSchema: prompt.arguments?.length ? z.object(shape) : undefined,
          description: prompt.description,
        } as never,
        (async (args: Record<string, string>) => {
          const text = await prompt.load(args ?? {});
          return {
            messages: [
              { content: { text, type: "text" }, role: "user" as const },
            ],
          };
        }) as never,
      );
    }

    this.#logger.debug(`[EdgeViteMCP] built server ${this.#name}`);

    return server;
  }
}
