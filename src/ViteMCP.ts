import {
  acceptedContent,
  type CacheScope,
  completable,
  createMcpHandler,
  fromJsonSchema,
  type InputRequest,
  inputRequired,
  type InputRequiredResult,
  localhostAllowedOrigins,
  type McpHttpHandler,
  McpServer,
  originValidationResponse,
  ResourceTemplate as SDKResourceTemplate,
  type ToolAnnotations as SDKToolAnnotations,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import { StandardSchemaV1 } from "@standard-schema/spec";
import { readFile } from "fs/promises";
import { Hono } from "hono";
import { cors } from "hono/cors";
import http from "http";
import https from "https";
import { setTimeout as delay } from "timers/promises";
import { fetch } from "undici";
import parseURITemplate from "uri-templates";
import { strictJsonSchema, toJsonSchema } from "xsschema";
import { z } from "zod";

import type { OAuthProxy } from "./auth/OAuthProxy.js";
import type {
  AuthProvider,
  OAuthSession,
} from "./auth/providers/AuthProvider.js";

import { createOAuthRouter, OAUTH_PROXY_MAX_BODY_SIZE } from "./auth/router.js";

export interface Logger {
  debug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export const MEDIA_FETCH_TIMEOUT_MS = 30000;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

type MediaSource = { timeoutMs?: number } & (
  | { buffer: Buffer }
  | { path: string }
  | { url: string }
);

export abstract class ViteMCPError extends Error {
  public constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnexpectedStateError extends ViteMCPError {
  public extras?: Record<string, unknown>;

  public constructor(message: string, extras?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.extras = extras;
  }
}

/* -------------------------------------------------------------------------- */
/* Media helpers (protocol-independent)                                        */
/* -------------------------------------------------------------------------- */

/**
 * An error that is meant to be surfaced to the user, rather than logged as an
 * internal failure. Thrown from a tool handler, it becomes the tool's error
 * result rather than a protocol-level error.
 */
export class UserError extends UnexpectedStateError {}

const readMedia = async (
  source: MediaSource,
  kind: "audio" | "image",
): Promise<{ data: string; mimeType: string }> => {
  let rawData: Buffer;

  try {
    if ("url" in source) {
      const response = await fetch(source.url, {
        signal: AbortSignal.timeout(source.timeoutMs ?? MEDIA_FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Server responded with status: ${response.status}`);
      }

      rawData = Buffer.from(await response.arrayBuffer());
    } else if ("path" in source) {
      rawData = await readFile(source.path);
    } else if ("buffer" in source) {
      rawData = source.buffer;
    } else {
      throw new Error(
        `Invalid ${kind} source: provide one of url, path, or buffer`,
      );
    }
  } catch (error) {
    if ("url" in source) {
      const reason =
        error instanceof Error && error.name === "TimeoutError"
          ? `timed out after ${source.timeoutMs ?? MEDIA_FETCH_TIMEOUT_MS}ms`
          : error instanceof Error
            ? error.message
            : String(error);

      throw new Error(
        `Failed to fetch ${kind} from URL (${source.url}): ${reason}`,
      );
    }

    if (error instanceof Error) {
      throw error;
    }

    throw new Error(`Unexpected error processing ${kind}: ${String(error)}`);
  }

  const { fileTypeFromBuffer } = await import("file-type");
  const mimeType = await fileTypeFromBuffer(rawData);

  return {
    data: rawData.toString("base64"),
    mimeType: mimeType?.mime ?? (kind === "image" ? "image/png" : "audio/mpeg"),
  };
};

export const imageContent = async (
  source: MediaSource,
): Promise<ImageContent> => {
  const { data, mimeType } = await readMedia(source, "image");
  return { data, mimeType, type: "image" } as const;
};

export const audioContent = async (
  source: MediaSource,
): Promise<AudioContent> => {
  const { data, mimeType } = await readMedia(source, "audio");
  return { data, mimeType, type: "audio" } as const;
};

/* -------------------------------------------------------------------------- */
/* Content types                                                               */
/* -------------------------------------------------------------------------- */

export enum ServerState {
  Error = "error",
  Running = "running",
  Starting = "starting",
  Stopped = "stopped",
}

export type AudioContent = {
  data: string;
  mimeType: string;
  type: "audio";
};

/**
 * Freshness hint attached to cacheable results (`tools/list`, `prompts/list`,
 * `resources/list`, `resources/templates/list`, `resources/read`). Required by
 * the 2026-07-28 revision's `CacheableResult`.
 */
export type CacheHint = {
  cacheScope?: CacheScope;
  ttlMs?: number;
};

/** The spec's completion payload. */
export type Completion = {
  hasMore?: boolean;
  total?: number;
  values: string[];
};

export type Content =
  | AudioContent
  | ImageContent
  | ResourceContent
  | ResourceLink
  | TextContent;

export type ContentResult = {
  content: Content[];
  isError?: boolean;
  structuredContent?: unknown;
};

/**
 * Context handed to `execute` / `load`.
 *
 * On the 2026-07-28 revision there is no protocol session: every request is
 * self-contained. Anything that used to hang off a session — `sessionId`,
 * `clientCapabilities`, `roots`, the ready/close lifecycle — is gone. What
 * survives is per-request.
 */
export type Context<T extends ViteMCPAuth> = {
  /** Authentication result for this request, if an `authenticate` hook ran. */
  auth: T | undefined;

  /**
   * Builds an embedded elicitation request for {@link Context.inputRequired}.
   *
   * This is a *builder*, not a promise: on the stateless protocol the server
   * cannot block waiting for the client. Return the result of
   * `inputRequired()` and the client re-issues the whole request with
   * `inputResponses` populated.
   */
  elicit: (params: {
    message: string;
    requestedSchema: StandardSchemaV1;
  }) => InputRequest;

  /**
   * Reads one entry of `inputResponses` and validates it against the schema
   * used to request it. Returns `undefined` when the client declined or the
   * content does not match.
   */
  input: <S extends StandardSchemaV1>(
    key: string,
    schema: S,
  ) => StandardSchemaV1.InferOutput<S> | undefined;

  /**
   * Multi round-trip request: suspend this call and ask the client for more
   * input. `requestState` is opaque, server-minted, and comes back verbatim —
   * it is attacker-controlled on return, so integrity-protect it if it
   * influences authorization or resource access.
   */
  inputRequired: (
    inputRequests: Record<string, InputRequest>,
    requestState?: string,
  ) => InputRequiredResult;

  /**
   * Present when the client is retrying a request that previously returned
   * `input_required`. Absent on the first call.
   */
  inputResponses?: Record<string, unknown>;

  /**
   * Emits `notifications/message`. The spec forbids emitting these unless the
   * request opted in via `_meta` log level, so these are dropped when the
   * client did not ask for logs.
   */
  log: {
    debug: (message: string, data?: SerializableValue) => void;
    error: (message: string, data?: SerializableValue) => void;
    info: (message: string, data?: SerializableValue) => void;
    warn: (message: string, data?: SerializableValue) => void;
  };

  reportProgress: (progress: Progress) => Promise<void>;

  /** Request ID of the current MCP request. */
  requestId?: string;

  /** The `requestState` echoed back by the client on an MRTR retry. */
  requestState?: string;
};

export type ImageContent = {
  data: string;
  mimeType: string;
  type: "image";
};

/**
 * A single loaded resource body. `uri` is optional: when omitted the server
 * fills it in from the resource (or the expanded template) that produced it.
 */
export type LoadedResource = {
  blob?: string;
  mimeType?: string;
  text?: string;
  uri?: string;
};

export type Prompt<T extends ViteMCPAuth> = {
  arguments?: PromptArgument[];
  canAccess?: (auth: T) => boolean;
  /** Completes any argument. Per-argument `complete` wins over this. */
  complete?: (name: string, value: string) => Promise<Completion>;
  description?: string;
  load: (
    args: Record<string, string>,
    context: LoadContext<T>,
  ) => Promise<{ messages: unknown[] } | string>;
  name: string;
};

export type PromptArgument = {
  complete?: (value: string) => Promise<Completion>;
  description?: string;
  name: string;
  required?: boolean;
};

export type Resource<T extends ViteMCPAuth> = {
  cache?: CacheHint;
  canAccess?: (auth: T) => boolean;
  description?: string;
  load: (context: LoadContext<T>) => Promise<LoadedResource | LoadedResource[]>;
  mimeType?: string;
  name: string;
  uri: string;
};

/* -------------------------------------------------------------------------- */
/* Handler context                                                             */
/* -------------------------------------------------------------------------- */

export type ResourceTemplate<T extends ViteMCPAuth> = {
  arguments?: ResourceTemplateArgument[];
  cache?: CacheHint;
  canAccess?: (auth: T) => boolean;
  /** Completes any template variable. Per-argument `complete` wins over this. */
  complete?: (name: string, value: string) => Promise<Completion>;
  description?: string;
  load: (
    args: Record<string, string>,
    context: LoadContext<T>,
  ) => Promise<LoadedResource | LoadedResource[]>;
  mimeType?: string;
  name: string;
  uriTemplate: string;
};

export type ResourceTemplateArgument = {
  complete?: (value: string) => Promise<Completion>;
  description?: string;
  name: string;
  required?: boolean;
};

export type ServerOptions<T extends ViteMCPAuth> = {
  auth?: AuthProvider<T extends OAuthSession ? T : OAuthSession>;
  authenticate?: Authenticate<T>;
  health?: {
    enabled?: boolean;
    message?: string;
    path?: string;
    status?: number;
  };
  instructions?: string;
  logger?: Logger;
  name: string;
  oauth?: {
    authorizationServer?: Record<string, unknown>;
    enabled?: boolean;
    protectedResource?: Record<string, unknown>;
    proxy?: OAuthProxy;
  };
  version: `${number}.${number}.${number}`;
};

/* -------------------------------------------------------------------------- */
/* Authoring types                                                             */
/* -------------------------------------------------------------------------- */

export type TextContent = {
  text: string;
  type: "text";
};

export type Tool<
  T extends ViteMCPAuth,
  Params extends ToolParameters = ToolParameters,
  OutputParams extends ToolParameters = ToolParameters,
> = {
  _meta?: Record<string, unknown>;
  annotations?: SDKToolAnnotations;
  canAccess?: (auth: T) => boolean;
  description?: string;
  execute: (
    args: StandardSchemaV1.InferOutput<Params>,
    context: Context<T>,
  ) => Promise<
    | AudioContent
    | ContentResult
    | ImageContent
    | InputRequiredResult
    | ResourceContent
    | ResourceLink
    | StandardSchemaV1.InferOutput<OutputParams>
    | string
    | TextContent
    | void
  >;
  name: string;
  outputSchema?: OutputParams;
  parameters?: Params;
  timeoutMs?: number;
};

export type ViteMCPAuth = Record<string, unknown> | undefined;

type Authenticate<T> = (request: Request) => Promise<T>;

type Literal = boolean | null | number | string | undefined;

type LoadContext<T extends ViteMCPAuth> = Omit<Context<T>, "reportProgress">;

type Progress = {
  message?: string;
  progress: number;
  total?: number;
};

type ResourceContent = {
  resource: {
    blob?: string;
    mimeType?: string;
    text?: string;
    uri: string;
  };
  type: "resource";
};

type ResourceLink = {
  description?: string;
  mimeType?: string;
  name: string;
  type: "resource_link";
  uri: string;
};

type SerializableValue =
  | { [key: string]: SerializableValue }
  | Literal
  | SerializableValue[];

type ToolParameters = StandardSchemaV1;

/* -------------------------------------------------------------------------- */
/* Server                                                                      */
/* -------------------------------------------------------------------------- */

export class ViteMCP<T extends ViteMCPAuth = ViteMCPAuth> {
  public get serverState(): ServerState {
    return this.#serverState;
  }
  #authenticate: Authenticate<T> | undefined;
  #connectedServers: McpServer[] = [];
  #corsMiddleware: null | ReturnType<typeof cors> = null;
  #handler: McpHttpHandler | null = null;
  #honoApp = new Hono();
  #httpServer: http.Server | https.Server | null = null;
  #logger: Logger;
  #options: ServerOptions<T>;
  #prompts: Prompt<T>[] = [];
  #resources: Resource<T>[] = [];
  #resourceTemplates: ResourceTemplate<T>[] = [];
  #serverState: ServerState = ServerState.Stopped;
  #stdioHandle: null | StdioServerHandle = null;

  #tools: Tool<T>[] = [];

  public constructor(options: ServerOptions<T>) {
    this.#options = options;
    this.#logger = options.logger ?? console;

    // An AuthProvider supplies the authenticate hook. Resolved here rather
    // than inside the HTTP path so the wiring is not silently absent on
    // stdio / `connect()`.
    const provider = options.auth;
    this.#authenticate =
      options.authenticate ??
      (provider
        ? (((request: Request) =>
            provider.authenticate(request)) as unknown as Authenticate<T>)
        : undefined);

    this.#honoApp = this.#freshApp();
  }

  public addPrompt(prompt: Prompt<T>) {
    this.#prompts.push(prompt);
    this.#notifyListChanged("prompts");
  }

  public addPrompts(prompts: Prompt<T>[]) {
    for (const prompt of prompts) {
      this.#prompts.push(prompt);
    }
    this.#notifyListChanged("prompts");
  }

  public addResource(resource: Resource<T>) {
    this.#resources.push(resource);
    this.#notifyListChanged("resources");
  }

  public addResources(resources: Resource<T>[]) {
    for (const resource of resources) {
      this.#resources.push(resource);
    }
    this.#notifyListChanged("resources");
  }

  public addResourceTemplate(template: ResourceTemplate<T>) {
    this.#resourceTemplates.push(template);
    this.#notifyListChanged("resources");
  }

  public addResourceTemplates(templates: ResourceTemplate<T>[]) {
    for (const template of templates) {
      this.#resourceTemplates.push(template);
    }
    this.#notifyListChanged("resources");
  }

  public addTool<Params extends ToolParameters>(tool: Tool<T, Params>) {
    assertStandardSchema(tool.parameters, tool.name, "parameters");
    assertStandardSchema(tool.outputSchema, tool.name, "outputSchema");
    this.#tools.push(tool as unknown as Tool<T>);
    this.#notifyListChanged("tools");
  }

  public addTools<Params extends ToolParameters>(tools: Tool<T, Params>[]) {
    for (const tool of tools) {
      assertStandardSchema(tool.parameters, tool.name, "parameters");
      assertStandardSchema(tool.outputSchema, tool.name, "outputSchema");
      this.#tools.push(tool as unknown as Tool<T>);
    }
    this.#notifyListChanged("tools");
  }

  /**
   * Connects the server to an arbitrary transport — used for in-memory unit
   * testing, where a linked transport pair replaces a real socket.
   */
  public async connect(
    transport: Parameters<McpServer["connect"]>[0],
  ): Promise<McpServer> {
    const server = await this.#buildServer(undefined);
    await server.connect(transport);
    this.#connectedServers.push(server);
    this.#serverState = ServerState.Running;
    return server;
  }

  /**
   * Resolves a resource (or resource template) URI to an embeddable resource
   * body, for returning inline from a tool.
   */
  public async embedded(uri: string): Promise<LoadedResource> {
    const direct = this.#resources.find((resource) => resource.uri === uri);

    if (direct) {
      const loaded = await direct.load(this.#makeContext(undefined, undefined));
      const first = Array.isArray(loaded) ? loaded[0] : loaded;
      return { ...first, mimeType: first.mimeType ?? direct.mimeType, uri };
    }

    for (const template of this.#resourceTemplates) {
      const params = parseURITemplate(template.uriTemplate).fromUri(uri);

      if (!params) {
        continue;
      }

      const loaded = await template.load(
        params as Record<string, string>,
        this.#makeContext(undefined, undefined),
      );
      const first = Array.isArray(loaded) ? loaded[0] : loaded;
      return { ...first, mimeType: first.mimeType ?? template.mimeType, uri };
    }

    throw new UnexpectedStateError(`Resource not found: ${uri}`, { uri });
  }

  /** The Hono app serving the HTTP transport, for mounting custom routes. */
  public getApp(): Hono {
    return this.#honoApp;
  }

  /**
   * Publishes `notifications/resources/updated` for a URI to any subscription
   * that opted in to it.
   */
  public notifyResourceUpdated(uri: string): void {
    this.#handler?.notify.resourceUpdated(uri);
  }

  public removePrompt(name: string) {
    this.#prompts = this.#prompts.filter((p) => p.name !== name);
    this.#notifyListChanged("prompts");
  }

  public removePrompts(names: string[]) {
    this.#prompts = this.#prompts.filter((p) => !names.includes(p.name));
    this.#notifyListChanged("prompts");
  }

  public removeResource(name: string) {
    this.#resources = this.#resources.filter((r) => r.name !== name);
    this.#notifyListChanged("resources");
  }

  public removeResources(names: string[]) {
    this.#resources = this.#resources.filter((r) => !names.includes(r.name));
    this.#notifyListChanged("resources");
  }

  public removeResourceTemplate(name: string) {
    this.#resourceTemplates = this.#resourceTemplates.filter(
      (r) => r.name !== name,
    );
    this.#notifyListChanged("resources");
  }

  public removeResourceTemplates(names: string[]) {
    this.#resourceTemplates = this.#resourceTemplates.filter(
      (r) => !names.includes(r.name),
    );
    this.#notifyListChanged("resources");
  }

  public removeTool(name: string) {
    this.#tools = this.#tools.filter((t) => t.name !== name);
    this.#notifyListChanged("tools");
  }

  public removeTools(names: string[]) {
    this.#tools = this.#tools.filter((t) => !names.includes(t.name));
    this.#notifyListChanged("tools");
  }

  public async start(
    options:
      | {
          httpStream: {
            /** Origins permitted to reach the MCP endpoint (DNS-rebinding guard). */
            allowedOrigins?: string[];
            basePath?: string;
            cors?: false | Parameters<typeof cors>[0];
            enableJsonResponse?: boolean;
            endpoint?: string;
            host?: string;
            /**
             * Whether to also serve 2025-era clients.
             *
             * Defaults to `"stateless"`, which accepts both eras — the SDK
             * client negotiates 2025 unless configured with
             * `versionNegotiation: { mode: "auto" }`, so rejecting it locks
             * out most existing clients.
             *
             * `"reject"` serves only 2026-07-28, matching what
             * `server/discover` advertises and enforcing the required
             * `Mcp-Method`/`Mcp-Name` headers on every request.
             */
            legacy?: "reject" | "stateless";
            maxBodySize?: number;
            port: number;
            sslCa?: string;
            sslCert?: string;
            sslKey?: string;
          };
          transportType: "httpStream";
        }
      | { transportType: "stdio" },
  ): Promise<void> {
    this.#serverState = ServerState.Starting;

    try {
      if (options.transportType === "stdio") {
        this.#stdioHandle = serveStdio(() => this.#buildServer(undefined));
        this.#logger.info(`[ViteMCP info] server is running on stdio`);
      } else {
        await this.#startHttp(options.httpStream);
      }

      this.#serverState = ServerState.Running;
    } catch (error) {
      this.#serverState = ServerState.Error;
      throw error;
    }
  }

  public async stop(): Promise<void> {
    // Hono seals its matcher once used, so a restarted server needs a fresh
    // app; the routes are re-registered by the next `start()`.
    this.#honoApp = this.#freshApp();
    this.#corsMiddleware = null;

    for (const server of this.#connectedServers) {
      await server.close().catch(() => {});
    }
    this.#connectedServers = [];

    await this.#stdioHandle?.close?.();
    this.#stdioHandle = null;

    await this.#handler?.close();
    this.#handler = null;

    if (this.#httpServer) {
      await new Promise<void>((resolve) =>
        this.#httpServer!.close(() => resolve()),
      );
      this.#httpServer = null;
    }

    this.#serverState = ServerState.Stopped;
  }

  async #buildServer(auth: T | undefined): Promise<McpServer> {
    const server = new McpServer(
      { name: this.#options.name, version: this.#options.version },
      { instructions: this.#options.instructions },
    );

    for (const tool of this.#tools) {
      if (tool.canAccess && !tool.canAccess(auth as T)) {
        continue;
      }

      server.registerTool(
        tool.name,
        {
          _meta: tool._meta,
          annotations: tool.annotations,
          description: tool.description,
          inputSchema: (await this.#toSdkSchema(
            tool.parameters,
            `Tool "${tool.name}" parameters`,
          )) as never,
          outputSchema: (await this.#toSdkSchema(
            tool.outputSchema,
            `Tool "${tool.name}" outputSchema`,
          )) as never,
        },
        (async (args: unknown, ctx: unknown) => {
          const context = this.#makeContext(auth, ctx);

          try {
            const result = await (tool.timeoutMs
              ? withTimeout(
                  tool.execute(args, context),
                  tool.timeoutMs,
                  tool.name,
                )
              : tool.execute(args, context));
            return normalizeToolResult(result);
          } catch (error) {
            if (error instanceof UserError) {
              return {
                content: [{ text: error.message, type: "text" }],
                isError: true,
                ...(error.extras ? { structuredContent: error.extras } : {}),
              };
            }
            throw error;
          }
        }) as never,
      );
    }

    for (const resource of this.#resources) {
      if (resource.canAccess && !resource.canAccess(auth as T)) {
        continue;
      }

      server.registerResource(
        resource.name,
        resource.uri,
        {
          cacheHint: resource.cache,
          description: resource.description,
          mimeType: resource.mimeType,
        },
        (async (uri: URL, ctx: unknown) => {
          const context = this.#makeContext(auth, ctx);
          const loaded = await resource.load(context);
          const bodies = Array.isArray(loaded) ? loaded : [loaded];
          return {
            contents: bodies.map((body) => ({
              ...body,
              mimeType: body.mimeType ?? resource.mimeType,
              uri: body.uri ?? uri.toString(),
            })),
          };
        }) as never,
      );
    }

    for (const template of this.#resourceTemplates) {
      if (template.canAccess && !template.canAccess(auth as T)) {
        continue;
      }

      const complete: Record<string, (value: string) => Promise<string[]>> = {};
      for (const arg of template.arguments ?? []) {
        const completer =
          arg.complete ??
          (template.complete
            ? (value: string) => template.complete!(arg.name, value)
            : undefined);

        if (completer) {
          complete[arg.name] = async (value: string) =>
            (await completer(value)).values;
        }
      }

      server.registerResource(
        template.name,
        new SDKResourceTemplate(template.uriTemplate, {
          complete: complete as never,
          list: undefined,
        }),
        {
          cacheHint: template.cache,
          description: template.description,
          mimeType: template.mimeType,
        },
        (async (uri: URL, args: Record<string, string>, ctx: unknown) => {
          const context = this.#makeContext(auth, ctx);
          const loaded = await template.load(args ?? {}, context);
          const bodies = Array.isArray(loaded) ? loaded : [loaded];
          return {
            contents: bodies.map((body) => ({
              ...body,
              mimeType: body.mimeType ?? template.mimeType,
              uri: body.uri ?? uri.toString(),
            })),
          };
        }) as never,
      );
    }

    for (const prompt of this.#prompts) {
      if (prompt.canAccess && !prompt.canAccess(auth as T)) {
        continue;
      }

      server.registerPrompt(
        prompt.name,
        {
          argsSchema: promptArgsSchema(prompt),
          description: prompt.description,
        } as never,
        (async (args: Record<string, string>, ctx: unknown) => {
          const context = this.#makeContext(auth, ctx);
          const loaded = await prompt.load(args ?? {}, context);

          if (typeof loaded !== "string") {
            return loaded;
          }

          return {
            messages: [
              {
                content: { text: loaded, type: "text" },
                role: "user" as const,
              },
            ],
          };
        }) as never,
      );
    }

    return server;
  }

  /**
   * Builds the Hono app with the CORS shim already installed.
   *
   * Registered up front because Hono runs middleware in registration order and
   * callers add their own routes via `getApp()` before `start()` — installing
   * it later would put it behind those routes and never see a preflight.
   */
  #freshApp(): Hono {
    const app = new Hono();

    app.use("*", (c, next) =>
      this.#corsMiddleware ? this.#corsMiddleware(c, next) : next(),
    );

    return app;
  }

  /** Bridges the v2 per-request context onto ViteMCP's `Context`. */
  #makeContext(auth: T | undefined, rawCtx: unknown): Context<T> {
    const ctx = rawCtx as {
      mcpReq?: {
        _meta?: {
          "io.modelcontextprotocol/logLevel"?: string;
          progressToken?: number | string;
        };
        id?: string;
        inputResponses?: Record<string, unknown>;
        notify?: (n: unknown) => Promise<void>;
        requestState?: <T>() => T | undefined;
      };
    };
    const mcpReq = ctx?.mcpReq;

    // The spec forbids emitting `notifications/message` for a request that did
    // not opt in via `_meta`, so the level gates every call. Failures are
    // swallowed: a log line must never take down the request (or, as an
    // unhandled rejection, the process).
    const requestedLevel = mcpReq?._meta?.["io.modelcontextprotocol/logLevel"];

    const emit = (level: string, message: string, data?: SerializableValue) => {
      if (!requestedLevel) {
        return;
      }

      void mcpReq
        ?.notify?.({
          method: "notifications/message",
          params: { data: { context: data, message }, level },
        })
        ?.catch(() => {});
    };

    return {
      auth,
      elicit: (params) =>
        inputRequired.elicit({
          message: params.message,
          requestedSchema: params.requestedSchema as never,
        }),
      input: (key, schema) =>
        acceptedContent(mcpReq?.inputResponses, key, schema as never) as never,
      inputRequired: (inputRequests, requestState) =>
        inputRequired({ inputRequests, requestState }),
      inputResponses: mcpReq?.inputResponses,
      log: {
        debug: (m, d) => emit("debug", m, d),
        error: (m, d) => emit("error", m, d),
        info: (m, d) => emit("info", m, d),
        warn: (m, d) => emit("warning", m, d),
      },
      reportProgress: async (progress) => {
        const progressToken = mcpReq?._meta?.progressToken;

        // No token means the client did not ask for progress on this request;
        // emitting anyway would be an uncorrelatable notification.
        if (progressToken === undefined) {
          return;
        }

        await mcpReq?.notify?.({
          method: "notifications/progress",
          params: {
            message: progress.message,
            progress: progress.progress,
            progressToken,
            total: progress.total,
          },
        });
      },
      requestId: mcpReq?.id,
      // The SDK exposes this as an accessor; call it so callers get the value.
      requestState: mcpReq?.requestState?.<string>(),
    };
  }

  /**
   * Publishes a change event to any open `subscriptions/listen` stream. This
   * replaces the 2025-era `notifications/*_list_changed` broadcast, which had
   * no addressee on a stateless transport.
   */
  #notifyListChanged(kind: "prompts" | "resources" | "tools") {
    // Typed on purpose: an untyped cast here previously let wrong method names
    // (`toolsListChanged` vs `toolsChanged`) compile and silently no-op.
    const notifier = this.#handler?.notify;

    if (!notifier) {
      return;
    }

    if (kind === "tools") notifier.toolsChanged();
    if (kind === "prompts") notifier.promptsChanged();
    if (kind === "resources") notifier.resourcesChanged();
  }

  async #startHttp(config: {
    allowedOrigins?: string[];
    basePath?: string;
    cors?: false | Parameters<typeof cors>[0];
    enableJsonResponse?: boolean;
    endpoint?: string;
    host?: string;
    legacy?: "reject" | "stateless";
    maxBodySize?: number;
    port: number;
    sslCa?: string;
    sslCert?: string;
    sslKey?: string;
  }): Promise<void> {
    this.#handler = createMcpHandler(
      async (ctx) => {
        // `ctx.requestInfo` is the real field; a previous cast invented `req`
        // and silently handed every hook `undefined`.
        const request = ctx.requestInfo;

        const auth =
          this.#authenticate && request
            ? await this.#authenticate(request)
            : undefined;

        return this.#buildServer(auth);
      },
      {
        // Defaults to serving 2025-era clients as well, because the SDK
        // client negotiates that era unless told otherwise — rejecting it
        // would bounce most clients in the wild off a brand-new package.
        //
        // The tradeoff is real: `server/discover` advertises only 2026-07-28,
        // so a legacy request is answered without being advertised, and the
        // mandatory `Mcp-Method`/`Mcp-Name` validation applies only to modern
        // requests. Set `legacy: "reject"` for a strictly modern endpoint.
        legacy: config.legacy ?? "stateless",
        ...(config.enableJsonResponse ? { responseMode: "json" as const } : {}),
        onerror: (error) => this.#logger.error("[ViteMCP error]", error),
      },
    );

    this.#corsMiddleware = config.cors === false ? null : cors(config.cors);

    const oauth = this.#options.oauth ?? this.#options.auth?.getOAuthConfig();

    if (
      oauth?.enabled !== false &&
      (oauth?.proxy ?? oauth?.authorizationServer ?? oauth?.protectedResource)
    ) {
      this.#honoApp.route(
        "/",
        createOAuthRouter({
          authorizationServer: oauth.authorizationServer,
          basePath: config.basePath,
          endpoint: config.endpoint ?? "/mcp",
          protectedResource: oauth.protectedResource,
          proxy: oauth.proxy,
        }),
      );
    }

    const health = this.#options.health;
    if (health?.enabled !== false) {
      this.#honoApp.get(health?.path ?? "/health", (c) =>
        c.text(health?.message ?? "ok", (health?.status ?? 200) as 200),
      );
    }

    const endpoint = `${config.basePath ?? ""}${config.endpoint ?? "/mcp"}`;
    const handler = this.#handler;
    const host = config.host ?? "127.0.0.1";
    const isLoopback = ["::1", "127.0.0.1", "localhost"].includes(host);

    // Default-deny for loopback binds, which is precisely the DNS-rebinding
    // case. A server bound to a routable interface is assumed to be fronted
    // deliberately, so its origins must be configured explicitly.
    const allowedOrigins =
      config.allowedOrigins ?? (isLoopback ? localhostAllowedOrigins() : []);

    if (!config.allowedOrigins && !isLoopback) {
      this.#logger.warn(
        `[ViteMCP warning] no 'allowedOrigins' configured while bound to ${host}; browser origins will be rejected`,
      );
    }

    // The MCP endpoint is a Hono route rather than a pre-routing short-circuit,
    // so the CORS middleware registered in the constructor actually covers it.
    // Routing around Hono meant every browser preflight 405'd, which on this
    // revision blocks browsers entirely — `Mcp-Method`/`Mcp-Name` make every
    // POST preflighted.
    this.#honoApp.all(endpoint, async (c) => {
      // Transport security (MUST): a present-but-unrecognised Origin is
      // rejected with 403. This is what stops a malicious page from driving a
      // locally bound server via DNS rebinding. Requests with no Origin (i.e.
      // non-browser clients) are unaffected.
      const rejected = originValidationResponse(c.req.raw, allowedOrigins);

      if (rejected) {
        return rejected;
      }

      return handler.fetch(c.req.raw);
    });

    const app = this.#honoApp;
    const maxBodySize = config.maxBodySize ?? OAUTH_PROXY_MAX_BODY_SIZE;

    const useTls = Boolean(config.sslCert && config.sslKey);

    const requestListener = (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ) => {
      void (async () => {
        try {
          // `toWebRequest` reads the Node stream to completion, so the size
          // cap has to be applied *here* — enforcing it further in would mean
          // the whole body was already buffered, which is the DoS this guards.
          const body = await readCappedNodeBody(req, maxBodySize);

          if (body === OVERSIZE) {
            res.writeHead(400, {
              Connection: "close",
              "Content-Type": "application/json",
            });
            // Close the socket only once the 400 has actually flushed —
            // destroying it earlier truncates the response the client needs to
            // read. Pausing the request stops us draining the rest of the
            // oversize body in the meantime, which is the exhaustion this
            // guards against.
            // Discard the remainder rather than buffering it: the bytes are
            // dropped as they arrive, so nothing accumulates, and Node can
            // still complete the exchange. Pausing instead would stall the
            // response and the client would never see the 400.
            req.resume();

            // `Connection: close` alone is not enough: Node waits for the
            // declared Content-Length before closing, and an over-declared
            // body never finishes arriving. Close once the 400 has flushed.
            res.once("finish", () => {
              const socket = res.socket;
              socket?.end();
              // A client that over-declared Content-Length keeps writing, so a
              // half-close can hang. Force the teardown shortly after the FIN.
              setTimeout(() => socket?.destroy(), 50).unref();
            });
            res.end(
              JSON.stringify({
                error: "invalid_request",
                error_description: `Request body exceeds ${formatBytes(maxBodySize)}`,
              }),
            );
            return;
          }

          // Convert faithfully — method, headers and body all have to survive,
          // or custom POST routes see an empty request. The Node req/res are
          // passed as Hono's env so custom routes can still reach
          // `c.env.incoming`.
          const response = await app.fetch(
            nodeToWebRequest(req, body, useTls),
            {
              incoming: req,
              outgoing: res,
            },
          );

          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          // A body that aborts mid-stream rejects here. Settle with a 400
          // rather than leaving the exchange pending forever.
          this.#logger.debug(`[ViteMCP debug] request failed:`, error);

          if (!res.headersSent) {
            res.writeHead(400, {
              Connection: "close",
              "Content-Type": "application/json",
            });
          }

          res.end(
            JSON.stringify({
              error: "invalid_request",
              error_description: "Request body could not be read",
            }),
          );
        }
      })();
    };

    // TLS is terminated here when certs are supplied, rather than assuming a
    // proxy in front.
    this.#httpServer = useTls
      ? https.createServer(
          {
            ...(config.sslCa ? { ca: await readFile(config.sslCa) } : {}),
            cert: await readFile(config.sslCert!),
            key: await readFile(config.sslKey!),
          },
          requestListener,
        )
      : http.createServer(requestListener);

    await new Promise<void>((resolve) =>
      this.#httpServer!.listen(
        config.port,
        config.host ?? "127.0.0.1",
        resolve,
      ),
    );

    this.#logger.info(
      `[ViteMCP info] server is running on ${useTls ? "HTTPS" : "HTTP"} at ${
        useTls ? "https" : "http"
      }://${config.host ?? "127.0.0.1"}:${config.port}${endpoint}`,
    );
  }

  /**
   * Builds a fresh `McpServer` for one request. On the stateless protocol
   * there is nothing to reuse between requests, and building per-request is
   * what lets `canAccess` filter the listing by the caller's auth.
   */
  /**
   * The SDK needs a schema that can produce JSON Schema. Zod v4 does natively;
   * valibot/arktype do not, so convert those via xsschema and hand the result
   * back through `fromJsonSchema`. Throws eagerly for anything unsupported so
   * the failure surfaces at start-up, not on the first tool call.
   */
  async #toSdkSchema(schema: unknown, label: string): Promise<unknown> {
    if (!schema) {
      return undefined;
    }

    const standard = (schema as { "~standard"?: { jsonSchema?: unknown } })[
      "~standard"
    ];

    if (standard?.jsonSchema) {
      return schema;
    }

    try {
      const json = strictJsonSchema(await toJsonSchema(schema as never));
      return fromJsonSchema(json as never);
    } catch (error) {
      throw new UnexpectedStateError(
        `${label} is not a supported Standard Schema: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { label },
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Builds a web-standard Request from a Node request whose body has already
 * been consumed.
 *
 * The SDK's `toWebRequest` cannot be used here: it either re-reads the stream
 * (already drained) or JSON-stringifies a `parsedBody`, which would
 * double-encode an already-serialized body.
 */
const nodeToWebRequest = (
  req: http.IncomingMessage,
  body: Buffer,
  secure: boolean,
): Request => {
  const host = req.headers.host ?? "localhost";
  // Scheme has to follow the listener, or absolute URLs derived from
  // `c.req.url` (issuers, redirect URIs) come out as http:// under TLS.
  const url = `${secure ? "https" : "http"}://${host}${req.url ?? "/"}`;
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(":")) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else {
      headers.set(name, value);
    }
  }

  const method = (req.method ?? "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && body.byteLength > 0;

  return new Request(url, {
    headers,
    method,
    ...(hasBody ? { body } : {}),
  });
};

