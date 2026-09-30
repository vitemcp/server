/**
 * `embedded()` resolves a resource the way `resources/read` does.
 *
 * A loader may name the `uri` of what it returns — the canonical address
 * behind an alias, say — and `resources/read` keeps it. `embedded()` replaced
 * it with the URI it was asked for, so one resource went out under two
 * identities depending on how the client came by it.
 */
import { describe, expect, it } from "vitest";

import { ViteMCP } from "./ViteMCP.js";

describe("embedded()", () => {
  it("keeps the uri a resource loader returns", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addResource({
      load: async () => ({ text: "{}", uri: "docs://canonical" }),
      mimeType: "application/json",
      name: "Alias",
      uri: "docs://alias",
    });

    expect(await server.embedded("docs://alias")).toEqual({
      mimeType: "application/json",
      text: "{}",
      uri: "docs://canonical",
    });
  });

  it("keeps the uri a resource template loader returns", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addResourceTemplate({
      arguments: [{ name: "id" }],
      load: async ({ id }) => ({
        text: `record ${id}`,
        uri: `docs://records/${id}/latest`,
      }),
      mimeType: "text/plain",
      name: "Record",
      uriTemplate: "docs://records/{id}",
    });

    expect(await server.embedded("docs://records/42")).toEqual({
      mimeType: "text/plain",
      text: "record 42",
      uri: "docs://records/42/latest",
    });
  });

  it("fills in the requested uri when the loader names none", async () => {
    const server = new ViteMCP({ name: "Test", version: "1.0.0" });

    server.addResource({
      load: async () => ({ text: "up" }),
      mimeType: "text/plain",
      name: "Status",
      uri: "system://status",
    });

    expect(await server.embedded("system://status")).toEqual({
      mimeType: "text/plain",
      text: "up",
      uri: "system://status",
    });
  });
});
