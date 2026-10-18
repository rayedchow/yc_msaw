import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const state = {
    existingRows: [] as Array<{ email: string; source: string }>,
    upserts: [] as Array<Record<string, unknown>>,
  };
  const onConflictDoUpdate = vi.fn(async () => []);
  const values = vi.fn((row: Record<string, unknown>) => {
    state.upserts.push(row);
    return { onConflictDoUpdate };
  });
  const insert = vi.fn(() => ({ values }));
  const where = vi.fn(async () => state.existingRows);
  const select = vi.fn(() => ({ from: vi.fn(() => ({ where })) }));
  return { state, select, insert, values, onConflictDoUpdate, where };
});

vi.mock("../../../../src/db/client.js", () => ({ db: dbMock }));

vi.mock("../../../../src/vault/google-auth.js", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  getGoogleAccessToken: vi.fn(async () => "test-access-token"),
  isDelegationConfigured: () => true,
}));

vi.mock("../../../../src/vault/tokens.js", () => ({
  getTokenMetadata: vi.fn(async () => ({ delegation: true, email: "admin@acme.com" })),
}));

import {
  contactNameCandidates,
  mergeContactCandidates,
  replacesSource,
  runGoogleContactsSync,
  type GoogleContactNameCandidate,
} from "../../../../src/integrations/google/contacts/sync.js";

const OWNER = "owner@acme.com";

function candidate(overrides: Partial<GoogleContactNameCandidate>): GoogleContactNameCandidate {
  return {
    email: "sam@ext.com",
    displayName: "Sam Rivera",
    source: "other_contacts",
    ownerEmail: OWNER,
    resourceName: "otherContacts/c1",
    ...overrides,
  };
}

describe("google contacts name candidates", () => {
  it("persists only (email, display name) pairs and skips email-like or empty display names", () => {
    const candidates = contactNameCandidates([
      {
        resourceName: "people/c1",
        names: [{ displayName: "Sam Rivera", metadata: { primary: true } }],
        emailAddresses: [{ value: " Sam@Ext.COM " }, { value: "sam.alt@ext.com" }],
      },
      // display name is just the address again - no naming value
      {
        resourceName: "people/c2",
        names: [{ displayName: "noname@ext.com" }],
        emailAddresses: [{ value: "noname@ext.com" }],
      },
      // no name at all
      { resourceName: "people/c3", emailAddresses: [{ value: "blank@ext.com" }] },
      { resourceName: "people/c4", names: [{ displayName: "   " }], emailAddresses: [{ value: "ws@ext.com" }] },
      // no usable email
      { resourceName: "people/c5", names: [{ displayName: "No Email" }], emailAddresses: [{ value: "not-an-email" }] },
    ], "connections", OWNER);

    expect(candidates).toEqual([
      { email: "sam@ext.com", displayName: "Sam Rivera", source: "connections", ownerEmail: OWNER, resourceName: "people/c1" },
      { email: "sam.alt@ext.com", displayName: "Sam Rivera", source: "connections", ownerEmail: OWNER, resourceName: "people/c1" },
    ]);
  });

  it("prefers the primary name entry", () => {
    const [entry] = contactNameCandidates([{
      resourceName: "people/c1",
      names: [{ displayName: "Nickname" }, { displayName: "Sam Rivera", metadata: { primary: true } }],
      emailAddresses: [{ value: "sam@ext.com" }],
    }], "connections", OWNER);
    expect(entry?.displayName).toBe("Sam Rivera");
  });
});

describe("google contacts precedence", () => {
  it("connections beats other_contacts regardless of encounter order", () => {
    const fromOther = candidate({ displayName: "sam auto", source: "other_contacts" });
    const fromConnections = candidate({ displayName: "Sam Rivera", source: "connections", resourceName: "people/c9" });

    expect(mergeContactCandidates([fromOther, fromConnections]).get("sam@ext.com")).toEqual(fromConnections);
    expect(mergeContactCandidates([fromConnections, fromOther]).get("sam@ext.com")).toEqual(fromConnections);
  });

  it("newer candidate wins within the same source", () => {
    const first = candidate({ displayName: "Old Name", source: "connections" });
    const second = candidate({ displayName: "New Name", source: "connections" });
    expect(mergeContactCandidates([first, second]).get("sam@ext.com")?.displayName).toBe("New Name");
  });

  it("replacesSource encodes connections > other_contacts, newer-wins within source", () => {
    expect(replacesSource("connections", "connections")).toBe(true);
    expect(replacesSource("connections", "other_contacts")).toBe(true);
    expect(replacesSource("other_contacts", "other_contacts")).toBe(true);
    expect(replacesSource("other_contacts", "connections")).toBe(false);
  });
});

