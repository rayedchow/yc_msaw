import { randomBytes } from "node:crypto";
import type { FakeConfluence } from "./fake-confluence.js";

/** Synthetic Confluence site used by every confluence lane test (no real content). */

export const CLOUD = "cloud-1111";
export const SITE_URL = "https://acme.atlassian.net";
export const CONN = "conn-a";
export const ROOT = `sources/confluence/_sites/${CLOUD}/${CONN}`;
export const ENG = "100";
export const OPS = "200";

/** Binary-looking bytes (NUL, 0xff, CR/LF) so any text coercion would be visible. */
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]), randomBytes(2048)]);
export const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(3000), Buffer.from([0x00, 0xff, 0x0d, 0x0a])]);

const old = (d: number) => new Date(Date.UTC(2026, 0, d, 9)).toISOString();

export function seedSite(fake: FakeConfluence, cloudId = CLOUD, connectionId = CONN, siteUrl = SITE_URL): void {
  fake.site(connectionId, cloudId, siteUrl);
  fake.space(cloudId, ENG, "ENG", "Engineering");
  fake.space(cloudId, OPS, "OPS", "Operations");
  fake.page({
    id: "1001",
    cloudId,
    spaceId: ENG,
    versions: [
      { number: 1, createdAt: old(1), title: "Release Runbook", body: "<p>First draft</p>", message: "created" },
      { number: 2, createdAt: old(2), title: "Release Runbook", body: "<p>Second <em>draft</em></p>" },
      { number: 3, createdAt: old(3), title: "Release Runbook", body: "<p>Hello <strong>world</strong> v3</p><ac:image><ri:attachment ri:filename=\"diagram.png\" /></ac:image>" },
    ],
  });
  fake.page({ id: "1002", cloudId, spaceId: ENG, parentId: "1001", versions: [{ number: 1, createdAt: old(4), title: "Child page", body: "<p>child body</p>" }] });
  fake.page({ id: "1004", cloudId, spaceId: ENG, versions: [{ number: 1, createdAt: old(4), title: "Third ENG page", body: "<p>third</p>" }] });
  fake.page({ id: "1003", cloudId, spaceId: OPS, versions: [{ number: 1, createdAt: old(5), title: "Ops page", body: "<p>ops</p>" }] });
  fake.page({ id: "2001", cloudId, spaceId: ENG, type: "blogpost", versions: [{ number: 1, createdAt: old(6), title: "Launch post", body: "<p>launch v1</p>" }, { number: 2, createdAt: old(7), title: "Launch post", body: "<p>launch v2</p>" }] });
  fake.comments.push(
    { id: "c1", kind: "footer", cloudId, containerType: "page", containerId: "1001", version: 1, createdAt: old(8), updatedAt: old(8), authorId: "acct-1", body: "<p>Ship it</p>" },
    { id: "c2", kind: "footer", cloudId, containerType: "page", containerId: "1001", parentCommentId: "c1", version: 2, createdAt: old(9), updatedAt: old(10), authorId: "acct-2", body: "<p>Agreed, after QA</p>" },
    { id: "c3", kind: "inline", cloudId, containerType: "page", containerId: "1001", version: 1, createdAt: old(9), updatedAt: old(9), authorId: "acct-3", body: "<p>typo here</p>", selection: "Hello world", resolutionStatus: "open" },
    { id: "c4", kind: "footer", cloudId, containerType: "blogpost", containerId: "2001", version: 1, createdAt: old(9), updatedAt: old(9), authorId: "acct-1", body: "<p>Nice post</p>" },
  );
  fake.attachments.push(
    { id: "att-1", cloudId, containerType: "page", containerId: "1001", title: "diagram.png", mediaType: "image/png", version: 1, updatedAt: old(3), bytes: PNG },
    { id: "att-2", cloudId, containerType: "page", containerId: "1002", title: "spec.pdf", mediaType: "application/pdf", version: 1, updatedAt: old(4), bytes: PDF },
  );
  fake.permissions.set(ENG, [
    { id: "perm-1", principal: { type: "group", id: "g-eng" }, operation: { key: "read", targetType: "space" } },
    { id: "perm-2", principal: { type: "user", id: "acct-1" }, operation: { key: "administer", targetType: "space" } },
    { id: "perm-3", principal: { type: "group", id: "g-all" }, operation: { key: "create", targetType: "page" } },
  ]);
  fake.permissions.set(OPS, [{ id: "perm-9", principal: { type: "group", id: "g-ops" }, operation: { key: "read", targetType: "space" } }]);
  fake.restrictions.set("1001", [
    { operation: "read", restrictions: { user: { results: [{ accountId: "acct-1", profilePicture: { path: "https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/x.png" } }] }, group: { results: [{ name: "eng" }] } } },
    { operation: "update", restrictions: { user: { results: [] }, group: { results: [{ name: "eng-leads" }] } } },
  ]);
}

