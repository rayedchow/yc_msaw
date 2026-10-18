import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { processBitbucketPullRequestRecord, processBitbucketRepositoryRecord } from "../../../../src/integrations/bitbucket/processors.js";
import { handleNangoProxyDetailsTask } from "../../../../src/integrations/nango/proxy-details.js";
import { handleNangoProxyIssuesTask } from "../../../../src/integrations/nango/proxy-issues.js";
import { bitbucketCoverage } from "../../../../src/source-lane/providers/bitbucket/coverage.js";
import { drain, makeExporter, ROOT } from "./fixtures.js";
import { connect, db, query, ready, resetAll } from "./harness.js";

/**
 * The donor Bitbucket lanes (Nango records processors, proxy issues, PR details/comments)
 * through their production processors and materializer, exported by the bitbucket module into
 * the real yc_msaw store: canonical identities, edited PRs and markdown (quotes) preserved.
 */

const T = "tenant-bb-donor";
const CONN = "bb-donor-conn";
const ctx = { tenantId: T, providerConfigKey: "bitbucket", connectionId: CONN };
const REPO_UUID = "{11111111-2222-3333-4444-555555555555}";

const QUOTED_COMMENT = "> Should this retry on 409?\n>\n> — reviewer\n\nYes: `409` is in the retry set.\n\n```ts\nconst RETRYABLE = new Set([409]);\n```";
const QUOTED_ISSUE = "Steps:\n\n> paste the token\n> then reload\n\n* expected: no crash";

interface State {
  prTitle: string;
  prUpdated: string;
  commentRaw: string;
  commentUpdated: string;
}

