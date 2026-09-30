import type { Context, ViteMCP, ViteMCPAuth } from "../ViteMCP.js";

/**
 * A value that may depend on the calling request — a bearer token derived from
 * `context.auth`, say, rather than one fixed when the server was built.
 *
 * ViteMCP is stateless: `execute` runs per request, so a function here is
 * called per request too and can read whatever `authenticate` produced for
 * that caller. A plain object is the right shape for a credential the process
 * owns; a function is the right shape for one the caller brought.
 */
export type ContextualHeaders<T extends ViteMCPAuth> =
  | ((
      context: Context<T>,
    ) => Promise<Record<string, string>> | Record<string, string>)
  | Record<string, string>;

export type FromOpenAPIOptions<T extends ViteMCPAuth = ViteMCPAuth> = {
  /**
   * Overrides the base URL resolved from the document's `servers`. Required
   * when the document has no `servers` entry, or has a relative one and was
   * not loaded from an http(s) URL.
   */
  baseUrl?: string;

  /** Drops operations for which this returns `true`. Applied after `include`. */
  exclude?: (operation: OperationSummary) => boolean;

  /**
   * HTTP client used to execute generated tool calls. Defaults to the global
   * `fetch`.
   */
  fetch?: typeof globalThis.fetch;

  /**
   * Headers sent with every generated call. Applied *after* the operation's
   * own header parameters, so a credential configured here always wins over a
   * value the model supplied for a same-named header parameter.
   */
  headers?: ContextualHeaders<T>;

  /** Keeps only operations for which this returns `true`. */
  include?: (operation: OperationSummary) => boolean;

  /**
   * Truncation point for a response body, in characters of decoded text.
   *
   * @default 1_000_000
   */
  maxResponseCharacters?: number;

  /**
   * Cap on the number of generated tools. Exceeding it throws rather than
   * truncating — dropping operations the caller asked for is exactly the
   * silent behaviour this is here to prevent.
   *
   * With no `include`/`exclude` and no explicit value, a default ceiling still
   * applies (see `DEFAULT_MAX_TOOLS`) so a large spec fails loudly instead of
   * emitting a tool list no client can work with.
   */
  maxTools?: number;

  /**
   * Name for a newly-created server. Ignored when `server` is given.
   *
   * @default the document's `info.title`, or "OpenAPI"
   */
  name?: string;

  /**
   * Declares each tool's `outputSchema` from the operation's 2xx JSON response
   * schema.
   *
   * Off by default, and deliberately so: MCP makes a declared output schema
   * binding, and the SDK rejects a result that does not validate against it.
   * Response schemas in real documents drift from what the API actually
   * returns, so turning this on converts that drift from a cosmetic
   * inaccuracy into a failed tool call. Turn it on when the document is known
   * to be accurate — generated from the server's own types, say.
   */
  outputSchema?: boolean;

  /**
   * Query parameters appended to every generated call — an API key that the
   * document models as a query-string credential, typically. Applied after the
   * operation's own query parameters, for the same reason as `headers`.
   */
  query?: ContextualHeaders<T>;

  /**
   * An existing server to register the generated tools onto, instead of
   * creating one.
   */
  server?: ViteMCP<T>;

  /**
   * A URL, a file path, or an already-parsed document.
   *
   * Passing a URL or path (rather than a parsed object) is what lets external
   * `$ref`s and a relative `servers[0].url` resolve: both are resolved against
   * this value.
   */
  spec: Record<string, unknown> | string;

  /** `timeoutMs` applied to every generated tool. */
  timeoutMs?: number;

  /**
   * Overrides generated tool names. A record is keyed by `operationId`; a
   * function returning `undefined` falls back to the generated name.
   */
  toolNames?:
    | ((operation: OperationSummary) => string | undefined)
    | Record<string, string>;

  /**
   * Version for a newly-created server. Ignored when `server` is given.
   *
   * @default the document's `info.version` when it is a semantic version,
   * otherwise "1.0.0"
   */
  version?: `${number}.${number}.${number}`;
};

export type HttpMethod = "delete" | "get" | "patch" | "post" | "put";

/** One operation, with everything needed to build a tool for it. */
export type HttpRoute = {
  deprecated: boolean;
  description?: string;
  method: HttpMethod;
  operationId?: string;
  parameters: OpenApiParameter[];
  path: string;
  requestBody?: OpenApiRequestBody;
  responses: Record<string, OpenApiResponse>;
  /** The nearest `servers` override (operation, then path item), if any. */
  servers?: OpenApiServer[];
  summary?: string;
  tags: string[];
};

/**
 * A minimal, hand-typed slice of an OpenAPI 3.x document — only the parts this
 * module reads. Deliberately not the full `openapi-types` shape, so that
 * typing alone does not add a dependency.
 */
export type OpenApiDocument = {
  components?: {
    /** Reachable through a `$ref` on an operation; see `routes.ts`. */
    parameters?: Record<string, OpenApiParameter>;
    /** OpenAPI 3.1. Reachable through a `$ref` on a path; see `routes.ts`. */
    pathItems?: Record<string, OpenApiPathItem>;
    schemas?: Record<string, OpenApiSchema>;
  };
  info?: {
    description?: string;
    title?: string;
    version?: string;
  };
  openapi?: string;
  paths?: Record<string, OpenApiPathItem>;
  servers?: OpenApiServer[];
  swagger?: string;
};

export type OpenApiParameter = {
  deprecated?: boolean;
  description?: string;
  explode?: boolean;
  in: ParameterLocation;
  name: string;
  required?: boolean;
  schema?: OpenApiSchema;
  style?: string;
};

/**
 * A path's operations, or a `$ref` to another path item that carries them —
 * with whatever is written beside the reference taking its place.
 */
export type OpenApiPathItem = {
  $ref?: string;
  parameters?: (OpenApiParameter | OpenApiRef)[];
  servers?: OpenApiServer[];
} & Partial<Record<HttpMethod, OpenApiOperation>>;

export type OpenApiRef = { $ref: string };

export type OpenApiRequestBody = {
  content?: Record<string, OpenApiMediaType>;
  required?: boolean;
};

export type OpenApiResponse = {
  content?: Record<string, OpenApiMediaType>;
};

/**
 * A raw schema fragment as it appears in the document. Unlike
 * `JsonSchemaObject` (jsonSchemaAdapter.ts) it is not required to carry a
 * top-level `type`: a bare `$ref`, `allOf`, or enum-only node is valid JSON
 * Schema and appears constantly in real documents. Only the assembled per-tool
 * schema has to satisfy `JsonSchemaObject`.
 */
export type OpenApiSchema = Record<string, unknown>;

export type OpenApiServer = {
  url: string;
  variables?: Record<string, { default: string }>;
};

/** The slice of an operation exposed to `include`/`exclude`/`toolNames`. */
export type OperationSummary = {
  deprecated: boolean;
  description?: string;
  method: HttpMethod;
  operationId?: string;
  path: string;
  summary?: string;
  tags: string[];
};

type OpenApiMediaType = { schema?: OpenApiSchema };

type OpenApiOperation = {
  deprecated?: boolean;
  description?: string;
  operationId?: string;
  parameters?: (OpenApiParameter | OpenApiRef)[];
  requestBody?: OpenApiRef | OpenApiRequestBody;
  responses?: Record<string, OpenApiRef | OpenApiResponse>;
  servers?: OpenApiServer[];
  summary?: string;
  tags?: string[];
};

type ParameterLocation = "cookie" | "header" | "path" | "query";
