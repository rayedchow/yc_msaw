import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/vault/google-auth.js", () => ({
  getGoogleAccessToken: vi.fn(async () => "mock-token"),
  GOOGLE_DOCS_DELEGATION_SCOPES: ["scope"],
}));
vi.mock("../../src/vault/google-rate-limit.js", () => ({
  throwIfGoogleRateLimited: vi.fn(),
  googleRateLimitErrorFromResponse: vi.fn(() => null),
  isGoogleRateLimit: vi.fn(() => false),
}));
// SOURCE-LANE PATCH (legacy Docs durable floor): fetchDocContent also consults the durable cooldown table.
vi.mock("../../src/source-lane/providers/google-docs/durable-cooldown.js", () => ({
  throwIfGoogleCooldownDurable: vi.fn(async () => {}),
  recordGoogleCooldownDurable: vi.fn(async () => {}),
}));

import { fetchDocContent } from "../../src/integrations/google/gdocs/content.js";
import { collectImageRefs } from "../../src/integrations/google/gdocs/images.js";

const originalFetch = globalThis.fetch;

function docResponse(doc: Record<string, unknown>): void {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(doc), { status: 200 })) as unknown as typeof fetch;
}

function para(elements: unknown[], extra: Record<string, unknown> = {}) {
  return { paragraph: { elements, ...extra } };
}

describe("gdocs markdown rendering of non-text elements", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders person/richLink/date chips, footnotes, equations, and alt-text image placeholders", async () => {
    docResponse({
      documentId: "d1",
      title: "Elements Doc",
      inlineObjects: {
        "kix.img1": {
          inlineObjectProperties: {
            embeddedObject: { title: "Q3 revenue chart", imageProperties: { contentUri: "https://ephemeral/x" } },
          },
        },
        "kix.chart1": {
          inlineObjectProperties: {
            embeddedObject: {
              linkedContentReference: { sheetsChartReference: { spreadsheetId: "s1", chartId: 2 } },
              imageProperties: { contentUri: "https://ephemeral/y" },
            },
          },
        },
      },
      positionedObjects: {
        "kix.float1": {
          positionedObjectProperties: { embeddedObject: { description: "floating diagram", imageProperties: {} } },
        },
      },
      footnotes: {
        fn1: { content: [para([{ textRun: { content: "Footnote body text.\n" } }])] },
      },
      body: {
        content: [
          para(
            [
              { textRun: { content: "Owned by " } },
              { person: { personProperties: { name: "Jane Doe", email: "jane@corp.com" } } },
              { textRun: { content: ", see " } },
              { richLink: { richLinkProperties: { title: "Q3 Plan", uri: "https://docs.google.com/q3", mimeType: "application/vnd.google-apps.document" } } },
              { textRun: { content: " due " } },
              { dateElement: { dateElementProperties: { displayText: "Jul 4, 2026", timestamp: "2026-07-04T12:00:00Z" } } },
              { footnoteReference: { footnoteId: "fn1", footnoteNumber: "1" } },
              { textRun: { content: ".\n" } },
            ],
            { positionedObjectIds: ["kix.float1"] },
          ),
          para([
            { textRun: { content: "Math: " } },
            { equation: {} },
            { textRun: { content: " and image " } },
            { inlineObjectElement: { inlineObjectId: "kix.img1" } },
            { textRun: { content: " chart " } },
            { inlineObjectElement: { inlineObjectId: "kix.chart1" } },
          ]),
        ],
      },
    });

    const doc = await fetchDocContent("u1", "d1");
    const content = doc.tabs[0].content;

    expect(content).toContain("[@Jane Doe](mailto:jane@corp.com)");
    expect(content).toContain("[Q3 Plan](https://docs.google.com/q3)");
    expect(content).toContain("Jul 4, 2026"); // date chip renders displayText
    expect(content).toContain("[^1]");
    expect(content).toContain("[^1]: Footnote body text.");
    expect(content).toContain("[equation]");
    expect(content).toContain("[image: Q3 revenue chart]");
    expect(content).toContain("[chart: linked Sheets chart]");
    expect(content).toContain("[image: floating diagram]"); // positioned object at anchor paragraph
    // The security rule: contentUri never leaks into rendered content.
    expect(content).not.toContain("ephemeral");
  });

  it("degrades gracefully when chip/object metadata is missing", async () => {
    docResponse({
      documentId: "d2",
      title: "Sparse",
      body: {
        content: [
          para([
            { person: { personProperties: { email: "bob@x.com" } } },
            { textRun: { content: " " } },
            { inlineObjectElement: { inlineObjectId: "kix.unknown" } },
            { textRun: { content: " " } },
            { dateElement: {} },
          ]),
        ],
      },
    });

    const doc = await fetchDocContent("u1", "d2");
    const content = doc.tabs[0].content;
    expect(content).toContain("@bob@x.com");
    expect(content).toContain("[image]"); // unknown object id → bare placeholder
    expect(content).toContain("[date]"); // no timestamp → placeholder
  });
});

describe("collectImageRefs", () => {
  it("collects inline + positioned + per-tab refs with kind and alt, keyed by objectId", () => {
    const refs = collectImageRefs({
      inlineObjects: {
        a: { inlineObjectProperties: { embeddedObject: { title: "Alt A", imageProperties: { contentUri: "https://u/a" } } } },
        noUri: { inlineObjectProperties: { embeddedObject: { title: "No bytes", imageProperties: {} } } },
      },
      positionedObjects: {
        b: { positionedObjectProperties: { embeddedObject: { embeddedDrawingProperties: {}, imageProperties: { contentUri: "https://u/b" } } } },
      },
      tabs: [
        {
          documentTab: {
            inlineObjects: {
              c: { inlineObjectProperties: { embeddedObject: { linkedContentReference: { sheetsChartReference: {} }, imageProperties: { contentUri: "https://u/c" } } } },
            },
          },
          childTabs: [],
        },
      ],
    });

    const byId = new Map(refs.map((r) => [r.objectId, r]));
    expect(byId.size).toBe(3); // noUri excluded
    expect(byId.get("a")).toMatchObject({ kind: "image", altText: "Alt A" });
    expect(byId.get("b")).toMatchObject({ kind: "drawing" });
    expect(byId.get("c")).toMatchObject({ kind: "chart" });
  });
});
