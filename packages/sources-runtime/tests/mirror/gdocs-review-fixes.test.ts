import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression tests for the greploop review findings: tab-map isolation,
// non-text suggestion capture, contentUri redaction, and capped image reads.

vi.mock("../../src/vault/google-auth.js", () => ({
  getGoogleAccessToken: vi.fn(async () => "mock-token"),
  GOOGLE_DOCS_DELEGATION_SCOPES: ["scope"],
}));
vi.mock("../../src/vault/google-rate-limit.js", () => ({
  throwIfGoogleRateLimited: vi.fn(),
  googleRateLimitErrorFromResponse: vi.fn(() => null),
}));
const imageInsertMock = vi.hoisted(() => vi.fn());
const imageExecuteMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/db/client.js", () => ({
  db: {
    execute: imageExecuteMock,
    insert: () => ({ values: (v: unknown) => ({ onConflictDoUpdate: () => imageInsertMock(v) }) }),
  },
}));

import { parseDocContent } from "../../src/integrations/google/gdocs/content.js";
import { storeDocImages } from "../../src/integrations/google/gdocs/images.js";
import { redactEphemeralUris } from "../../src/mirror/materializer.js";

function para(elements: unknown[]) {
  return { paragraph: { elements } };
}

describe("per-tab map isolation", () => {
  it("resolves a reused footnote/object ID to the OWNING tab's content, not an earlier tab's", () => {
    const doc = parseDocContent({
      documentId: "d1",
      title: "Two tabs",
      tabs: [
        {
          tabProperties: { tabId: "t1", title: "One" },
          documentTab: {
            footnotes: { fn1: { content: [para([{ textRun: { content: "First tab note.\n" } }])] } },
            inlineObjects: {
              obj: { inlineObjectProperties: { embeddedObject: { title: "first-img", imageProperties: {} } } },
            },
            body: {
              content: [
                para([
                  { textRun: { content: "A" } },
                  { footnoteReference: { footnoteId: "fn1", footnoteNumber: "1" } },
                  { inlineObjectElement: { inlineObjectId: "obj" } },
                ]),
              ],
            },
          },
          childTabs: [],
        },
        {
          tabProperties: { tabId: "t2", title: "Two" },
          documentTab: {
            footnotes: { fn1: { content: [para([{ textRun: { content: "Second tab note.\n" } }])] } },
            inlineObjects: {
              obj: { inlineObjectProperties: { embeddedObject: { title: "second-img", imageProperties: {} } } },
            },
            body: {
              content: [
                para([
                  { textRun: { content: "B" } },
                  { footnoteReference: { footnoteId: "fn1", footnoteNumber: "1" } },
                  { inlineObjectElement: { inlineObjectId: "obj" } },
                ]),
              ],
            },
          },
          childTabs: [],
        },
      ],
    });

    expect(doc.tabs[0].content).toContain("First tab note.");
    expect(doc.tabs[0].content).toContain("[image: first-img]");
    expect(doc.tabs[1].content).toContain("Second tab note.");
    expect(doc.tabs[1].content).toContain("[image: second-img]");
    expect(doc.tabs[1].content).not.toContain("First tab note.");
    expect(doc.tabs[1].content).not.toContain("first-img");
  });
});

