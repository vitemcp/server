import type {
  AudioContent,
  Context,
  ImageContent,
  StructuredResult,
  ViteMCPAuth,
} from "../ViteMCP.js";
import type { ToolBinding } from "./schemas.js";
import type { ContextualHeaders, HttpRoute, OpenApiServer } from "./types.js";

import { UserError } from "../ViteMCP.js";
import {
  appendQueryParameter,
  serializePathParameter,
  serializeSimpleParameter,
  toQueryString,
} from "./parameters.js";

export type ExecuteRequestOptions<T extends ViteMCPAuth> = {
  args: Record<string, unknown>;
  baseUrl: string;
  binding: ToolBinding;
  context: Context<T>;
  fetchImpl: typeof globalThis.fetch;
  headers?: ContextualHeaders<T>;
  maxResponseCharacters: number;
  query?: ContextualHeaders<T>;
  route: HttpRoute;
};

export type ExecuteRequestResult =
  | AudioContent
  | ImageContent
  | string
  | StructuredResult<Record<string, unknown>>;

/** Bodies over this are never treated as inline media, whatever the type. */
const MAX_INLINE_MEDIA_BYTES = 8 * 1024 * 1024;

export const executeRequest = async <T extends ViteMCPAuth>(
  options: ExecuteRequestOptions<T>,
): Promise<ExecuteRequestResult> => {
  const { args, binding, context, route } = options;

  const pathValues = new Map<string, string>();
  const query = new URLSearchParams();
  const cookies: string[] = [];
  // `Headers` rather than an object, so that a header the operation names
  // `Content-Type` and one this function sets as `content-type` are recognised
  // as the same header instead of being sent twice.
  const headers = new Headers();
  const bodyValues: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    const binder = binding.parameters[key];

    if (!binder || value === undefined) {
      continue;
    }

    if (binder.kind === "body") {
      bodyValues[binder.name] = value;
      continue;
    }

    const { parameter } = binder;

    switch (parameter.in) {
      case "cookie":
        cookies.push(
          `${parameter.name}=${encodeCookieValue(
            serializeSimpleParameter(parameter, value),
          )}`,
        );
        break;
      case "header":
        setHeader(
          headers,
          parameter.name,
          serializeSimpleParameter(parameter, value),
        );
        break;
      case "path":
        pathValues.set(
          parameter.name,
          serializePathParameter(parameter, value),
        );
        break;
      case "query":
        appendQueryParameter(query, parameter, value);
        break;
    }
  }

  for (const [name, value] of Object.entries(
    await resolve(options.query, context),
  )) {
    query.delete(name);
    query.append(name, value);
  }

  if (cookies.length > 0) {
    setHeader(headers, "cookie", cookies.join("; "));
  }

  const body = buildBody(binding, bodyValues, headers);

  // Applied last on purpose. These are the credentials the server was
  // configured with, and an operation that happens to declare a header or
  // query parameter of the same name must not let a model-supplied argument
  // replace them.
  for (const [name, value] of Object.entries(
    await resolve(options.headers, context),
  )) {
    setHeader(headers, name, value);
  }

  const url = new URL(buildPath(route, pathValues), `${options.baseUrl}/`);
  url.search = toQueryString(query);

  const response = await options.fetchImpl(url, {
    body,
    headers,
    method: route.method.toUpperCase(),
    // Forwarded so an abandoned tool call stops the upstream request too,
    // rather than leaving it running behind a settled promise.
    signal: context.signal,
  });

  return await readResponse(response, options);
};

/**
 * Resolves the address to send to: an explicit override, else the nearest
 * `servers` entry, with a relative URL joined against wherever the document
 * itself was loaded from.
 *
 * That last part is what makes documents like Swagger's own Petstore work —
 * its `servers` is `[{ url: "/api/v3" }]`, which a validator accepts and an
 * HTTP client cannot use.
 */
export const resolveBaseUrl = (
  servers: OpenApiServer[] | undefined,
  origin: string | undefined,
  override: string | undefined,
): string => {
  if (override) {
    return trimSlash(override);
  }

  const server = servers?.[0];

  if (!server?.url) {
    throw new Error(
      "The OpenAPI document declares no `servers`, so there is no address to call. Pass `baseUrl` to fromOpenAPI().",
    );
  }

  let url = server.url;

  for (const [name, variable] of Object.entries(server.variables ?? {})) {
    url = url.replaceAll(`{${name}}`, variable.default);
  }

  try {
    return trimSlash(new URL(url).toString());
  } catch {
    if (!origin) {
      throw new Error(
        `The OpenAPI document's server URL ("${url}") is relative, and the document was not loaded from an http(s) URL, so there is nothing to resolve it against. Pass \`baseUrl\` to fromOpenAPI().`,
      );
    }

    return trimSlash(new URL(url, origin).toString());
  }
};

