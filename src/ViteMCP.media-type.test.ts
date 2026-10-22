/**
 * Regression tests for the MIME type imageContent/audioContent report.
 * `file-type` reads binary signatures only, and an SVG is text: it came back
 * as `image/png`, or as `application/xml` after an XML declaration.
 */
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { imageContent } from "./ViteMCP.js";

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

/** Answers every media fetch with `body`, under `headers`. */
const serve = (body: Buffer, headers: Record<string, string> = {}) => {
  mediaFetchMock.mockResolvedValue(
    new Response(new Uint8Array(body), { headers }),
  );
};

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';

describe("imageContent MIME type", () => {
  beforeEach(() => {
    mediaFetchMock.mockReset();
  });

  it.each([
    { name: "with no prolog", text: SVG },
    {
      name: "after an XML declaration and a comment",
      text: `<?xml version="1.0"?>\n<!-- icon -->\n${SVG}`,
    },
    {
      name: "after a byte order mark and the SVG 1.1 doctype",
      text: `\uFEFF<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n${SVG}`,
    },
    {
      name: "after a doctype with an internal subset, as Illustrator writes",
      text: `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generator: Adobe Illustrator 15.0.0, SVG Export Plug-In -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n\t<!ENTITY ns_flows "http://ns.adobe.com/Flows/1.0/">\n]>\n${SVG}`,
    },
    {
      name: "after a stylesheet processing instruction",
      text: `<?xml version="1.0"?>\n<?xml-stylesheet href="icon.css" type="text/css"?>\n${SVG}`,
    },
  ])("labels an SVG $name image/svg+xml", async ({ text }) => {
    const buffer = Buffer.from(text);

    expect(await imageContent({ buffer })).toEqual({
      data: buffer.toString("base64"),
      mimeType: "image/svg+xml",
      type: "image",
    });
  });

  it("labels an SVG read from a path image/svg+xml", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitemcp-svg-"));

    try {
      const path = join(directory, "icon.svg");

      await writeFile(path, SVG);

      expect((await imageContent({ path })).mimeType).toBe("image/svg+xml");
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it("labels an SVG fetched from a URL image/svg+xml", async () => {
    serve(Buffer.from(SVG), { "Content-Type": "text/plain" });

    expect(
      (await imageContent({ url: "https://media.example.com/icon" })).mimeType,
    ).toBe("image/svg+xml");
  });

  it.each(["not an image", `<html>${SVG}</html>`, "<svg-icon/>"])(
    "keeps the image/png fallback for %s",
    async (text) => {
      expect((await imageContent({ buffer: Buffer.from(text) })).mimeType).toBe(
        "image/png",
      );
    },
  );

  it("keeps a sniffed type when the document is not an SVG", async () => {
    const buffer = Buffer.from('<?xml version="1.0"?><html/>');

    expect((await imageContent({ buffer })).mimeType).toBe("application/xml");
  });
});
