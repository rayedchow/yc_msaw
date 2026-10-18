import { describe, expect, it } from "vitest";

import { redactEphemeralUris, redactProviderPayload } from "../../src/vault/redaction.js";

describe("provider payload redaction", () => {
  it("applies global contentUri and signed URL rules without mutating input", () => {
    const input = {
      contentUri: "https://lh3.googleusercontent.com/requester-token",
      download: "https://bucket.s3.amazonaws.com/file.pdf?X-Amz-Signature=abc123&X-Amz-Expires=60",
      benignUrl: "https://example.com/file.pdf?view=1",
      prose: "not a url with X-Amz-Signature=abc123",
    };

    const out = redactProviderPayload("gmail", input) as typeof input;

    expect(out).not.toBe(input);
    expect(out.contentUri).toContain("[redacted:");
    expect(out.download).toContain("[redacted:");
    expect(out.benignUrl).toBe(input.benignUrl);
    expect(out.prose).toBe(input.prose);
    expect(input.contentUri).toContain("googleusercontent");
  });

  it("keeps redactEphemeralUris compatible with the Google Docs contentUri marker", () => {
    const out = redactEphemeralUris({ nested: { contentUri: "https://lh3.googleusercontent.com/secret" } });

    expect(JSON.stringify(out)).toContain("[redacted: ephemeral requester-scoped URL]");
    expect(JSON.stringify(out)).not.toContain("googleusercontent");
  });

  it("redacts Notion file URLs, signed URLs, and secure asset hosts", () => {
    const out = redactProviderPayload("notion", {
      file: { url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/private" },
      external: { url: "https://example.com/external-file" },
      signed_url: "https://example.com/download",
      icon: "https://secure.notion-static.com/image.png",
      pageUrl: "https://notion.so/page",
    }) as Record<string, unknown>;

    expect(JSON.stringify(out)).not.toContain("prod-files-secure");
    expect(JSON.stringify(out)).not.toContain("external-file");
    expect(JSON.stringify(out)).not.toContain("secure.notion-static");
    expect(JSON.stringify(out)).toContain("[redacted:");
    expect(out.pageUrl).toBe("https://notion.so/page");
  });

  it("redacts Google Calendar conference credentials while preserving conference shape", () => {
    const out = redactProviderPayload("google-calendar", {
      htmlLink: "https://calendar.google.com/event?eid=abc",
      conferenceData: {
        conferenceSolution: { name: "Google Meet" },
        entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij", passcode: "123456" }],
        signature: "provider-signature",
      },
    }) as { htmlLink: string; conferenceData: { conferenceSolution: { name: string }; entryPoints: Array<Record<string, unknown>>; signature: string } };

    expect(out.htmlLink).toBe("https://calendar.google.com/event?eid=abc");
    expect(out.conferenceData.conferenceSolution.name).toBe("Google Meet");
    expect(out.conferenceData.entryPoints[0].entryPointType).toBe("video");
    expect(out.conferenceData.entryPoints[0].uri).toContain("[redacted:");
    expect(out.conferenceData.entryPoints[0].passcode).toContain("[redacted:");
    expect(out.conferenceData.signature).toContain("[redacted:");
  });

  it("redacts Slack credentialed URL fields", () => {
    const out = redactProviderPayload("slack", {
      url_private: "https://files.slack.com/private",
      url_private_download: "https://files.slack.com/download",
      permalink_public: "https://slack-files.com/T/F/pub_secret=secret",
      thumb_64: "https://files.slack.com/thumb",
      title: "Roadmap",
    }) as Record<string, unknown>;

    expect(JSON.stringify(out)).not.toContain("files.slack.com");
    expect(JSON.stringify(out)).not.toContain("pub_secret");
    expect(out.title).toBe("Roadmap");
  });

  it("redacts Granola asset and download URL fields but keeps ordinary web URLs", () => {
    const out = redactProviderPayload("granola", {
      webUrl: "https://app.granola.ai/notes/note-1",
      assetUrl: "https://cdn.granola.ai/assets/audio.m4a",
      transcript_download_url: "https://cdn.granola.ai/download/transcript.txt",
      attachment: { url: "https://example.com/public" },
    }) as Record<string, unknown>;

    expect(out.webUrl).toBe("https://app.granola.ai/notes/note-1");
    expect(JSON.stringify(out)).not.toContain("audio.m4a");
    expect(JSON.stringify(out)).not.toContain("transcript.txt");
    expect(JSON.stringify(out)).toContain("https://example.com/public");
  });

  it("redacts Atlassian avatars, media URLs, and tokenized URLs", () => {
    const out = redactProviderPayload("jira", {
      self: "https://example.atlassian.net/rest/api/3/issue/PROJ-1",
      avatarUrls: {
        "48x48": "https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/user.png",
      },
      description: {
        content: [{
          type: "mediaSingle",
          content: [{ type: "media", attrs: { url: "https://api.media.atlassian.com/file/abc" } }],
        }],
      },
      attachment: { downloadUrl: "https://example.atlassian.net/secure/attachment/file.pdf?token=secret" },
    }) as Record<string, unknown>;

    expect(out.self).toBe("https://example.atlassian.net/rest/api/3/issue/PROJ-1");
    expect(JSON.stringify(out)).not.toContain("avatar-management");
    expect(JSON.stringify(out)).not.toContain("api.media.atlassian.com");
    expect(JSON.stringify(out)).not.toContain("token=secret");
    expect(JSON.stringify(out)).toContain("[redacted:");
  });

  it("keeps Bitbucket link hrefs but still redacts tokenized credential URLs", () => {
    const out = redactProviderPayload("bitbucket", {
      links: {
        html: { href: "https://bitbucket.org/workspace/repo/pull-requests/1" },
        diff: { href: "https://bitbucket.org/workspace/repo/diff?token=secret" },
      },
    }) as { links: { html: { href: string }; diff: { href: string } } };

    expect(out.links.html.href).toBe("https://bitbucket.org/workspace/repo/pull-requests/1");
    expect(out.links.diff.href).toContain("[redacted:");
  });

  it("redacts GitHub private-user-images and signed body_html asset URLs", () => {
    const out = redactProviderPayload("github", {
      body: "![image](https://private-user-images.githubusercontent.com/1/image.png?jwt=secret)",
      body_html: "<p><img src=\"https://github-production-user-asset-6210df.s3.amazonaws.com/file.png?X-Amz-Signature=abc\"></p>",
      html_url: "https://github.com/acme/api/issues/1",
    }) as Record<string, unknown>;

    expect(JSON.stringify(out)).not.toContain("private-user-images.githubusercontent.com");
    expect(JSON.stringify(out)).not.toContain("X-Amz-Signature");
    expect(JSON.stringify(out)).toContain("[redacted:");
    expect(out.html_url).toBe("https://github.com/acme/api/issues/1");
  });
});