/**
 * Rejects if a tool has not settled within its `timeoutMs`.
 *
 * The underlying work is not cancelled — it cannot be, since `execute` owns
 * whatever it started — but the caller stops waiting and gets a clear error
 * instead of an indefinitely hung request.
 */
const withTimeout = <T>(
  work: Promise<T>,
  timeoutMs: number,
  toolName: string,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new UserError(`Tool '${toolName}' timed out after ${timeoutMs}ms`, {
          timeoutMs,
          toolName,
        }),
      );
    }, timeoutMs);

    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });

/** Renders a byte cap the way the error message should read (e.g. "1 MiB"). */
const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) {
    return `${bytes / (1024 * 1024)} MiB`;
  }

  if (bytes >= 1024 && bytes % 1024 === 0) {
    return `${bytes / 1024} KiB`;
  }

  return `${bytes} bytes`;
};

/** Sentinel returned when a request body exceeds the configured cap. */
const OVERSIZE = Symbol("oversize");

/**
 * Reads a Node request body with a hard cap, bailing out as soon as the limit
 * is crossed rather than after the fact. A declared `Content-Length` over the
 * cap short-circuits before any chunk is read.
 */
const readCappedNodeBody = async (
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer | typeof OVERSIZE> => {
  const declared = Number(req.headers["content-length"] ?? 0);

  if (declared > maxBytes) {
    return OVERSIZE;
  }

  let size = 0;
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.byteLength;

    if (size > maxBytes) {
      return OVERSIZE;
    }

    chunks.push(buf);
  }

  return Buffer.concat(chunks);
};

