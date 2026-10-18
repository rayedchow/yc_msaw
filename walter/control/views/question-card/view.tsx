// Questions only a person can answer. Picking an option sends it to walter, which revises the rule and redeploys.
import { useEffect, useState } from "react";
import { useCallTool, useToolContext } from "mcp-use/react";

type Q = { mcp: string; mcp_name: string; question: number; rule: string; text: string; options: string[]; evidence: string };
const C = { bg: "#161616", line: "#2C2C2C", text: "#EDEDED", muted: "#A1A1A1", dim: "#6E6E6E", accent: "#C4B5FD", ok: "#4ADE80", warn: "#FBBF24" };

export default function QuestionCard() {
  const { status, toolOutput } = useToolContext<any>();
  const answer = useCallTool("answer_question");
  const poll = useCallTool("build_status");
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [build, setBuild] = useState<any>(null);
  const qs: Q[] = (toolOutput as any)?.questions ?? [];

  useEffect(() => { if (answer.data?.structuredContent) setBuild(answer.data.structuredContent); }, [answer.data]);
  useEffect(() => { if (poll.data?.structuredContent) setBuild(poll.data.structuredContent); }, [poll.data]);
  useEffect(() => {
    if (!build?.build_id || build.status !== "running") return;
    const t = setTimeout(() => void poll.callTool({ build_id: build.build_id, wait_seconds: 0 }), 3000);
    return () => clearTimeout(t);
  }, [build]);

  if (status === "pending") return <div style={{ ...box, color: C.muted }}>Loading questions…</div>;
  if (!qs.length) return <div style={{ ...box, color: C.muted }}>No open questions. walter's MCPs match history.</div>;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {qs.map((q) => {
        const key = `${q.mcp}:${q.question}`, chosen = picked[key];
        return (
          <div key={key} style={box}>
            <div style={{ fontSize: 12, color: C.dim, marginBottom: 6 }}>{q.mcp_name} · {q.rule} · history can't settle this</div>
            <div style={{ fontSize: 15, lineHeight: 1.45 }}>{q.text}</div>
            {q.evidence && <div style={{ fontSize: 12.5, color: C.muted, marginTop: 6, lineHeight: 1.5 }}>{q.evidence}</div>}
            <div style={{ marginTop: 10, borderTop: `1px solid ${C.line}` }}>
              {q.options.map((o, i) => (
                <button key={i} disabled={chosen !== undefined} onClick={() => { setPicked({ ...picked, [key]: i }); void answer.callTool({ mcp: q.mcp, question: q.question, option: i }); }}
                  style={{ display: "flex", gap: 10, width: "100%", textAlign: "left", padding: "10px 4px", background: chosen === i ? "rgba(196,181,253,0.12)" : "transparent", color: C.text,
                    border: 0, borderBottom: `1px solid ${C.line}`, cursor: chosen === undefined ? "pointer" : "default", font: "inherit", fontSize: 14, opacity: chosen !== undefined && chosen !== i ? 0.45 : 1 }}>
                  <b style={{ fontFamily: "ui-monospace, Menlo, monospace", color: C.dim, fontWeight: 500 }}>{"ABCD"[i]}</b>{o}
                </button>
              ))}
            </div>
            {chosen !== undefined && (
              <div style={{ marginTop: 10, fontSize: 12.5, color: build?.status === "failed" ? C.warn : build?.status === "live" ? C.ok : C.accent }}>
                {build?.status === "live" ? `Done: ${build.log?.at(-1) ?? "new version live"}` : build?.status === "failed" ? `Rebuild failed: ${build.error}` : `walter is revising the rule and redeploying… ${build?.log?.at(-1) ?? ""}`}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const box: React.CSSProperties = { background: C.bg, color: C.text, border: `1px solid ${C.line}`, padding: "14px 16px", fontFamily: "Inter, system-ui, sans-serif" };