describe("runGoogleContactsSync", () => {
  beforeEach(() => {
    dbMock.state.existingRows = [];
    dbMock.state.upserts = [];
    dbMock.values.mockClear();
    dbMock.onConflictDoUpdate.mockClear();
    vi.stubGlobal("fetch", vi.fn(peopleApiFetch));
  });

  it("syncs both connections and otherContacts with full pagination and upserts names", async () => {
    const result = await runGoogleContactsSync("tenant-1", { delegatedEmails: [OWNER] });

    expect(result).toMatchObject({
      delegatedUsers: 1,
      connectionsSeen: 2,
      otherContactsSeen: 1,
      candidateNames: 2,
      namesUpserted: 2,
    });
    const requested = (fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
    expect(requested.some((url) => url.includes("/people/me/connections") && url.includes("pageToken=page-2"))).toBe(true);
    expect(requested.some((url) => url.includes("/otherContacts"))).toBe(true);

    expect(dbMock.state.upserts).toEqual(expect.arrayContaining([
      expect.objectContaining({ tenantId: "tenant-1", email: "saved@ext.com", displayName: "Saved Contact", source: "connections", ownerEmail: OWNER }),
      expect.objectContaining({ tenantId: "tenant-1", email: "auto@ext.com", displayName: "Auto Collected", source: "other_contacts" }),
    ]));
    // names only - nothing else from the contact card is persisted
    for (const row of dbMock.state.upserts) {
      expect(Object.keys(row).sort()).toEqual(["displayName", "email", "ownerEmail", "resourceName", "source", "syncedAt", "tenantId"]);
    }
  });

  it("never demotes an existing connections row with an other_contacts candidate", async () => {
    dbMock.state.existingRows = [{ email: "auto@ext.com", source: "connections" }];

    const result = await runGoogleContactsSync("tenant-1", { delegatedEmails: [OWNER] });

    expect(result.namesUpserted).toBe(1);
    expect(dbMock.state.upserts.map((row) => row.email)).toEqual(["saved@ext.com"]);
  });

  it("re-syncing is idempotent: the same rows upsert again without error", async () => {
    const first = await runGoogleContactsSync("tenant-1", { delegatedEmails: [OWNER] });
    const firstUpserts = dbMock.state.upserts.map(({ syncedAt: _syncedAt, ...row }) => row);
    dbMock.state.upserts = [];

    const second = await runGoogleContactsSync("tenant-1", { delegatedEmails: [OWNER] });
    const secondUpserts = dbMock.state.upserts.map(({ syncedAt: _syncedAt, ...row }) => row);

    expect(second).toEqual(first);
    expect(secondUpserts).toEqual(firstUpserts);
  });
});

async function peopleApiFetch(input: URL | RequestInfo): Promise<{ ok: boolean; status: number; statusText: string; text: () => Promise<string> }> {
  const url = String(input);
  const respond = (payload: unknown) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify(payload),
  });
  if (url.includes("/people/me/connections")) {
    if (url.includes("pageToken=page-2")) {
      return respond({
        connections: [{
          resourceName: "people/c2",
          names: [{ displayName: "connections-page-2@ext.com" }],
          emailAddresses: [{ value: "emaillike@ext.com" }],
        }],
      });
    }
    return respond({
      connections: [{
        resourceName: "people/c1",
        names: [{ displayName: "Saved Contact", metadata: { primary: true } }],
        emailAddresses: [{ value: "saved@ext.com" }],
      }],
      nextPageToken: "page-2",
    });
  }
  if (url.includes("/otherContacts")) {
    return respond({
      otherContacts: [{
        resourceName: "otherContacts/o1",
        names: [{ displayName: "Auto Collected" }],
        emailAddresses: [{ value: "auto@ext.com" }],
      }],
    });
  }
  throw new Error(`unexpected fetch: ${url}`);
}


describe("normalizeCommaName", () => {
  it("swaps Google's 'Last, First' file-as order into 'First Last'", async () => {
    const { normalizeCommaName } = await import("../../../../src/integrations/google/contacts/sync.js");
    expect(normalizeCommaName("Byrne, Mary")).toBe("Mary Byrne");
    expect(normalizeCommaName("O'Neil, Sean Patrick")).toBe("Sean Patrick O'Neil");
    expect(normalizeCommaName("Mary Byrne")).toBe("Mary Byrne");
    expect(normalizeCommaName("Acme, Inc, LLC")).toBe("Acme, Inc, LLC");
  });
});