/**
 * Rejects schemas that do not implement Standard Schema, at registration time
 * rather than on the first request — a typo in a schema should fail at
 * start-up, not when a caller happens to invoke the tool.
 */
const assertStandardSchema = (
  schema: unknown,
  toolName: string,
  field: "outputSchema" | "parameters",
) => {
  if (schema === undefined) {
    return;
  }

  const standard = (schema as { "~standard"?: { validate?: unknown } })?.[
    "~standard"
  ];

  if (typeof standard?.validate !== "function") {
    throw new UnexpectedStateError(
      `Tool '${toolName}' ${field} must implement Standard Schema. If you are using Zod, upgrade to version 3.24 or later.`,
      { toolName },
    );
  }
};

const promptArgsSchema = <T extends ViteMCPAuth>(prompt: Prompt<T>) => {
  const args = prompt.arguments;

  if (!args?.length) {
    return undefined;
  }

  const shape: Record<string, z.ZodType> = {};
  for (const arg of args) {
    const completer =
      arg.complete ??
      (prompt.complete
        ? (value: string) => prompt.complete!(arg.name, value)
        : undefined);
    // The description has to be on the schema: the SDK derives the public
    // `prompts/list` argument list from the schema's JSON Schema, not from
    // this declaration.
    const described = arg.description
      ? z.string().describe(arg.description)
      : z.string();
    const base = completer
      ? completable(
          described,
          (async (value: string) => (await completer(value)).values) as never,
        )
      : described;
    shape[arg.name] = (arg.required ? base : base.optional()) as z.ZodType;
  }

  return z.object(shape);
};

