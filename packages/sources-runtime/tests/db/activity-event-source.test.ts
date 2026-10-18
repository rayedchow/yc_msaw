import { describe, expect, it } from "vitest";
import { deriveActivityEventSourceContract } from "../../src/db/activity-event-source.js";

describe("activity event source contract", () => {
  it("derives exact Gmail, Calendar, Granola, and Slack object identities", () => {
    expect(deriveActivityEventSourceContract({
      source: "gmail",
      eventType: "message_received",
      rawPayload: { gmailId: "msg-1", messageId: "<header@example.com>", _user_email: "User@Example.com" },
    })).toEqual({ sourceNamespace: "mailbox:user@example.com", sourceObjectId: "message:msg-1", recordKind: "activity" });

    expect(deriveActivityEventSourceContract({
      source: "calendar",
      eventType: "calendar_event_cancelled",
      rawPayload: { calendarId: "primary", id: "event-1" },
    })).toEqual({ sourceNamespace: "calendar:primary", sourceObjectId: "event:event-1", recordKind: "tombstone" });

    expect(deriveActivityEventSourceContract({
      source: "granola",
      eventType: "meeting_note",
      rawPayload: { granolaId: "note-1" },
      defaultRecordKind: "snapshot",
    })).toEqual({ sourceNamespace: "tenant", sourceObjectId: "meeting_note:note-1", recordKind: "snapshot" });

    expect(deriveActivityEventSourceContract({
      source: "slack",
      eventType: "message.edited",
      rawPayload: { _team_id: "T123", _channel: "C456", _object_ts: "1800000000.000100" },
    })).toEqual({
      sourceNamespace: "workspace:T123",
      sourceObjectId: "message:C456:1800000000.000100",
      recordKind: "activity",
    });
  });

  it("fails closed when immutable provider scope is absent", () => {
    expect(deriveActivityEventSourceContract({
      source: "slack",
      eventType: "message",
      rawPayload: { _channel: "C456", ts: "1800000000.000100" },
      defaultRecordKind: "activity",
    })).toEqual({ sourceNamespace: null, sourceObjectId: null, recordKind: "activity" });
  });

  it("classifies Slack lifecycle objects and deletion tombstones", () => {
    expect(deriveActivityEventSourceContract({
      source: "slack",
      eventType: "channel_rename",
      rawPayload: { _team_id: "T123", _channel: "C456" },
      defaultRecordKind: "activity",
    })).toEqual({ sourceNamespace: "workspace:T123", sourceObjectId: "channel:C456", recordKind: "activity" });

    expect(deriveActivityEventSourceContract({
      source: "slack",
      eventType: "message.deleted",
      rawPayload: { _team_id: "T123", _channel: "C456", _object_ts: "1800000000.000100" },
    }).recordKind).toBe("tombstone");
  });

  it("derives Nango identities only from immutable provider scope and object ids", () => {
    expect(deriveActivityEventSourceContract({
      source: "jira",
      eventType: "issue_detail",
      rawPayload: { cloudId: "cloud-1", id: "10042" },
    })).toMatchObject({ sourceNamespace: "site:cloud-1", sourceObjectId: "issue:10042" });

    expect(deriveActivityEventSourceContract({
      source: "jira",
      eventType: "issue_comment.deleted",
      rawPayload: { cloud_id: "cloud-1", id: "comment-7" },
    })).toEqual({ sourceNamespace: "site:cloud-1", sourceObjectId: "comment:comment-7", recordKind: "tombstone" });

    expect(deriveActivityEventSourceContract({
      source: "confluence",
      eventType: "page",
      rawPayload: { cloudId: "cloud-2", pageId: "page-9" },
    })).toMatchObject({ sourceNamespace: "site:cloud-2", sourceObjectId: "page:page-9" });

    expect(deriveActivityEventSourceContract({
      source: "github",
      eventType: "pull_request",
      rawPayload: { id: 81, base: { repo: { id: 912345678 } } },
    })).toMatchObject({ sourceNamespace: "repository:912345678", sourceObjectId: "pull_request:81" });

    expect(deriveActivityEventSourceContract({
      source: "bitbucket",
      eventType: "issue",
      rawPayload: { id: 42, repository: { uuid: "{repo-uuid}" } },
    })).toMatchObject({ sourceNamespace: "repository:{repo-uuid}", sourceObjectId: "issue:42" });

    expect(deriveActivityEventSourceContract({
      source: "bitbucket",
      eventType: "issue_comment",
      rawPayload: { id: 43, repository: { uuid: "{repo-uuid}" } },
    })).toMatchObject({ sourceNamespace: "repository:{repo-uuid}", sourceObjectId: "comment:43" });

    expect(deriveActivityEventSourceContract({
      source: "bitbucket",
      eventType: "pr_comment",
      rawPayload: { id: 44, destination: { repository: { uuid: "{repo-uuid}" } } },
    })).toMatchObject({ sourceNamespace: "repository:{repo-uuid}", sourceObjectId: "comment:44" });
  });

  it("leaves Nango records unscoped when they expose only mutable or incomplete context", () => {
    expect(deriveActivityEventSourceContract({
      source: "jira",
      eventType: "issue",
      rawPayload: { cloudId: "cloud-1", key: "ENG-42" },
    })).toMatchObject({ sourceNamespace: null, sourceObjectId: null });

    expect(deriveActivityEventSourceContract({
      source: "github",
      eventType: "issue",
      rawPayload: { id: "issue-42", repository_url: "https://api.github.com/repos/acme/api" },
    })).toMatchObject({ sourceNamespace: null, sourceObjectId: null });

    expect(deriveActivityEventSourceContract({
      source: "bitbucket",
      eventType: "pull_request",
      rawPayload: { id: 7, destination: { repository: { full_name: "team/api" } } },
    })).toMatchObject({ sourceNamespace: null, sourceObjectId: null });

    expect(deriveActivityEventSourceContract({
      source: "bitbucket",
      eventType: "pr_comment",
      rawPayload: { id: 8, repository: { full_name: "team/api" } },
    })).toMatchObject({ sourceNamespace: null, sourceObjectId: null });
  });
});
