// Host-owned FIXTURE emulating the GitHub REST "Get repository content" endpoint
// (https://docs.github.com/en/rest/repos/contents) for OFFLINE sealed validation only.
// The data is FAKE (fixture-org repos); live proofs always hit the real api.github.com.
// Runs as the harness uid; config arrives on stdin. Semantics mirrored from the docs and
// from live observations: GET /repos/{owner}/{repo}/contents/{path}?ref=<branch|tag|sha>,
// omitted ref = the repository's default branch, unknown ref -> 404
// {"message":"No commit found for the ref <ref>"}, unknown path -> 404 {"message":"Not Found"},
// file responses carry base64 content wrapped at 60 chars plus the git blob sha.
import http from "node:http";
import { createHash } from "node:crypto";

const input = await new Promise((resolve) => {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (buf += d));
  process.stdin.on("end", () => resolve(buf));
});
const cfg = JSON.parse(input || "{}");
const port = Number(cfg.port);
const adminToken = String(cfg.adminToken ?? "");

const COMMIT = "4f1c2a9e8b7d6c5b4a3928170f6e5d4c3b2a1908";
const repos = {
  "fixture-org/legacy": { default: "master", refs: { master: { "README.md": "# Legacy\n\nLegacy README (branch master).\n" } } },
  "fixture-org/modern": {
    default: "main",
    refs: {
      main: { "README.md": "# Modern\n\nREADME at main (default branch).\n", "docs/guide.md": "Guide at main.\n" },
      "v2.0.0": { "README.md": "# Modern\n\nREADME at v2.0.0 (release tag). Install: npm install modern-kit@2.0.0\n", "docs/guide.md": "Guide at v2.0.0.\n" },
      "release/1.x": { "README.md": "# Modern\n\nREADME at release/1.x (maintenance branch).\n" },
      [COMMIT]: { "README.md": "# Modern\n\nREADME at commit 4f1c2a9.\n" },
    },
  },
};

const state = { requests: [] };
let seq = 0;

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "x-github-request-id": `FIXTURE:${(++seq).toString(16).padStart(4, "0")}`,
    "x-ratelimit-limit": "60",
    "x-ratelimit-remaining": String(Math.max(0, 60 - seq)),
  });
  res.end(text);
}

const blobSha = (text) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
const wrap60 = (b64) => b64.replace(/(.{60})/g, "$1\n") + "\n";

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture.local");
  if (url.pathname === "/__state") {
    if (req.headers["x-fixture-admin"] !== adminToken) return send(res, 403, { message: "forbidden" });
    return send(res, 200, state);
  }
  const m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
  if (req.method !== "GET" || !m) return send(res, 404, { message: "Not Found", documentation_url: "https://docs.github.com/rest", status: "404" });
  const owner = decodeURIComponent(m[1]);
  const repo = decodeURIComponent(m[2]);
  const filePath = m[3].split("/").map(decodeURIComponent).join("/");
  const ref = url.searchParams.has("ref") ? url.searchParams.get("ref") : null;
  state.requests.push({ owner, repo, path: filePath, ref, accept: req.headers.accept ?? null, userAgent: req.headers["user-agent"] ?? null });
  const r = repos[`${owner}/${repo}`];
  if (!r) return send(res, 404, { message: "Not Found", documentation_url: "https://docs.github.com/rest/repos/contents#get-repository-content", status: "404" });
  const effective = ref ?? r.default;
  const tree = r.refs[effective];
  if (!tree) return send(res, 404, { message: `No commit found for the ref ${effective}`, documentation_url: "https://docs.github.com/v3/repos/contents/", status: "404" });
  const text = tree[filePath];
  if (text === undefined) return send(res, 404, { message: "Not Found", documentation_url: "https://docs.github.com/rest/repos/contents#get-repository-content", status: "404" });
  const sha = blobSha(text);
  const name = filePath.split("/").pop();
  const api = `http://127.0.0.1:${port}/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(effective)}`;
  return send(res, 200, {
    name,
    path: filePath,
    sha,
    size: Buffer.byteLength(text),
    url: api,
    html_url: `https://github.com/${owner}/${repo}/blob/${effective}/${filePath}`,
    git_url: `http://127.0.0.1:${port}/repos/${owner}/${repo}/git/blobs/${sha}`,
    download_url: `https://raw.githubusercontent.com/${owner}/${repo}/${effective}/${filePath}`,
    type: "file",
    content: wrap60(Buffer.from(text, "utf8").toString("base64")),
    encoding: "base64",
    _links: { self: api, git: null, html: null },
  });
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`fixture listening ${port}\n`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
