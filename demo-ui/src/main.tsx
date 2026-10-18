/*
 * Entry: polls the read-only trace server (GET /api/poll, complete JSONL
 * lines after a byte offset, state only when it changed) and renders the
 * ported AEye workbench. A new run (runId change, file reset) starts over.
 */
import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { adaptRun, isGlobalRunEnd, type DemoEvent, type DemoState, type RunContext } from "./adapter.js";
import { TraceWorkbench } from "./workbench.js";

interface Store {
  offset: number;
  key: string | null;
  stateHash: string | null;
  runId: string | null;
  events: DemoEvent[];
  index: Map<string, number>;
  state: DemoState | null;
  producer: RunContext["producer"];
}

function fresh(): Store {
  return { offset: 0, key: null, stateHash: null, runId: null, events: [], index: new Map(), state: null, producer: null };
}

function usePoll() {
  const [snapshot, setSnapshot] = useState<{ events: DemoEvent[]; state: DemoState | null; producer: RunContext["producer"]; version: number }>({ events: [], state: null, producer: null, version: 0 });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let store = fresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let failures = 0;
    let version = 0;
    const tick = async () => {
      let delay = 1_000;
      try {
        const query = new URLSearchParams({ offset: String(store.offset), key: store.key ?? "", state: store.stateHash ?? "" });
        const response = await fetch(`/api/poll?${query}`, { cache: "no-store", headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`The trace server answered ${response.status}.`);
        const body = await response.json() as {
          state?: DemoState | null; stateUnchanged?: boolean; stateHash?: string | null;
          events?: DemoEvent[]; offset?: number; key?: string | null; reset?: boolean; more?: boolean;
          producer?: RunContext["producer"];
        };
        let changed = false;
        const state = body.stateUnchanged ? store.state : body.state ?? null;
        const runId = typeof state?.runId === "string" ? state.runId : null;
        if (store.runId !== null && runId !== null && runId !== store.runId) {
          store = fresh();
          delay = 0;
          changed = true;
        } else {
          if (body.reset) { store = { ...fresh(), runId: store.runId }; changed = true; }
          if (!body.stateUnchanged) { store.state = state; store.stateHash = body.stateHash ?? null; changed = true; }
          if (runId !== null) store.runId = runId;
          for (const event of body.events ?? []) {
            if (!event || typeof event.id !== "string") continue;
            // Keyed by the line's byte offset (unique per line): producers can reuse an id for different events.
            const key = typeof event.seq === "number" ? `@${event.seq}` : event.id;
            const at = store.index.get(key);
            if (at === undefined) { store.index.set(key, store.events.length); store.events.push(event); }
            else store.events[at] = event;
            changed = true;
          }
          store.offset = typeof body.offset === "number" ? body.offset : store.offset;
          store.key = body.key ?? null;
          if (body.more) delay = 0;
        }
        failures = 0;
        setError(null);
        const producer = body.producer ?? null;
        if (JSON.stringify(producer) !== JSON.stringify(store.producer)) { store.producer = producer; changed = true; }
        if (changed) setSnapshot({ events: [...store.events], state: store.state, producer: store.producer, version: ++version });
        // Poll slower only once the whole run ended (the host's run_end or a terminal state), not when one build ends.
        const ended = store.events.some(isGlobalRunEnd) || (store.state?.status !== undefined && store.state.status !== "running" && store.state.status !== "waiting");
        if (ended && delay > 0) delay = 4_000;
      } catch (caught) {
        failures++;
        delay = Math.min(5_000, 1_000 * failures);
        setError(`Can't reach the trace server (${caught instanceof Error ? caught.message : String(caught)}). Retrying.`);
      }
      if (!disposed) setReady(true);
      if (document.hidden && delay > 0) delay = Math.max(delay, 4_000);
      if (!disposed) timer = setTimeout(tick, delay);
    };
    const onVisible = () => { if (!document.hidden) { clearTimeout(timer); void tick(); } };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  return { snapshot, ready, error };
}

function App() {
  const { snapshot, ready, error } = usePoll();
  const disconnected = error !== null;
  const run = useMemo(() => adaptRun(snapshot.events, snapshot.state, { producer: snapshot.producer, disconnected }), [snapshot, disconnected]);
  useEffect(() => {
    document.title = snapshot.state?.title ? `${snapshot.state.title} · Build trace` : "Build trace";
  }, [snapshot.state?.title]);
  return <TraceWorkbench run={run} ready={ready} error={ready && run.agents.length === 0 ? error : null} />;
}

createRoot(document.getElementById("root")!).render(<App />);