/** Normalizes the several shapes `execute` may return into a CallToolResult. */
const normalizeToolResult = (result: unknown): unknown => {
  if (result === undefined || result === null) {
    return { content: [] };
  }

  if (typeof result === "string") {
    return { content: [{ text: result, type: "text" }] };
  }

  if (typeof result === "object") {
    const value = result as Record<string, unknown>;

    // Already an input_required (MRTR) or a full content result — pass through.
    if (value.resultType === "input_required" || Array.isArray(value.content)) {
      return value;
    }

    if (
      value.type === "text" ||
      value.type === "image" ||
      value.type === "audio" ||
      value.type === "resource" ||
      value.type === "resource_link"
    ) {
      return { content: [value] };
    }

    // Structured results also carry the serialized JSON as a text block: the
    // spec recommends it so clients that do not read `structuredContent` still
    // see something meaningful.
    return {
      content: [{ text: JSON.stringify(value), type: "text" }],
      structuredContent: value,
    };
  }

  return { content: [{ text: String(result), type: "text" }] };
};

export { delay };

/* -------------------------------------------------------------------------- */
/* Re-exports                                                                  */
/* -------------------------------------------------------------------------- */

// Convenience re-exports so the common auth surface is reachable from the
// package root; `@vitemcp/server/auth` remains the full module.
export {
  AuthProvider,
  AzureProvider,
  getAuthSession,
  GitHubProvider,
  GoogleProvider,
  OAuthProvider,
  requireAll,
  requireAny,
  requireAuth,
  requireRole,
  requireScopes,
} from "./auth/index.js";

export type {
  AuthProviderConfig,
  AzureProviderConfig,
  AzureSession,
  GenericOAuthProviderConfig,
  GitHubSession,
  GoogleSession,
  OAuthSession,
} from "./auth/index.js";

export { DiscoveryDocumentCache } from "./DiscoveryDocumentCache.js";

export {
  jsonSchemaAdapter,
  type JsonSchemaObject,
  type JsonSchemaStandardSchema,
} from "./jsonSchemaAdapter.js";
