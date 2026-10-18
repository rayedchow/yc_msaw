import { describe, expect, it } from "vitest";
import { parseStagedDocumentMeta, stagedDocumentMeta } from "../../src/mirror/envelope.js";

describe("staged document envelope source contract", () => {
  it("requires native scope for represented types", () => {
    expect(() => stagedDocumentMeta({
      provider: "notion",
      externalId: "page-1",
      representedType: "Document",
      kind: "document",
    })).toThrow("representedType requires sourceNamespace");

    expect(parseStagedDocumentMeta({
      provider: "notion",
      externalId: "page-1",
      representedType: "Document",
      kind: "document",
    })).toBeNull();
  });

  it("keeps exactly one evidence identity for new refs and rejects navigation-only refs", () => {
    const meta = stagedDocumentMeta({
      provider: "gmail",
      externalId: "message-1",
      kind: "conversation_window",
      sourceRefs: [
        { anchor: "Body", url: "https://mail.example/message-1" },
        { anchor: "Body", sourceEventId: "gmail:message-1", url: "https://mail.example/message-1" },
        { anchor: "Attachment", sha256: "abc123" },
        { anchor: "Ambiguous", sourceEventId: "gmail:message-2", sha256: "def456" },
        { anchor: "" as string, sourceEventId: "gmail:message-1" },
      ],
    });

    expect(meta.sourceRefs).toEqual([
      { anchor: "Body", sourceEventId: "gmail:message-1", url: "https://mail.example/message-1" },
      { anchor: "Attachment", sha256: "abc123" },
    ]);
  });

  it("preserves legacy dual-valued evidence refs when reading stored metadata", () => {
    expect(parseStagedDocumentMeta({
      provider: "notion",
      externalId: "page-1",
      kind: "document",
      sourceRefs: [{
        anchor: "Legacy evidence",
        sourceEventId: "notion:webhook:legacy-event",
        sha256: "legacy-content-hash",
      }],
    })?.sourceRefs).toEqual([{
      anchor: "Legacy evidence",
      sourceEventId: "notion:webhook:legacy-event",
      sha256: "legacy-content-hash",
    }]);
  });

  it("normalizes topology links and keeps containment out of sourceAcl", () => {
    const meta = stagedDocumentMeta({
      provider: "calendar",
      externalId: "event-1",
      sourceNamespace: "calendar:primary",
      representedType: "Meeting",
      kind: "document",
      sourceAcl: {
        calendarId: "primary",
        visibility: "private",
        audience: ["owner@example.com"],
        hasHumanAttendee: false,
      },
      sourceLinks: [
        { role: "INSTANCE_OF", target: { provider: "calendar", namespace: "calendar:primary", id: "event:series-1" } },
        { role: "INSTANCE_OF", target: { provider: "calendar", namespace: "calendar:primary", id: "event:series-1" } },
      ],
    });

    expect(meta).toMatchObject({
      provider: "calendar",
      externalId: "event-1",
      sourceNamespace: "calendar:primary",
      representedType: "Meeting",
      sourceAcl: { visibility: "private", audience: ["owner@example.com"], hasHumanAttendee: false },
      sourceLinks: [{
        role: "INSTANCE_OF",
        target: { provider: "calendar", namespace: "calendar:primary", id: "event:series-1" },
      }],
    });
    expect(meta.sourceAcl).not.toHaveProperty("calendarId");
    expect(meta.sourceAcl).toHaveProperty("hasHumanAttendee", false);
  });

  it("preserves Google Docs folder and principal access evidence in sourceAcl", () => {
    const meta = stagedDocumentMeta({
      provider: "google-docs",
      externalId: "doc-1:tab-a",
      kind: "document",
      sourceAcl: {
        driveFolderIds: ["folder-a"],
        readers: ["reader@example.com"],
        writers: ["writer@example.com"],
        calendarId: "not-acl",
      },
    });

    expect(meta.sourceAcl).toEqual({
      driveFolderIds: ["folder-a"],
      readers: ["reader@example.com"],
      writers: ["writer@example.com"],
    });
  });

  it("lifts recognized containment identity into PARENT sourceLinks instead of dropping it", () => {
    const jira = stagedDocumentMeta({
      provider: "jira",
      externalId: "issue:cloud-1:10001",
      kind: "document",
      sourceAcl: { cloudId: "cloud-1", projectKey: "ENG", visibility: "restricted" },
    });
    expect(jira.sourceAcl).toEqual({ visibility: "restricted" });
    expect(jira.sourceLinks).toEqual([{
      role: "PARENT",
      target: { provider: "jira", namespace: "site:cloud-1", id: "project:ENG" },
    }]);

    const confluence = stagedDocumentMeta({
      provider: "confluence",
      externalId: "page-9",
      kind: "document",
      sourceAcl: { cloudId: "cloud-1", spaceId: "ENG" },
    });
    expect(confluence.sourceLinks).toEqual([{
      role: "PARENT",
      target: { provider: "confluence", namespace: "site:cloud-1", id: "space:ENG" },
    }]);

    const bitbucket = stagedDocumentMeta({
      provider: "bitbucket",
      externalId: "{repo-1}:pr:7",
      kind: "document",
      sourceAcl: { repoUuid: "{repo-1}", repoFullName: "team/repo" },
    });
    expect(bitbucket.sourceLinks).toEqual([{
      role: "PARENT",
      target: { provider: "bitbucket", namespace: "global", id: "repository:{repo-1}" },
    }]);

    const github = stagedDocumentMeta({
      provider: "github",
      externalId: "issue:5",
      kind: "document",
      sourceAcl: { repoKey: "R_kgDOexample", repoFullName: "org/repo" },
    });
    expect(github.sourceLinks).toEqual([{
      role: "PARENT",
      target: { provider: "github", namespace: "global", id: "repository:R_kgDOexample" },
    }]);
    // Mutable names never become link targets; the whitelist still strips them.
    expect(github.sourceAcl).toEqual({});
  });
});
