import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the two data sources so the JOIN logic is tested in isolation.
const fetchDocContentMock = vi.fn();
const fetchDocChangelogMock = vi.fn();

vi.mock("../../src/integrations/google/gdocs/content.js", () => ({
  fetchDocContent: (...args: unknown[]) => fetchDocContentMock(...args),
}));
vi.mock("../../src/polling/_archived-gdocs/gdocs-revisions-load.js", () => ({
  fetchDocChangelog: (...args: unknown[]) => fetchDocChangelogMock(...args),
}));
// Real tracker — its grouping is what we want exercised through the join.

import { buildSuggestionCards } from "../../src/integrations/google/gdocs/suggestion-cards.js";

function changelogWith(ops: unknown[], userMap: Record<string, { name: string }>) {
  return {
    fileId: "doc1",
    totalRevisions: ops.length,
    userMap: new Map(Object.entries(userMap).map(([id, v]) => [id, { ...v, anonymous: false }])),
    operations: ops,
    tabs: [],
  };
}

describe("buildSuggestionCards", () => {
  beforeEach(() => {
    fetchDocContentMock.mockReset();
    fetchDocChangelogMock.mockReset();
  });

  it("joins content+placement (Docs API) to author (changelog) by exact suggestion ID", async () => {
    fetchDocContentMock.mockResolvedValue({
      docId: "doc1",
      title: "Spec",
      suggestionsAccessible: true,
      tabs: [
        {
          tabId: "t1",
          tabName: "Main",
          content: "…",
          contentHash: "h",
          suggestions: [
            {
              suggestionId: "suggest.abc",
              insertedText: "new wording",
              deletedText: "old wording",
              contextBefore: "the Q3 targets are",
              contextAfter: "as discussed",
            },
          ],
        },
      ],
    });
    fetchDocChangelogMock.mockResolvedValue(
      changelogWith(
        [
          {
            type: "insert_suggestion",
            text: "first draft",
            sugId: "suggest.abc",
            userId: "u_jane",
            timestamp: new Date("2026-07-03T14:14:00Z"),
            changelogIndex: 1,
          },
          // Same sugId, later op = a real modification with an exact timestamp.
          {
            type: "insert_suggestion",
            text: "new wording",
            sugId: "suggest.abc",
            userId: "u_jane",
            timestamp: new Date("2026-07-03T14:20:00Z"),
            changelogIndex: 2,
          },
        ],
        { u_jane: { name: "Jane Doe" } },
      ),
    );

    const result = await buildSuggestionCards("user1", "doc1");
    expect(result.changelogAvailable).toBe(true);
    expect(result.cards).toHaveLength(1);
    const card = result.cards[0];
    expect(card.suggestionId).toBe("suggest.abc");
    expect(card.insertedText).toBe("new wording");
    expect(card.deletedText).toBe("old wording");
    expect(card.contextBefore).toBe("the Q3 targets are");
    expect(card.authorUserId).toBe("u_jane");
    expect(card.authorName).toBe("Jane Doe");
    expect(card.authorshipResolved).toBe(true);
    // "When updated" — exact op timestamps, not derived.
    expect(card.createdAt).toEqual(new Date("2026-07-03T14:14:00Z"));
    expect(card.lastModifiedAt).toEqual(new Date("2026-07-03T14:20:00Z"));
    expect(card.modificationCount).toBe(1);
    expect(card.status).toBe("modified");
  });

  it("degrades to content-only cards when the changelog is unavailable (reader role / endpoint down)", async () => {
    fetchDocContentMock.mockResolvedValue({
      docId: "doc1",
      title: "Spec",
      suggestionsAccessible: true,
      tabs: [
        {
          tabId: "t1",
          tabName: "Main",
          content: "…",
          contentHash: "h",
          suggestions: [
            { suggestionId: "suggest.xyz", insertedText: "text", deletedText: "", contextBefore: "before", contextAfter: "after" },
          ],
        },
      ],
    });
    fetchDocChangelogMock.mockResolvedValue(null); // fails soft

    const result = await buildSuggestionCards("user1", "doc1");
    expect(result.changelogAvailable).toBe(false);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].insertedText).toBe("text");
    expect(result.cards[0].authorUserId).toBeNull();
    expect(result.cards[0].authorshipResolved).toBe(false);
    expect(result.cards[0].status).toBe("unknown");
  });

  it("skips the changelog fetch entirely when a doc has no pending suggestions", async () => {
    fetchDocContentMock.mockResolvedValue({
      docId: "doc1",
      title: "No Suggestions Doc",
      suggestionsAccessible: true,
      tabs: [
        { tabId: "t1", tabName: "Main", content: "Just body text.", contentHash: "h", suggestions: [] },
      ],
    });

    const result = await buildSuggestionCards("user1", "doc1");
    expect(result.cards).toHaveLength(0);
    expect(result.changelogAttempted).toBe(false);
    expect(result.changelogAvailable).toBe(false);
    // The undocumented, writer+-gated endpoint must NOT be hit for a
    // suggestion-free doc — this is the dominant cost saver at org scale.
    expect(fetchDocChangelogMock).not.toHaveBeenCalled();
  });

  it("drops empty suggestions and preserves per-tab identity", async () => {
    fetchDocContentMock.mockResolvedValue({
      docId: "doc1",
      title: "Spec",
      suggestionsAccessible: true,
      tabs: [
        {
          tabId: "t1",
          tabName: "Intro",
          content: "…",
          contentHash: "h",
          suggestions: [
            { suggestionId: "suggest.empty", insertedText: "", deletedText: "", contextBefore: "", contextAfter: "" },
            { suggestionId: "suggest.real", insertedText: "x", deletedText: "", contextBefore: "", contextAfter: "" },
          ],
        },
      ],
    });
    fetchDocChangelogMock.mockResolvedValue(null);

    const result = await buildSuggestionCards("user1", "doc1");
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].suggestionId).toBe("suggest.real");
    expect(result.cards[0].tabName).toBe("Intro");
  });
});
