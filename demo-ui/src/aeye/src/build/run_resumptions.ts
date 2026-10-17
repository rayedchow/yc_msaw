/* Type-only extract of AEye src/build/run_resumptions.ts (no database readers). */
export interface RunResumption {
  /** Stable for the receipt it comes from. */
  key: string;
  /**
   * "resumed": a person resumed the run. "restart": the job attempt a trusted
   * host restart released to recorded recovery activity. "attempt": any
   * other new job attempt. Nothing says "update": no update identity is
   * recorded.
   */
  kind: "resumed" | "restart" | "attempt";
  /** When it went on: the person's resume, or the new attempt's own recovery (never the shutdown). */
  at: string;
  /** The job attempt that began ("restart" and "attempt"). */
  attempt: number | null;
}
