/**
 * The one duration format for tool and command steps in Chat, Edit, and
 * Build: milliseconds under a second, tenths under ten seconds, whole seconds
 * under a minute, then minutes and seconds. Zero is a real value ("0 ms").
 */
export function formatDurationMilliseconds(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return "unknown";
  // Pick each unit from the value as it will be shown, so 999.6 ms is "1.0 s"
  // and 59.6 s is "1 min", never "1000 ms" or "60 s".
  const value = Math.max(0, Math.round(milliseconds));
  if (value < 1_000) return `${value} ms`;
  if (value < 9_950) return `${(value / 1_000).toFixed(1)} s`;
  if (value < 59_500) return `${Math.round(value / 1_000)} s`;
  const seconds = Math.round(value / 1_000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes} min` : `${minutes} min ${remainder} s`;
}

/** Tools whose results can settle a resumable sandbox command. */
const COMMAND_TOOLS = new Set(["shell", "poll_command", "cancel_command", "write_command"]);

export interface RecordedToolDuration {
  /**
   * command: the sandbox's recorded time for the whole command operation;
   * tool: the call's measured time;
   * returned: a command call that returned while its command was still running;
   * failed: a command call that failed with no finished command, e.g. a script
   * the sandbox refused before starting it.
   */
  kind: "command" | "tool" | "returned" | "failed" | "unknown";
  text: string;
  title: string;
}

/**
 * The final, recorded duration for one completed tool result. Only durations
 * the runtime measured are shown; a result without one says so instead of
 * estimating from timestamps.
 */
export function recordedToolDuration(
  toolName: string,
  status: "succeeded" | "failed" | null,
  timing: { toolElapsedMilliseconds: number | null; commandDurationMilliseconds: number | null } | null | undefined,
): RecordedToolDuration {
  const command = timing?.commandDurationMilliseconds ?? null;
  const elapsed = timing?.toolElapsedMilliseconds ?? null;
  if (command !== null) {
    return {
      kind: "command",
      text: formatDurationMilliseconds(command),
      title: "How long the sandbox took for this command, including its setup, file tracking and checks",
    };
  }
  if (elapsed !== null && COMMAND_TOOLS.has(toolName)) {
    return status === "failed"
      ? {
          kind: "failed",
          text: `failed after ${formatDurationMilliseconds(elapsed)}`,
          title: "No command finished in this call; this is how long the call took before it failed",
        }
      : {
          kind: "returned",
          text: `returned after ${formatDurationMilliseconds(elapsed)}`,
          title: "The command was still running when this call returned; its time is shown on the call that finishes it",
        };
  }
  if (elapsed !== null) {
    return { kind: "tool", text: formatDurationMilliseconds(elapsed), title: "How long this call took" };
  }
  return { kind: "unknown", text: "Duration not recorded", title: "This result was recorded without a measured duration" };
}