describe("non-text suggestion elements", () => {
  it("captures a suggestion that only inserts a chip/object (no text runs)", () => {
    const doc = parseDocContent({
      documentId: "d2",
      title: "Chip suggestion",
      inlineObjects: {
        img: { inlineObjectProperties: { embeddedObject: { title: "diagram", imageProperties: {} } } },
      },
      body: {
        content: [
          para([
            { textRun: { content: "Before " } },
            { person: { personProperties: { name: "Jane", email: "j@x.com" }, suggestedInsertionIds: ["suggest.chip"] } },
            { inlineObjectElement: { inlineObjectId: "img", suggestedInsertionIds: ["suggest.chip"] } },
            { textRun: { content: " after.\n" } },
          ]),
        ],
      },
    });

    const suggestions = doc.tabs[0].suggestions;
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].suggestionId).toBe("suggest.chip");
    expect(suggestions[0].insertedText).toContain("@Jane");
    expect(suggestions[0].insertedText).toContain("[image: diagram]");
    // Pending insertion stays out of base content.
    expect(doc.tabs[0].content).not.toContain("@Jane");
  });

  it("captures a suggested deletion of a date chip", () => {
    const doc = parseDocContent({
      documentId: "d3",
      title: "Chip deletion",
      body: {
        content: [
          para([
            { textRun: { content: "Due " } },
            { dateElement: { dateElementProperties: { displayText: "Jul 4, 2026" }, suggestedDeletionIds: ["suggest.del"] } },
          ]),
        ],
      },
    });

    const suggestions = doc.tabs[0].suggestions;
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].deletedText).toBe("Jul 4, 2026");
    // Text pending deletion still exists in base content.
    expect(doc.tabs[0].content).toContain("Jul 4, 2026");
  });
});

describe("redactEphemeralUris", () => {
  it("strips every contentUri, at any depth, without touching other fields", () => {
    const out = redactEphemeralUris({
      title: "Doc",
      inlineObjects: {
        a: { inlineObjectProperties: { embeddedObject: { imageProperties: { contentUri: "https://lh3.googleusercontent.com/secret" } } } },
      },
      tabs: [
        { documentTab: { positionedObjects: { b: { positionedObjectProperties: { embeddedObject: { imageProperties: { contentUri: "https://x/leak" } } } } } } },
      ],
    }) as Record<string, unknown>;

    const json = JSON.stringify(out);
    expect(json).not.toContain("googleusercontent");
    expect(json).not.toContain("https://x/leak");
    expect(json).toContain("[redacted: ephemeral requester-scoped URL]");
    expect(out.title).toBe("Doc");
  });
});

describe("storeDocImages byte cap", () => {
  const raw = {
    documentId: "d4",
    inlineObjects: {
      big: { inlineObjectProperties: { embeddedObject: { imageProperties: { contentUri: "https://img/big" } } } },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    imageExecuteMock.mockResolvedValue([]); // no fresh rows
  });

  it("rejects on Content-Length before reading the body", async () => {
    const body = { cancel: vi.fn(async () => {}) };
    const arrayBuffer = vi.fn();
    const res = {
      ok: true,
      headers: new Headers({ "content-length": String(200 * 1024 * 1024) }),
      body,
      arrayBuffer,
    } as unknown as Response;

    const result = await storeDocImages("u1", "d4", raw, async () => res);
    expect(result.skippedTooLarge).toBe(1);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(imageInsertMock).not.toHaveBeenCalled();
  });

  it("aborts mid-stream when an undeclared body crosses the cap", async () => {
    // 64 MiB in 8 MiB chunks with no content-length header.
    const chunk = new Uint8Array(8 * 1024 * 1024);
    let sent = 0;
    const cancel = vi.fn(async () => {});
    const res = {
      ok: true,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => (sent++ < 8 ? { done: false, value: chunk } : { done: true, value: undefined }),
          cancel,
        }),
      },
    } as unknown as Response;

    const result = await storeDocImages("u1", "d4", raw, async () => res);
    expect(result.skippedTooLarge).toBe(1);
    expect(cancel).toHaveBeenCalled(); // stopped reading at the cap, not at EOF
    expect(sent).toBeLessThan(8);
    expect(imageInsertMock).not.toHaveBeenCalled();
  });

  it("stores a normal-sized streamed body", async () => {
    const chunk = new Uint8Array([1, 2, 3, 4]);
    let sent = 0;
    const res = {
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      body: {
        getReader: () => ({
          read: async () => (sent++ < 1 ? { done: false, value: chunk } : { done: true, value: undefined }),
          cancel: vi.fn(),
        }),
      },
    } as unknown as Response;

    const result = await storeDocImages("u1", "d4", raw, async () => res);
    expect(result.fetched).toBe(1);
    expect(imageInsertMock).toHaveBeenCalledTimes(1);
    expect(imageInsertMock.mock.calls[0][0]).toMatchObject({ sizeBytes: 4, mimeType: "image/png" });
  });
});
