/**
 * Regression tests for the MIME type imageContent/audioContent report, which
 * came from `file-type` alone. It reads binary signatures only, so:
 *
 * - an SVG, which is text, came back as `image/png`, or as `application/xml`
 *   after an XML declaration;
 * - audio-only WebM or MP4 came back as `video/webm` or `video/mp4`;
 * - headerless audio, such as raw PCM, came back as `audio/mpeg`, though the
 *   URL serving it declared its type.
 */
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

/** Answers every media fetch with `body`, under `headers`. */
const serve = (body: Buffer, headers: Record<string, string> = {}) => {
  mediaFetchMock.mockResolvedValue(
    new Response(new Uint8Array(body), { headers }),
  );
};

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';

// Same 1x1 PNG used by the imageContent tests in ViteMCP.test.ts
const PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

// A plain PBM image: text, which file-type has no signature for.
const PBM_BUFFER = Buffer.from("P1\n1 1\n1\n");

// Minimal RIFF/WAVE header
const WAV_BUFFER = Buffer.from(
  "UklGRiQAAABXQVZFZm10IBAAAAABAAEAIAAgAAAAZGF0YQAAAAA=",
  "base64",
);

// An EBML header with DocType "webm", which file-type names video/webm.
const WEBM_BUFFER = Buffer.from(
  "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYEC",
  "base64",
);

// An `ftyp` box with major brand `isom`, as ffmpeg writes for audio-only MP4,
// which file-type names video/mp4.
const MP4_BUFFER = Buffer.from(
  "000000186674797069736f6d0000020069736f6d69736f320000000866726565",
  "hex",
);

// Raw PCM silence: no header, so nothing for file-type to read.
const PCM_BUFFER = Buffer.alloc(4096);

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

  it("uses the image type a URL declared when the bytes name none", async () => {
    serve(PBM_BUFFER, { "Content-Type": "image/x-portable-bitmap" });

    expect(
      (await imageContent({ url: "https://media.example.com/dot.pbm" }))
        .mimeType,
    ).toBe("image/x-portable-bitmap");
  });

  it("keeps the sniffed image type over the one a URL declared", async () => {
    serve(PNG_BUFFER, { "Content-Type": "image/jpeg" });

    expect(
      (await imageContent({ url: "https://media.example.com/dot.jpg" }))
        .mimeType,
    ).toBe("image/png");
  });

  it("ignores a declared type that is not an image", async () => {
    serve(PBM_BUFFER, { "Content-Type": "text/plain" });

    expect(
      (await imageContent({ url: "https://media.example.com/dot" })).mimeType,
    ).toBe("image/png");
  });
});

describe("audioContent MIME type", () => {
  beforeEach(() => {
    mediaFetchMock.mockReset();
  });

  it.each([
    { buffer: WEBM_BUFFER, mimeType: "audio/webm", name: "WebM" },
    { buffer: MP4_BUFFER, mimeType: "audio/mp4", name: "MP4" },
  ])(
    "labels $name audio $mimeType, not as video",
    async ({ buffer, mimeType }) => {
      expect(await audioContent({ buffer })).toEqual({
        data: buffer.toString("base64"),
        mimeType,
        type: "audio",
      });
    },
  );

  it("labels WebM fetched from a URL audio/webm", async () => {
    serve(WEBM_BUFFER, { "Content-Type": "audio/webm; codecs=opus" });

    expect(
      (await audioContent({ url: "https://media.example.com/clip.webm" }))
        .mimeType,
    ).toBe("audio/webm");
  });

  it("uses the audio type a URL declared when the bytes name none", async () => {
    serve(PCM_BUFFER, { "Content-Type": "Audio/L16; rate=16000; channels=1" });

    expect(
      (await audioContent({ url: "https://media.example.com/clip.pcm" }))
        .mimeType,
    ).toBe("audio/l16");
  });

  it("keeps the sniffed audio type over the one a URL declared", async () => {
    serve(WAV_BUFFER, { "Content-Type": "audio/mpeg" });

    expect(
      (await audioContent({ url: "https://media.example.com/clip.mp3" }))
        .mimeType,
    ).toBe("audio/wav");
  });

  it("ignores a declared type that is not audio", async () => {
    serve(PCM_BUFFER, { "Content-Type": "application/octet-stream" });

    expect(
      (await audioContent({ url: "https://media.example.com/clip" })).mimeType,
    ).toBe("audio/mpeg");
  });
});