/**
 * Appends one form-encoded body property, bracketing anything nested.
 *
 * OpenAPI's `style`/`explode` pair only describes flat values, so a nested
 * object has no encoding the specification defines. Sending it as one JSON
 * string is the reading a server never expects: it wants fields. The bracket
 * convention — `metadata[order]=42`, as popularised by Stripe — is what the
 * APIs accepting nested form bodies actually parse, so it is what a nested
 * value serializes to here.
 */
const appendFormValue = (
  form: URLSearchParams,
  name: string,
  value: unknown,
): void => {
  if (value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    // A flat array keeps OpenAPI's `explode: true` default and repeats the
    // key. Indices appear only once an entry is itself nested, where repeating
    // the key would run every entry's fields together into one.
    const nested = value.some(
      (entry) => typeof entry === "object" && entry !== null,
    );

    for (const [index, entry] of value.entries()) {
      appendFormValue(form, nested ? `${name}[${index}]` : name, entry);
    }

    return;
  }

  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      appendFormValue(form, `${name}[${key}]`, entry);
    }

    return;
  }

  form.append(name, String(value));
};

const buildBody = (
  binding: ToolBinding,
  values: Record<string, unknown>,
  headers: Headers,
): string | undefined => {
  const encoding = binding.bodyEncoding;

  // A JSON body the operation requires is sent as `{}` when no argument went
  // into it: every property in it may be optional, but the body itself is
  // not, and a server that requires one refuses a request that has none.
  const sendEmpty = encoding?.kind === "json" && binding.bodyRequired;

  if (!encoding || (Object.keys(values).length === 0 && !sendEmpty)) {
    return undefined;
  }

  const payload = binding.wholeBodyKey ? values[binding.wholeBodyKey] : values;

  if (payload === undefined) {
    return undefined;
  }

  if (!headers.has("content-type")) {
    headers.set("content-type", encoding.contentType);
  }

  if (encoding.kind === "text") {
    return typeof payload === "string" ? payload : JSON.stringify(payload);
  }

  if (encoding.kind === "form") {
    if (!isRecord(payload)) {
      return typeof payload === "string" ? payload : JSON.stringify(payload);
    }

    const form = new URLSearchParams();

    for (const [name, value] of Object.entries(payload)) {
      appendFormValue(form, name, value);
    }

    return form.toString();
  }

  return JSON.stringify(payload);
};

/**
 * Substitutes path parameters. Leading slash removed so the result is a
 * relative reference: resolved against a base of `https://host/api/v3/`, a
 * leading slash would discard the `/api/v3` prefix the document asked for.
 *
 * A placeholder nothing fills is refused rather than sent: the request would
 * go to a literal `%7Bid%7D` and could still come back 2xx. That happens when
 * the document names a placeholder it declares no path parameter for, which
 * leaves the tool no argument to fill it with.
 *
 * So is a value that leaves a whole segment `.` or `..`. A URL resolves those
 * as steps through the path instead of sending them: `/users/{id}/profile`
 * with `id: ".."` would request `/profile`, and a `..` at the front would climb
 * out of the `/api/v3` prefix too. Encoding cannot prevent it, since
 * `encodeURIComponent` leaves dots alone and a URL reads `%2e` as a dot
 * anyway. A dot segment the document writes into the path itself is left
 * alone.
 */
