import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());
const enqueueCollectedEventMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/db/client.js", () => ({
  db: { execute: executeMock },
}));

vi.mock("../../../src/queue/dispatch.js", () => ({
  enqueueCollectedEventForProcessing: enqueueCollectedEventMock,
}));

import {
  processGithubCommitRecord,
  processGithubRepositoryRecord,
} from "../../../src/integrations/github/processors.js";

describe("GitHub Nango processors", () => {
  const executor = { execute: executeMock };

  beforeEach(() => {
    executeMock.mockReset().mockResolvedValue([{ id: "event-1" }]);
    enqueueCollectedEventMock.mockReset().mockResolvedValue(undefined);
  });

  it("does not emit users.noreply.github.com commit authors as email aliases", async () => {
    await processGithubCommitRecord(executor, {
      sha: "abc123",
      repository: { id: 42, full_name: "acme/api" },
      commit: {
        author: {
          name: "Mona Contributor",
          email: "12345+mona@users.noreply.github.com",
          date: "2026-07-04T12:30:00.000Z",
        },
      },
      author: { login: "mona" },
    }, { tenantId: "tenant-1", connectionId: "gh-installation" });

    const activityInsert = executeMock.mock.calls.find((call) =>
      sqlParts(call[0]).join(" ").includes("INSERT INTO activity_events")
    );
    const params = sqlParams(activityInsert![0]);
    expect(params).toContain("commit");
    expect(params).toContain("github:commit:42:abc123");
    const entitiesJson = params.find((param): param is string =>
      typeof param === "string" && param.includes("\"github_user\"")
    );
    expect(entitiesJson).toBeTruthy();
    expect(entitiesJson).toContain("\"login\":\"mona\"");
    expect(entitiesJson).not.toContain("email_contact");
    expect(entitiesJson).not.toContain("users.noreply.github.com");
  });

  it("materializes Repository records to repo.md keyed by numeric repo id", async () => {
    await processGithubRepositoryRecord(executor, {
      id: 42,
      full_name: "acme/api",
      name: "api",
      description: "Customer API service",
      language: "TypeScript",
      private: true,
      updated_at: "2026-07-05T10:00:00.000Z",
    }, { tenantId: "tenant-1", connectionId: "gh-installation" });

    const activityInsert = executeMock.mock.calls.find((call) =>
      sqlParts(call[0]).join(" ").includes("INSERT INTO activity_events")
    );
    expect(sqlParams(activityInsert![0])).toContain("repository");
    expect(sqlParams(activityInsert![0])).toContain("github:repo:42:2026-07-05T10:00:00.000Z");

    const mirrorInsert = executeMock.mock.calls.find((call) => {
      const parts = sqlParts(call[0]).join(" ");
      return parts.includes("INSERT INTO mirror_files") && sqlParams(call[0]).includes("sources/github/acme/api/repo.md");
    });
    expect(mirrorInsert).toBeTruthy();
    const content = sqlParams(mirrorInsert![0]).find((param): param is string =>
      typeof param === "string" && param.includes("# acme/api")
    );
    expect(content).toContain("Repository key: 42");
    expect(content).toContain("Language: TypeScript");
    expect(content).toContain("Private: yes");
    expect(content).toContain("Customer API service");
  });
});

function sqlParts(value: any): string[] {
  if (!value || !Array.isArray(value.queryChunks)) return [];
  return value.queryChunks.flatMap((chunk: any) => {
    if (Array.isArray(chunk?.value)) return chunk.value;
    if (Array.isArray(chunk?.queryChunks)) return sqlParts(chunk);
    return [];
  });
}

function sqlParams(value: any): unknown[] {
  if (!value || !Array.isArray(value.queryChunks)) return [];
  return value.queryChunks.flatMap((chunk: any) => {
    if (chunk === null || typeof chunk !== "object") return [chunk];
    if (Array.isArray(chunk.queryChunks)) return sqlParams(chunk);
    if (Array.isArray(chunk.value)) return [];
    if ("value" in chunk) return [chunk.value];
    return [];
  });
}
