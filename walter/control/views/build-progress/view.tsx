// Build progress for connect_system / build_status: what walter is finding, live, until the MCP is deployed.
import { useEffect, useState } from "react";
import { useCallTool, useToolContext } from "mcp-use/react";

type Build = { build_id: string; mcp: string; status: "running" | "live" | "failed"; stage: string; progress: number; log: string[]; error?: string | null;
  result?: { name: string; url: string; version: string; tools: string[]; rules: number; evals: string[]; connect: { claude_code: string } } };

const C = { bg: "#161616", line: "#2C2C2C", text: "#EDEDED", muted: "#A1A1A1", dim: "#6E6E6E", accent: "#C4B5FD", ok: "#4ADE80", warn: "#FBBF24" };

export default function BuildProgress() {
  const { status, toolOutput } = useToolContext<any>();
  const poll = useCallTool("build_status");
  const [b, setB] = useState<Build | null>(null);
  useEffect(() => { if (toolOutput) setB(toolOutput as Build); }, [toolOutput]);
  useEffect(() => { if (poll.data?.structuredContent) setB(poll.data.structuredContent as Build); }, [poll.data]);
  useEffect(() => {
    if (!b || b.status !== "running") return;
    const t = setTimeout(() => void poll.callTool({ build_id: b.build_id, wait_seconds: 0 }), 1800);
    return () => clearTimeout(t);
  }, [b]);

  if (status === "pending" || !b) return <div style={{ ...box, color: C.muted }}>Connecting…</div>;
  if (status === "error") return <div style={{ ...box, color: C.warn }}>walter could not start this build.</div>;
  const live = b.status === "live", failed = b.status === "failed";
  return (
    <div style={box}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <span style={{ fontFamily: "Georgia, serif", fontStyle: "italic", fontSize: 20 }}>walter</span>
        <span style={{ fontSize: 12, color: failed ? C.warn : live ? C.ok : C.accent }}>{failed ? "failed" : live ? "live" : b.stage}</span>
      </div>
      <div style={{ height: 3, background: C.line, margin: "12px 0 14px" }}><div style={{ height: 3, width: `${b.progress}%`, background: failed ? C.warn : C.accent, transition: "width .6s" }} /></div>
      <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, lineHeight: 1.7, color: C.muted }}>
        {b.log.slice(-9).map((l, i, a) => <div key={i} style={{ color: i === a.length - 1 && !live ? C.text : C.muted }}>{l.startsWith("found") ? <span style={{ color: C.accent }}>✓ </span> : l.startsWith("observed") ? <span style={{ color: C.accent }}>◆ </span> : "· "}{l}</div>)}
      </div>
      {live && b.result && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.line}`, fontSize: 13 }}>
          <div style={{ fontWeight: 600 }}>{b.result.name} {b.result.version}</div>
          <div style={{ color: C.muted, margin: "4px 0 8px" }}>{b.result.rules} company rules · {b.result.tools.join(", ")}</div>
          <code style={{ display: "block", background: "#101010", border: `1px solid ${C.line}`, padding: "8px 10px", fontSize: 12, color: C.text, wordBreak: "break-all" }}>{b.result.connect.claude_code}</code>
        </div>
      )}
      {failed && <div style={{ marginTop: 10, color: C.warn, fontSize: 13 }}>{b.error}</div>}
    </div>
  );
}

const box: React.CSSProperties = { background: C.bg, color: C.text, border: `1px solid ${C.line}`, padding: "16px 18px", fontFamily: "Inter, system-ui, sans-serif", fontSize: 14 };