function fakeProxy(state: State) {
  const calls: string[] = [];
  const pr = () => ({
    id: 7,
    title: state.prTitle,
    state: "OPEN",
    description: "Adds **retry**.\n\n> quoted design note",
    author: { display_name: "Avery Author", uuid: "{aaaaaaaa-0000-0000-0000-000000000001}" },
    destination: { repository: { full_name: "team/api", uuid: REPO_UUID } },
    source: { repository: { full_name: "team/api", uuid: REPO_UUID } },
    participants: [{ user: { display_name: "Rae Reviewer" }, state: "approved", approved: true, participated_on: "2026-07-04T13:00:00.000000+00:00" }],
    updated_on: state.prUpdated,
    links: { html: { href: "https://bitbucket.org/team/api/pull-requests/7" } },
  });
  return {
    calls,
    proxy: async (input: { endpoint: string; params?: Record<string, unknown> }) => {
      calls.push(input.endpoint);
      const page = Number(input.params?.page ?? 1);
      if (input.endpoint === "/repositories/team/api/pullrequests") return { status: 200, data: { values: page === 1 ? [pr()] : [] } };
      if (input.endpoint === "/repositories/team/api/pullrequests/7") return { status: 200, data: pr() };
      if (input.endpoint === "/repositories/team/api/pullrequests/7/comments") {
        return {
          status: 200,
          data: {
            values:
              page === 1
                ? [{ id: 101, content: { raw: state.commentRaw, markup: "markdown" }, user: { display_name: "Rae Reviewer" }, created_on: "2026-07-04T12:30:00.000000+00:00", updated_on: state.commentUpdated }]
                : [],
          },
        };
      }
      if (input.endpoint === "/repositories/team/api/pullrequests/7/activity") return { status: 200, data: { values: [] } };
      if (input.endpoint === "/repositories/team/api/issues") {
        return { status: 200, data: { values: page === 1 ? [{ id: 3, title: "Crash on reload", state: "new", content: { raw: QUOTED_ISSUE }, reporter: { display_name: "Iris Issuer" }, repository: { full_name: "team/api", uuid: REPO_UUID }, created_on: "2026-07-01T00:00:00.000000+00:00", updated_on: "2026-07-02T00:00:00.000000+00:00" }] : [] } };
      }
      if (input.endpoint === "/repositories/team/api/issues/3/comments") return { status: 200, data: { values: [] } };
      return { status: 404, data: null };
    },
  };
}

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
  await connect(T, CONN);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("donor Bitbucket lanes through the source lane", () => {
  it("exports an edited PR with its folded comments, quote markdown intact, and every raw version with canonical keys", async () => {
    const { exporter, yc } = await makeExporter(T);
    await processBitbucketRepositoryRecord(db as never, { uuid: REPO_UUID, full_name: "team/api", name: "api", is_private: true, updated_on: "2026-07-01T00:00:00.000Z" }, ctx);
    const state: State = { prTitle: "Ship retry", prUpdated: "2026-07-04T12:00:00.000000+00:00", commentRaw: QUOTED_COMMENT, commentUpdated: "2026-07-04T12:30:00.000000+00:00" };
    const proxy = fakeProxy(state);
    await handleNangoProxyDetailsTask(db as never, { tenantId: T, provider: "bitbucket" }, { client: proxy as never });
    await handleNangoProxyIssuesTask(db as never, { tenantId: T, provider: "bitbucket" }, { client: proxy as never });
    await drain(exporter);

    const pr1 = await yc.text(`${ROOT}/team/api/pr-7.md`);
    expect(pr1).toContain("# Ship retry");
    expect(pr1).toContain("> Should this retry on 409?\n>\n> — reviewer");
    expect(pr1).toContain("```ts\nconst RETRYABLE = new Set([409]);\n```");
    expect(pr1).toContain("> quoted design note");
    expect(pr1).toContain("Rae Reviewer — approved");
    expect(await yc.text(`${ROOT}/team/api/issue-3.md`)).toContain("> paste the token\n> then reload");

    // The PR is edited (title + comment edit): new raw versions and a re-rendered projection.
    state.prTitle = "Ship retry (with backoff)";
    state.prUpdated = "2026-07-05T09:00:00.000000+00:00";
    state.commentRaw = `${QUOTED_COMMENT}\n\nEdit: also 425.`;
    state.commentUpdated = "2026-07-05T09:00:00.000000+00:00";
    await handleNangoProxyDetailsTask(db as never, { tenantId: T, provider: "bitbucket" }, { client: proxy as never });
    await drain(exporter);
    const pr2 = (await yc.file(`${ROOT}/team/api/pr-7.md`))!;
    expect(pr2.kind).toBe("projection");
    expect(pr2.bytes.toString()).toContain("# Ship retry (with backoff)");
    expect(pr2.bytes.toString()).toContain("Edit: also 425.");
    expect(pr2.bytes.toString()).not.toContain("# Ship retry\n");
    expect((await yc.history(`${ROOT}/team/api/pr-7.md`)).length).toBeGreaterThanOrEqual(2);

    const keys = (await query<{ source_event_id: string }>(`SELECT source_event_id FROM activity_events WHERE user_id = $1 ORDER BY source_event_id`, [T])).map((r) => r.source_event_id);
    expect(keys).toEqual(
      expect.arrayContaining([
        "nango:bitbucket:pull_request_detail:team/api#7:2026-07-04T12:00:00.000000+00:00",
        "nango:bitbucket:pull_request_detail:team/api#7:2026-07-05T09:00:00.000000+00:00",
        "nango:bitbucket:pr_comment:team/api#7#101:2026-07-04T12:30:00.000000+00:00",
        "nango:bitbucket:pr_comment:team/api#7#101:2026-07-05T09:00:00.000000+00:00",
        "nango:bitbucket:issues:team/api#3:2026-07-02T00:00:00.000000+00:00",
      ]),
    );
    // Every raw version is exported as the stored row, the quote markdown byte-exact inside raw_payload.
    const raws = await yc.paths(`${ROOT}/_raw`);
    const comments = [];
    for (const p of raws) {
      const row = await yc.json(p);
      if (row.event_type === "pr_comment") comments.push(row.raw_payload.content.raw);
    }
    expect(comments.sort()).toEqual([QUOTED_COMMENT, `${QUOTED_COMMENT}\n\nEdit: also 425.`].sort());

    const activity = (await bitbucketCoverage({ tenantId: T, executor: db as never })).find((c) => c.scope === "activity")!;
    expect(activity.state).toBe("partial");
  });

  it("keeps slim unknown-repo PR projections out of sources/ (they collide across repositories) while exporting their raw records", async () => {
    const { exporter, yc } = await makeExporter(T);
    await processBitbucketPullRequestRecord(db as never, { id: 7, title: "Repo A PR 7", state: "OPEN", updated_on: "2026-07-04T12:00:00.000Z" }, ctx);
    await processBitbucketPullRequestRecord(db as never, { id: 7, title: "Repo B PR 7", state: "OPEN", updated_on: "2026-07-04T12:05:00.000Z" }, ctx);
    // The donor still writes its provisional mirror row ...
    expect((await query(`SELECT path FROM mirror_files WHERE user_id = $1`, [T])).map((r) => r.path)).toContain("sources/bitbucket/unknown-repo/pr-7.md");
    await drain(exporter);
    // ... but the colliding projection is not published; both raw versions are.
    expect(await yc.paths(`${ROOT}/unknown-repo`)).toEqual([]);
    const raws = await yc.paths(`${ROOT}/_raw`);
    const titles = [];
    for (const p of raws) titles.push((await yc.json(p)).raw_payload.title);
    expect(titles.sort()).toEqual(["Repo A PR 7", "Repo B PR 7"]);
    const keys = (await query<{ source_event_id: string }>(`SELECT source_event_id FROM activity_events WHERE user_id = $1 ORDER BY 1`, [T])).map((r) => r.source_event_id);
    expect(keys).toEqual(["bitbucket:pr:unknown-repo:7:2026-07-04T12:00:00.000Z", "bitbucket:pr:unknown-repo:7:2026-07-04T12:05:00.000Z"]);
  });
});
