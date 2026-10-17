import { z } from "zod";
import type { MCPServer } from "mcp-use";
import manifest from "../integration.json" with { type: "json" };
import { GithubError, readFile } from "./github.ts";

type EnvVar = { name: string; required: boolean; secret: boolean; description?: string };

function toolError(error: unknown) {
  const e =
    error instanceof GithubError
      ? { status: error.status, message: error.message, documentationUrl: error.documentationUrl, requestId: error.requestId, request: error.request }
      : { status: 0, message: String((error as Error)?.message ?? error), documentationUrl: null, requestId: null, request: "internal" };
  return { isError: true, content: [{ type: "text" as const, text: `GitHub error ${e.status}: ${e.message} (${e.request}; request id ${e.requestId ?? "n/a"})` }], structuredContent: e };
}

export function registerTools(server: MCPServer) {
  server.tool(
    {
      name: "integration_info",
      description: "Describe this integration: upstream service, tools, and configuration names.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const info = { slug: manifest.slug, title: manifest.title, upstream: manifest.upstream, tools: manifest.tools, env: (manifest.env as EnvVar[]).map((e) => ({ name: e.name, required: e.required, secret: e.secret })) };
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    },
  );

  server.tool(
    {
      name: "read_file",
      description: "Read a UTF-8 file from a public GitHub repository via the GitHub REST contents API. Returns the decoded text plus the file sha and GitHub request id.",
      inputSchema: z.object({
        owner: z.string().describe("Repository owner, e.g. octocat"),
        repo: z.string().describe("Repository name, e.g. hello-world"),
        path: z.string().describe("File path inside the repository, e.g. README.md"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ owner, repo, path }) => {
      try {
        const f = await readFile({ owner, repo, path });
        return { content: [{ type: "text", text: `${f.owner}/${f.repo}/${f.path}@${f.ref} (sha ${f.sha}, ${f.size} bytes${f.truncated ? ", truncated" : ""}):\n${f.text}` }], structuredContent: { ...f } };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