const buildPath = (route: HttpRoute, values: Map<string, string>): string => {
  const unfilled = [...route.path.matchAll(/\{([^{}]*)\}/g)]
    .filter(([, name]) => !values.has(name))
    .map(([placeholder]) => placeholder);

  if (unfilled.length > 0) {
    throw new UserError(
      `${route.method.toUpperCase()} ${route.path} cannot be called: the OpenAPI document declares no path parameter for ${unfilled.join(", ")}.`,
    );
  }

  let path = route.path;

  for (const [name, value] of values) {
    path = path.replaceAll(`{${name}}`, value);
  }

  const written = new Set(route.path.split("/").filter(isDotSegment));
  const introduced = path
    .split("/")
    .find((segment) => isDotSegment(segment) && !written.has(segment));

  if (introduced !== undefined) {
    throw new UserError(
      `${route.method.toUpperCase()} ${route.path} cannot be called with a path segment of "${introduced}": a URL resolves it as a step through the path, so the request would reach a different endpoint.`,
    );
  }

  return path.replace(/^\//, "");
};

const resolve = async <T extends ViteMCPAuth>(
  source: ContextualHeaders<T> | undefined,
  context: Context<T>,
): Promise<Record<string, string>> => {
  if (!source) {
    return {};
  }

  return typeof source === "function" ? await source(context) : source;
};

const readResponse = async <T extends ViteMCPAuth>(
  response: Response,
  options: ExecuteRequestOptions<T>,
): Promise<ExecuteRequestResult> => {
  const { binding, maxResponseCharacters, route } = options;
  const contentType = response.headers.get("content-type") ?? "";
  // Without its parameters, so `text/plain; profile=json` is not taken for
  // JSON, and lowercased, since media types are case-insensitive: an API that
  // answers `Application/JSON` has still answered JSON.
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  const label = `${route.method.toUpperCase()} ${route.path}`;

  if (!response.ok) {
    throw new UserError(
      `${label} failed with ${response.status} ${response.statusText}: ${truncate(
        await response.text(),
        2000,
      )}`,
    );
  }

  if (/^(?:audio|image)\//.test(mediaType) && !binding.outputSchema) {
    const bytes = new Uint8Array(await response.arrayBuffer());

    if (bytes.byteLength <= MAX_INLINE_MEDIA_BYTES) {
      return mediaType.startsWith("image/")
        ? { data: toBase64(bytes), mimeType: mediaType, type: "image" }
        : { data: toBase64(bytes), mimeType: mediaType, type: "audio" };
    }

    throw new UserError(
      `${label} returned ${bytes.byteLength} bytes of ${contentType}, too large to return inline.`,
    );
  }

  const text = await response.text();
  const parsed = /\bjson\b/.test(mediaType)
    ? tryParse(text.length <= maxResponseCharacters ? text : undefined)
    : undefined;

  // A JSON object goes back as structured content, which ViteMCP mirrors as
  // JSON text for clients that ignore it — so nothing is lost, and clients
  // that read it get a value instead of a string to re-parse.
  if (isRecord(parsed)) {
    return { structuredContent: parsed };
  }

  if (binding.outputSchema) {
    throw new UserError(
      `${label} declares a JSON object response but returned ${
        contentType || "an untyped body"
      }. Set \`outputSchema: false\` if this document's response schemas do not match the API.`,
    );
  }

  if (text === "") {
    return `${response.status} ${response.statusText}`.trim();
  }

  return parsed === undefined
    ? truncate(text, maxResponseCharacters)
    : truncate(JSON.stringify(parsed, null, 2), maxResponseCharacters);
};

/**
 * Escapes the characters RFC 6265 forbids in a cookie value, so an argument
 * containing `;` sets one cookie with a peculiar value rather than two
 * cookies. Everything else is left alone — `=` in particular, since base64
 * cookie values end in it.
 */
const encodeCookieValue = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  value.replace(/[\u0000-\u001F\u007F ",;\\]/g, (character) =>
    encodeURIComponent(character),
  );

/** `.` or `..`, or a `%2e` spelling of either, which a URL reads the same. */
const isDotSegment = (segment: string): boolean =>
  /^(?:\.|%2e){1,2}$/i.test(segment);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `Headers` rejects a value containing a newline, which is the whole reason a
 * header parameter cannot be used to smuggle extra headers. Rethrown as a
 * `UserError` so a model that supplied one gets told what to fix instead of
 * the call failing as an internal error.
 */
const setHeader = (headers: Headers, name: string, value: string): void => {
  try {
    headers.set(name, value);
  } catch {
    throw new UserError(
      `"${name}" is not a valid header name, or the value given for it is not a valid header value.`,
    );
  }
};

const toBase64 = (bytes: Uint8Array): string => {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
};

const trimSlash = (value: string): string => value.replace(/\/+$/, "");

const truncate = (text: string, limit: number): string =>
  text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n\n[truncated after ${limit} characters]`;

const tryParse = (text: string | undefined): unknown => {
  if (text === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
