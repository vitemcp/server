# OpenAPI

`fromOpenAPI()` turns an OpenAPI 3.x document into a ViteMCP server, one tool
per operation. Parameters and the request body are flattened into a single
argument list, `$ref`s are resolved, and each tool calls the real API when
invoked.

This is the complete reference. For the abbreviated version, see
[Generating a server from OpenAPI](../README.md#generating-a-server-from-openapi)
in the README.

## Contents

- [Quick start](#quick-start)
- [Installing the bundler](#installing-the-bundler)
- [Choosing operations](#choosing-operations)
- [Authentication](#authentication)
- [How an operation becomes a tool](#how-an-operation-becomes-a-tool)
- [Arguments](#arguments)
- [Responses](#responses)
- [The base URL](#the-base-url)
- [Options](#options)
- [Limits](#limits)
- [Testing](#testing)

## Quick start

```typescript
import { fromOpenAPI } from "@vitemcp/server/openapi";

const server = await fromOpenAPI({
  include: (operation) => operation.tags.includes("pet"),
  spec: "https://petstore3.swagger.io/api/v3/openapi.json",
});

await server.start({ transportType: "stdio" });
```

`spec` takes a URL, a file path, inline JSON text, or an already-parsed object.
Pass a URL or a path where you can: external `$ref`s and a relative `servers`
entry are both resolved against it, and a parsed object has no location to
resolve them against.

The result is an ordinary `ViteMCP` instance. Add your own tools to it, or pass
`server` to register the generated ones onto a server you already have:

```typescript
const server = new ViteMCP({ name: "Ops", version: "1.0.0" });

server.addTool({ execute: async () => "pong", name: "ping" });

await fromOpenAPI({ server, spec: "./openapi.json" });
```

## Installing the bundler

A single-file JSON document needs nothing beyond ViteMCP.

YAML documents, and documents whose `$ref`s point at other files or URLs, are
loaded through [`@apidevtools/swagger-parser`](https://www.npmjs.com/package/@apidevtools/swagger-parser).
It is an optional peer dependency, imported only when one of those cases comes
up, so a project that never meets one does not carry it:

```bash
npm install @apidevtools/swagger-parser
```

Without it, such a document fails with a message naming the package.

A path item may itself be a `$ref` — to `components.pathItems`, or to a file
several paths share. It is followed, and whatever is written beside the
reference (`parameters`, say) applies to that path alone.

Swagger 2.0 is not supported. Convert it first — <https://converter.swagger.io>
does it in place.

## Choosing operations

A document with two hundred operations makes two hundred tools, which is a tool
list no client can present and no model can choose from. `fromOpenAPI` will not
produce one silently: with no `include`, `exclude` or `maxTools`, more than 40
operations is an error rather than a large server.

```typescript
await fromOpenAPI({
  exclude: (operation) => operation.operationId === "deleteAllOrders",
  include: (operation) => operation.tags.includes("orders"),
  spec: "./openapi.json",
});
```

Both predicates receive `{ deprecated, description, method, operationId, path,
summary, tags }`. `exclude` runs after `include`.

Deprecated operations are dropped by default; an `include` that asks for them
brings them back. `maxTools` raises or lowers the ceiling, and exceeding it is
an error too — truncating would drop operations you asked for without saying
which.

Operations are ordered reads first (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`)
and then by path, so the tool list stays stable as the document grows.

## Authentication

`headers` is sent with every generated call. Pass an object for a credential
the process owns:

```typescript
await fromOpenAPI({
  headers: { authorization: `Bearer ${process.env.API_TOKEN}` },
  spec: "./openapi.json",
});
```

Pass a function for one the caller brought. ViteMCP is stateless, so the
function runs per request and sees that request's `context`:

```typescript
const server = await fromOpenAPI<Session>({
  headers: (context) => ({
    authorization: `Bearer ${context.auth!.upstreamToken}`,
  }),
  server: existing,
  spec: "./openapi.json",
});
```

`query` does the same for APIs that take their key in the query string.

Both are applied **after** the operation's own parameters. If a document
declares a header or query parameter with the same name as one of your
credentials, the configured value wins — a model that can be talked into
supplying its own `authorization` argument cannot displace the real one.

## How an operation becomes a tool

**Name.** `operationId`, if there is one, with any generated
`__path__method` suffix removed; otherwise the `summary`, otherwise
`method_path`. Slugified, capped at 64 characters, and suffixed `_2`, `_3`, …
on collision. `toolNames` overrides it, keyed by `operationId` or as a function:

```typescript
await fromOpenAPI({
  spec: "./openapi.json",
  toolNames: { getPetById: "find_pet" },
});
```

**Description.** The `summary`, the `description`, and the method and path —
two operations on neighbouring paths often share a summary word for word.

**Annotations.** Derived from the method, so a client can tell a read from a
delete without reading the description:

| Method   | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
| -------- | -------------- | ----------------- | ---------------- |
| `GET`    | `true`         | —                 | `true`           |
| `POST`   | `false`        | `false`           | `false`          |
| `PUT`    | `false`        | `true`            | `true`           |
| `PATCH`  | `false`        | `true`            | `false`          |
| `DELETE` | `false`        | `true`            | `true`           |

`openWorldHint` is `true` throughout — every one of these tools calls somebody
else's API. The `summary` becomes the annotation `title`.

## Arguments

Path, query, header and cookie parameters and the request body are flattened
into one object schema. A model filling one flat argument list gets it right far
more often than one asked to nest a body under `body` and parameters under
`params`.

A request body defined by `$ref`, or composed with `allOf`, is followed and
flattened too. A body with no properties to flatten — an array, a scalar, or a
dictionary that only declares `additionalProperties` — becomes a single `body`
argument instead.

Names can collide between the four locations and the body. A colliding
parameter is suffixed with its location; the body keeps the bare name:

```
petId          the request body's own property
petId__query   the query parameter of the same name
```

Path parameters are required whether or not the document says so, since the URL
cannot be built without them. Each parameter's `description` and `deprecated`
flag are folded into its schema, which is what the model reads when deciding
what to put there.

`style` and `explode` are honoured: `form` (exploded and not), `spaceDelimited`,
`pipeDelimited` and `deepObject` for query parameters, `simple`, `label` and
`matrix` for path parameters. An array sent to an operation declaring
`explode: false` arrives comma-joined, not repeated.

`components.schemas` referenced by an operation travel with it as `$defs` —
only the ones it actually reaches, so `tools/list` does not carry the whole
document once per tool. OpenAPI's `nullable`, draft-04 boolean
`exclusiveMinimum`/`exclusiveMaximum`, and a stray `required: true` are
normalized on the way, since none of them compiles as JSON Schema.

## Responses

A JSON object comes back as `structuredContent`, mirrored as JSON text for
clients that do not read it. A JSON array or scalar comes back as
pretty-printed text — MCP's structured content has to be an object. An
`image/*` or `audio/*` response becomes an image or audio content block. Any
other body comes back as text, truncated at `maxResponseCharacters`
(1,000,000 by default).

A non-2xx response becomes a tool error carrying the status and the first 2,000
characters of the body, so the model can react to it rather than the call
failing outright.

`context.signal` is forwarded to the upstream request, so an abandoned or
timed-out tool call stops the HTTP request it started.

### Output schemas

`outputSchema: true` declares each tool's output schema from the operation's
first 2xx JSON response.

It is off by default. MCP makes a declared output schema binding and the SDK
rejects a result that does not validate against it, so on a document whose
response schemas have drifted from the real API — which is the common case —
turning this on converts a cosmetic inaccuracy into a failed tool call. Turn it
on when the document is generated from the server's own types.

Only object-typed responses get a schema; an array or scalar response is left
undeclared, since structured content cannot carry one.

A response schema pulling in more than 100 shared definitions is also left
undeclared. Every tool's schema travels in one `tools/list`, and on a large
document the response schemas reach most of the components table: unbounded,
Stripe's would be roughly 362MB across the server. Those tools return text, as
they would for an operation that declares no response schema at all.

## The base URL

Resolved from the operation's `servers`, then the path item's, then the
document's. Server variables are substituted with their defaults.

A relative entry is resolved against wherever the document was loaded from —
Swagger's own Petstore ships `servers: [{ url: "/api/v3" }]`, which a validator
accepts and an HTTP client cannot use. If the document was not loaded from an
http(s) URL there is nothing to resolve it against, and `baseUrl` is required.

`baseUrl` overrides all of it, which is also how you point a tool set at a
staging host.

## Options

| Option                  | Type                                 | Default                      | Purpose                                               |
| ----------------------- | ------------------------------------ | ---------------------------- | ----------------------------------------------------- |
| `spec`                  | `string \| object`                   | —                            | URL, file path, inline JSON, or a parsed document     |
| `baseUrl`               | `string`                             | from `servers`               | Overrides the address to call                         |
| `include`               | `(operation) => boolean`             | —                            | Keeps only matching operations                        |
| `exclude`               | `(operation) => boolean`             | —                            | Drops matching operations, after `include`            |
| `maxTools`              | `number`                             | `40` when no selection given | Ceiling on generated tools; exceeding it throws       |
| `headers`               | `object \| (context) => object`      | —                            | Headers for every call; override operation parameters |
| `query`                 | `object \| (context) => object`      | —                            | Query parameters for every call; same precedence      |
| `toolNames`             | `Record<string, string> \| function` | —                            | Overrides generated names                             |
| `outputSchema`          | `boolean`                            | `false`                      | Declares output schemas from response schemas         |
| `maxResponseCharacters` | `number`                             | `1_000_000`                  | Truncation point for a response body                  |
| `timeoutMs`             | `number`                             | —                            | Applied to every generated tool                       |
| `fetch`                 | `typeof fetch`                       | global `fetch`               | HTTP client, for tests or a proxy                     |
| `server`                | `ViteMCP`                            | a new one                    | Registers onto an existing server                     |
| `name` / `version`      | `string`                             | the document's `info`        | Server metadata, when creating one                    |

## Limits

- **Tools only.** Every operation becomes a tool, `GET`s included. There is no
  resource or resource-template mapping — agent clients call tools far more
  reliably than they read resources.
- **Request bodies** are `application/json`, `application/x-www-form-urlencoded`,
  and text or XML (sent as a single `body` string). `multipart/form-data` and
  binary uploads are not constructed; an operation that only accepts one says so
  in its description and sends no body.
- **Form-encoded bodies** follow the OpenAPI default, `style: form` with
  `explode: true`: an array of scalars is repeated once per entry. Anything
  nested — an object, or an array of objects — is bracketed
  (`metadata[order]=42`, `items[0][price]=p1`), which is what the APIs
  accepting nested form bodies read. The request body's `encoding` object is
  not consulted.
- **A body on a `GET`** is legal in OpenAPI and rejected by `fetch`, so it is
  left out of the schema rather than advertised and then refused.
- **No response validation** beyond the optional `outputSchema`.
- **`allowReserved`** on a query parameter is ignored; values are always
  percent-encoded.

## Testing

Pass `fetch` to record or stub what the generated tools would send, and drive
the result through an in-memory transport:

```typescript
const calls: URL[] = [];

const server = await fromOpenAPI({
  fetch: async (input) => {
    calls.push(new URL(String(input)));
    return new Response("{}", {
      headers: { "content-type": "application/json" },
    });
  },
  spec: document,
});
```

See [Unit testing with an in-memory transport](../README.md#unit-testing-with-an-in-memory-transport).
