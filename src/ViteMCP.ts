import {
  acceptedContent,
  bearerAuthChallengeResponse,
  type CacheScope,
  completable,
  createMcpHandler,
  fromJsonSchema,
  getOAuthProtectedResourceMetadataUrl,
  type InputRequest,
  inputRequired,
  type InputRequiredResult,
  localhostAllowedOrigins,
  type McpHttpHandler,
  McpServer,
  OAuthError,
  OAuthErrorCode,
  originValidationResponse,
  ResourceTemplate as SDKResourceTemplate,
  type ToolAnnotations as SDKToolAnnotations,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import { StandardSchemaV1 } from "@standard-schema/spec";
import { AsyncLocalStorage } from "async_hooks";
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

export type MediaSource = { timeoutMs?: number } & (
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
 * Per-request authentication hook for the HTTP transport.
 *
 * Resolve with the session to attach to `context.auth`. Resolving with `null`
 * or `undefined` **refuses** the request — the transport answers 401 and no
 * handler runs — because a hook that cannot identify the caller has not
 * authenticated them. Set `allowAnonymous` to have a nullish result mean
 * "anonymous caller" instead, for servers that deliberately mix public and
 * protected primitives.
 *
 * Throw a `Response` to refuse with an exact status and body of your choosing;
 * it is returned to the client verbatim.
 */
export type Authenticate<T> = (
  request: Request,
) => Promise<null | T | undefined>;

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
 * Context handed to `execute` / `load`. Everything here is per-request: the
 * 2026-07-28 revision has no protocol session.
 */
export type Context<T extends ViteMCPAuth> = {
  /** Authentication result for this request, if an `authenticate` hook ran. */
  auth: T | undefined;

  /**
   * Builds an elicitation request for {@link Context.inputRequired}.
   *
   * A builder, not a promise — the server cannot block waiting for a reply.
   * The client re-issues the whole request with `inputResponses` populated.
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
   * Ask the client for more input and end this round.
   *
   * `requestState` round-trips through the client, so it is
   * attacker-controlled on return: sign it if it affects authorization.
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

export type LoadContext<T extends ViteMCPAuth> = Omit<
  Context<T>,
  "reportProgress"
>;

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

export type Progress = {
  message?: string;
  progress: number;
  total?: number;
};

export type Prompt<T extends ViteMCPAuth> = {
  arguments?: PromptArgument[];
  canAccess?: (auth: T | undefined) => boolean;
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
  /** Constrains the argument to a fixed set of values. */
  enum?: string[];
  name: string;
  required?: boolean;
};

export type Resource<T extends ViteMCPAuth> = {
  cache?: CacheHint;
  canAccess?: (auth: T | undefined) => boolean;
  description?: string;
  load: (context: LoadContext<T>) => Promise<LoadedResource | LoadedResource[]>;
  mimeType?: string;
  name: string;
  uri: string;
};

export type ResourceContent = {
  resource: {
    blob?: string;
    mimeType?: string;
    text?: string;
    uri: string;
  };
  type: "resource";
};

export type ResourceLink = {
  description?: string;
  mimeType?: string;
  name: string;
  type: "resource_link";
  uri: string;
};

export type ResourceTemplate<T extends ViteMCPAuth> = {
  arguments?: ResourceTemplateArgument[];
  cache?: CacheHint;
  canAccess?: (auth: T | undefined) => boolean;
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

export type SerializableValue =
  | { [key: string]: SerializableValue }
  | Literal
  | SerializableValue[];

export type ServerOptions<T extends ViteMCPAuth> = {
  /**
   * Serve requests whose `authenticate` hook resolved with `null`/`undefined`
   * as anonymous — `context.auth` is `undefined` and `canAccess` is the only
   * gate — instead of refusing them with a 401.
   *
   * Off by default: a server that configures authentication and then answers
   * callers it could not identify exposes every tool, resource and prompt that
   * has no `canAccess` guard. Turn it on only for a server that is genuinely
   * public in part, and guard the rest with `canAccess`.
   */
  allowAnonymous?: boolean;
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

/**
 * The structured payload on its own, without the content fallback.
 *
 * Returning this is how a tool states outright that an object is its structured
 * result, for the cases where the shape alone cannot say so — a payload whose
 * own `content` field is an array reads as a list of content blocks otherwise.
 * ViteMCP writes the JSON text fallback, exactly as it does for a plain
 * structured return.
 */
export type StructuredResult<T = unknown> = {
  _meta?: Record<string, unknown>;
  isError?: boolean;
  structuredContent: T;
};

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
  canAccess?: (auth: T | undefined) => boolean;
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
    | StructuredResult<StandardSchemaV1.InferOutput<OutputParams>>
    | TextContent
    | void
  >;
  name: string;
  outputSchema?: OutputParams;
  parameters?: Params;
  timeoutMs?: number;
};

export type ToolParameters = StandardSchemaV1;

export type ViteMCPAuth = Record<string, unknown> | undefined;

type Literal = boolean | null | number | string | undefined;

export class ViteMCP<T extends ViteMCPAuth = ViteMCPAuth> {
  /**
   * The `auth` provider this server was constructed with, or `undefined` when
   * OAuth was configured through the `oauth` option instead (or not at all).
   *
   * Exposed so a caller who inlined the provider into the options — the way
   * every example does — can still reach it at shutdown. The provider holds an
   * `OAuthProxy` with two cleanup timers, and `stop()` deliberately leaves them
   * running: the server does not own the provider, and a stopped server can be
   * started again. Terminal teardown is therefore the caller's call:
   *
   * ```ts
   * await server.stop();
   * server.authProvider?.destroy();
   * ```
   *
   * In that order — `destroy()` is terminal, and a request still draining would
   * throw against a destroyed provider.
   */
  public get authProvider():
    | AuthProvider<T extends OAuthSession ? T : OAuthSession>
    | undefined {
    return this.#options.auth;
  }

  /**
   * The port the HTTP server is actually listening on, or `null` when it is
   * not running over HTTP. Pass `httpStream.port: 0` to let the OS assign a
   * free port and read it back here — this avoids the race inherent in
   * picking a port first and binding it afterwards.
   */
  public get port(): null | number {
    const address = this.#httpServer?.address();
    return address && typeof address === "object" ? address.port : null;
  }

  public get serverState(): ServerState {
    return this.#serverState;
  }
  #authenticate: Authenticate<T> | undefined;
  /**
   * Carries the `authenticate` result from the HTTP route into the per-request
   * server factory. The SDK invokes that factory from within `handler.fetch`,
   * so the running store is always the one this request established — whereas
   * a field on `this` would be shared by every concurrent request.
   */
  #authStore = new AsyncLocalStorage<{ auth: T | undefined }>();
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
  /**
   * Whether this server publishes an RFC 9728 protected-resource document, and
   * so whether a 401 can point a client at it. Latched when the routes are
   * mounted rather than read back from `auth` per rejection: the provider's
   * config getter builds its proxy on demand and refuses once destroyed.
   */
  #servesProtectedResourceMetadata = false;
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

  public addTool<
    Params extends ToolParameters,
    OutputParams extends ToolParameters = ToolParameters,
  >(tool: Tool<T, Params, OutputParams>) {
    assertStandardSchema(tool.parameters, tool.name, "parameters");
    assertStandardSchema(tool.outputSchema, tool.name, "outputSchema");
    this.#tools.push(tool as unknown as Tool<T>);
    this.#notifyListChanged("tools");
  }

  public addTools<
    Params extends ToolParameters,
    OutputParams extends ToolParameters = ToolParameters,
  >(tools: Tool<T, Params, OutputParams>[]) {
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

      if (!first) {
        throw new UnexpectedStateError(`Resource loaded no content: ${uri}`, {
          uri,
        });
      }

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

      if (!first) {
        throw new UnexpectedStateError(
          `Resource template loaded no content: ${uri}`,
          { uri },
        );
      }

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
             * Whether to also serve 2025-era clients. Defaults to
             * `"stateless"`: the SDK client negotiates 2025 unless given
             * `versionNegotiation: { mode: "auto" }`. `"reject"` serves only
             * 2026-07-28 and enforces `Mcp-Method`/`Mcp-Name`.
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

  /**
   * Runs the `authenticate` hook and decides whether the exchange may proceed,
   * returning either the store to run it under or the `Response` refusing it.
   *
   * Deliberately *not* done inside the per-request server factory: that
   * factory's only return channel is an `McpServer`, so a refusal raised there
   * is indistinguishable from a crash and reaches the client as a 500 with no
   * `WWW-Authenticate` — the one header that tells an MCP client where to log
   * in. Doing it here also covers the legacy fallback, which shares the same
   * route, so no transport can be reached without passing this.
   */
  async #authenticateRequest(
    request: Request,
  ): Promise<{ auth: T | undefined } | Response> {
    if (!this.#authenticate) {
      return { auth: undefined };
    }

    let auth: null | T | undefined;

    try {
      auth = await this.#authenticate(request);
    } catch (error) {
      // A hook may throw the exact response it wants sent — the documented way
      // to refuse with a specific status, body or challenge.
      if (error instanceof Response) {
        return error;
      }

      // Anything else is a fault in the hook. Fail closed: a hook that threw
      // did not authorise anyone, so this must never fall through to the
      // handler. Reported here because the throw no longer reaches the SDK's
      // `onerror`, which used to be what logged it.
      this.#logger.error("[ViteMCP error]", error);

      return bearerAuthChallengeResponse(
        new OAuthError(OAuthErrorCode.ServerError, "Internal Server Error"),
      );
    }

    // A falsy result means the hook could not identify the caller, which is a
    // refusal and not an anonymous session: `AuthProvider.authenticate`
    // returns `undefined` for a missing, malformed or revoked bearer token.
    // Serving those requests anyway would hand every primitive that has no
    // `canAccess` guard to callers who presented no credentials at all.
    // Tested for falsiness rather than nullishness because a session is always
    // an object here, so nothing legitimate is caught — but an untyped hook
    // returning `false` is caught, and it plainly means "no".
    if (!auth) {
      return this.#options.allowAnonymous
        ? { auth: undefined }
        : this.#unauthorized(request);
    }

    return { auth };
  }

  async #buildServer(auth: T | undefined): Promise<McpServer> {
    const server = new McpServer(
      { name: this.#options.name, version: this.#options.version },
      { instructions: this.#options.instructions },
    );

    for (const tool of this.#tools) {
      if (tool.canAccess && !tool.canAccess(auth)) {
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
            return normalizeToolResult(result, tool.outputSchema !== undefined);
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
      if (resource.canAccess && !resource.canAccess(auth)) {
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
      if (template.canAccess && !template.canAccess(auth)) {
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
      if (prompt.canAccess && !prompt.canAccess(auth)) {
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

  /** Builds the Hono app with the CORS shim installed ahead of user routes. */
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

    // The spec forbids `notifications/message` for a request that did not opt
    // in via `_meta`. Failures are swallowed: a log line must never take down
    // the request.
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
    // Typed on purpose: a cast here once let wrong method names no-op.
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
      // Authentication has already run in the route below, which is the only
      // place that can turn a refusal into an HTTP status. What reaches here
      // is either an authenticated session or a deliberately anonymous one.
      async () => this.#buildServer(this.#authStore.getStore()?.auth),
      {
        // Tradeoff: `server/discover` advertises only 2026-07-28, so legacy
        // requests are answered unadvertised and skip Mcp-* validation.
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

      this.#servesProtectedResourceMetadata = Boolean(oauth.protectedResource);
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

    // Default-deny on loopback (the DNS-rebinding case); a routable bind is
    // assumed deliberate and must configure its own origins.
    const allowedOrigins =
      config.allowedOrigins ?? (isLoopback ? localhostAllowedOrigins() : []);

    if (!config.allowedOrigins && !isLoopback) {
      this.#logger.warn(
        `[ViteMCP warning] no 'allowedOrigins' configured while bound to ${host}; browser origins will be rejected`,
      );
    }

    // A Hono route, not a pre-routing short-circuit, so CORS covers it.
    // Routing around Hono 405'd every preflight — and this revision makes
    // every POST preflighted via `Mcp-Method`/`Mcp-Name`.
    this.#honoApp.all(endpoint, async (c) => {
      // Transport security (MUST): a present-but-unrecognised Origin is 403.
      // Stops DNS rebinding; requests with no Origin are unaffected.
      const rejected = originValidationResponse(c.req.raw, allowedOrigins);

      if (rejected) {
        return rejected;
      }

      const authenticated = await this.#authenticateRequest(c.req.raw);

      if (authenticated instanceof Response) {
        return authenticated;
      }

      return this.#authStore.run(authenticated, () => handler.fetch(c.req.raw));
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
          // The cap must apply before conversion: reading first and
          // measuring after is the DoS this guards against.
          const body = await readCappedNodeBody(req, maxBodySize);

          if (body === OVERSIZE) {
            res.writeHead(400, {
              Connection: "close",
              "Content-Type": "application/json",
            });
            // Drain rather than pause (pausing stalls the response), then
            // half-close once the 400 has flushed. A forced destroy would RST
            // while the client is still writing and discard the response.
            req.resume();
            res.once("finish", () => res.socket?.end());
            res.end(
              JSON.stringify({
                error: "invalid_request",
                error_description: `Request body exceeds ${formatBytes(maxBodySize)}`,
              }),
            );
            return;
          }

          // Node req/res go through as Hono's env so custom routes can still
          // reach `c.env.incoming`.
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
      }://${config.host ?? "127.0.0.1"}:${this.port ?? config.port}${endpoint}`,
    );
  }

  /**
   * Converts a schema the SDK cannot consume directly. Zod v4 emits JSON
   * Schema natively; valibot/arktype go via xsschema.
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

  /**
   * The RFC 6750 §3 challenge sent when `authenticate` refuses a request.
   *
   * `resource_metadata` (RFC 9728 §5.1) is the parameter that turns a bare
   * rejection into a login: it points the client at this server's
   * protected-resource document, from which it discovers the authorization
   * server and starts the flow. It is derived from the URL the request
   * arrived on, which is exactly where `createOAuthRouter` mounts that
   * document, and is omitted when this server publishes no such document.
   */
  #unauthorized(request: Request): Response {
    return bearerAuthChallengeResponse(
      new OAuthError(OAuthErrorCode.InvalidToken, "Authentication required"),
      this.#servesProtectedResourceMetadata
        ? {
            resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(
              new URL(request.url),
            ),
          }
        : {},
    );
  }
}

/**
 * Builds a web-standard Request from a Node request whose body is already
 * consumed. The SDK's `toWebRequest` would either re-read the drained stream
 * or JSON-stringify the body a second time.
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
 * Rejects if a tool outruns its `timeoutMs`. The work itself is not cancelled
 * — `execute` owns whatever it started — but the caller stops waiting.
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

/** Rejects non-Standard-Schema at registration, not on first call. */
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
    // On the schema, not here: the SDK derives `prompts/list` arguments from
    // the schema's JSON Schema.
    const valueSchema = arg.enum?.length
      ? z.enum(arg.enum as [string, ...string[]])
      : z.string();
    const described = arg.description
      ? valueSchema.describe(arg.description)
      : valueSchema;
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

/** The `StructuredResult` wrapper and nothing else — see `normalizeToolResult`. */
const isStructuredResult = (
  value: Record<string, unknown>,
): value is StructuredResult => {
  // Own properties only: an inherited `structuredContent` — a getter on a model
  // or ORM prototype, say — is not a nomination.
  if (
    !Object.hasOwn(value, "structuredContent") ||
    value.structuredContent === undefined
  ) {
    return false;
  }

  // The companions are copied into the result envelope as they stand, so a
  // wrongly typed one would put an unserializable value on the wire and fail
  // the call itself. Declining the wrapper leaves the whole object to be read
  // as a payload, which costs a tool error at worst.
  if (value.isError !== undefined && typeof value.isError !== "boolean") {
    return false;
  }

  if (
    value._meta !== undefined &&
    (typeof value._meta !== "object" ||
      value._meta === null ||
      Array.isArray(value._meta))
  ) {
    return false;
  }

  // A key with no value cannot be what makes this a payload rather than a
  // wrapper — it never reaches the wire either way, so `{ structuredContent,
  // trace: debug ? id : undefined }` is still a wrapper.
  return Object.keys(value).every(
    (key) =>
      key === "structuredContent" ||
      key === "isError" ||
      key === "_meta" ||
      value[key] === undefined,
  );
};

/**
 * Normalizes the several shapes `execute` may return into a CallToolResult.
 *
 * Most of these shapes are told apart by inspecting the returned value, which
 * is a guess: a structured payload is an arbitrary object and can carry the
 * same keys the shorthands are recognized by. `hasOutputSchema` narrows that
 * guess — a tool that declared an output schema returns its structured payload
 * directly — and `structuredContent` settles what remains, since the one
 * genuinely ambiguous shape cannot be resolved by inspection at all.
 */
const normalizeToolResult = (
  result: unknown,
  hasOutputSchema: boolean,
): unknown => {
  if (result === undefined || result === null) {
    return { content: [] };
  }

  if (typeof result === "string") {
    return { content: [{ text: result, type: "text" }] };
  }

  if (typeof result === "object") {
    const value = result as Record<string, unknown>;

    // Already an input_required (MRTR) or a full content result — pass through.
    //
    // A structured payload with its own array-valued `content` field is
    // indistinguishable from content blocks here, and loses: inspecting the
    // elements would only move the guess, and an empty array carries nothing to
    // inspect. Such a tool returns `{ structuredContent }` instead.
    if (value.resultType === "input_required" || Array.isArray(value.content)) {
      return value;
    }

    // Stated outright, so no guessing: the payload is whatever `execute`
    // nominated, and the fallback below is written for it as usual. Passing the
    // value through unread would nest it under a second `structuredContent`.
    //
    // Only the bare wrapper counts. Anything carrying keys of its own is a
    // payload that happens to have a `structuredContent` field, and unwrapping
    // it would both drop those keys and put them on the wire, where a field
    // `execute` meant for itself does not belong.
    if (isStructuredResult(value)) {
      return {
        content: [
          {
            // `undefined` is excluded already; this covers what else JSON
            // declines to represent, so a broken payload stays a tool error
            // rather than an unserializable content block.
            text: JSON.stringify(value.structuredContent) ?? "null",
            type: "text",
          },
        ],
        structuredContent: value.structuredContent,
        ...(value.isError === undefined ? {} : { isError: value.isError }),
        ...(value._meta === undefined ? {} : { _meta: value._meta }),
      };
    }

    // The single-content-block shorthand, off once an output schema is declared:
    // a structured payload discriminated on `type` is the ordinary way to write
    // a union, and reading one as a content block would drop the payload the
    // schema promised. Such a tool cannot be after the shorthand anyway — a
    // declared schema makes `structuredContent` mandatory.
    if (
      !hasOutputSchema &&
      (value.type === "text" ||
        value.type === "image" ||
        value.type === "audio" ||
        value.type === "resource" ||
        value.type === "resource_link")
    ) {
      return { content: [value] };
    }

    // Also carry serialized JSON as text, for clients that ignore
    // `structuredContent`.
    return {
      content: [{ text: JSON.stringify(value), type: "text" }],
      structuredContent: value,
    };
  }

  return { content: [{ text: String(result), type: "text" }] };
};

export { delay };

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

// `ServerOptions.oauth.proxy` is typed as this, so it must be nameable here.
export { OAuthProxy, OAuthProxyError } from "./auth/OAuthProxy.js";

export { DiscoveryDocumentCache } from "./DiscoveryDocumentCache.js";

export {
  jsonSchemaAdapter,
  type JsonSchemaObject,
  type JsonSchemaStandardSchema,
} from "./jsonSchemaAdapter.js";

// Re-exported because they appear in this package's public signatures and
// `@modelcontextprotocol/server` is only a transitive dependency for consumers.
export type {
  CacheScope,
  InputRequest,
  InputRequiredResult,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
