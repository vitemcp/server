/**
 * Regression tests for unread response bodies: the media fetch and the
 * discovery document fetch both threw on a non-2xx without touching the body,
 * leaving the connection checked out until GC finalized the stream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DiscoveryDocumentCache } from "./DiscoveryDocumentCache.js";
import { audioContent, imageContent } from "./ViteMCP.js";

const { mediaFetchMock } = vi.hoisted(() => ({
  mediaFetchMock: vi.fn(),
}));

// ViteMCP.ts binds `fetch` from the undici module at import time, so spying on
// global.fetch cannot intercept it; mock the module instead and keep every
// other export intact.
vi.mock("undici", async (importOriginal) => {
  const original = await importOriginal<typeof import("undici")>();

  return { ...original, fetch: mediaFetchMock };
});

/** A non-2xx response whose body records whether it was cancelled. */
const erroredResponse = (cancel: () => Promise<unknown>) => ({
  body: { cancel },
  ok: false,
  status: 503,
  statusText: "Service Unavailable",
});

describe("cancelResponseBody", () => {
  beforeEach(() => {
    mediaFetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // imageContent and audioContent share readMedia, so one media path covers
  // both helpers.
  it("cancels the body when a media URL responds with a non-2xx", async () => {
    const cancel = vi.fn(async () => undefined);

    mediaFetchMock.mockResolvedValue(erroredResponse(cancel));

    await expect(
      imageContent({ url: "https://media.example.com/missing.png" }),
    ).rejects.toThrow(
      "Failed to fetch image from URL (https://media.example.com/missing.png): Server responded with status: 503",
    );

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves the HTTP error when cancelling the body fails", async () => {
    const cancel = vi.fn(async () => {
      throw new TypeError("ReadableStream is locked");
    });

    mediaFetchMock.mockResolvedValue(erroredResponse(cancel));

    await expect(
      imageContent({ url: "https://media.example.com/locked.png" }),
    ).rejects.toThrow(
      "Failed to fetch image from URL (https://media.example.com/locked.png): Server responded with status: 503",
    );

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("leaves the original error intact when the response carries no body", async () => {
    mediaFetchMock.mockResolvedValue({
      body: null,
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    await expect(
      audioContent({ url: "https://media.example.com/missing.mp3" }),
    ).rejects.toThrow(
      "Failed to fetch audio from URL (https://media.example.com/missing.mp3): Server responded with status: 404",
    );
  });

  it("cancels the body when a discovery document responds with a non-2xx", async () => {
    const cancel = vi.fn(async () => undefined);

    vi.spyOn(global, "fetch").mockResolvedValue(
      erroredResponse(cancel) as unknown as Response,
    );

    const url = "https://auth.example.com/.well-known/openid-configuration";

    await expect(new DiscoveryDocumentCache().get(url)).rejects.toThrow(
      `Failed to fetch discovery document from ${url}: 503 Service Unavailable`,
    );

    expect(cancel).toHaveBeenCalledOnce();
  });
});
