/**
 * A bounded, isolated compute lease (Modal Sandbox in production). Used by:
 *  - build workspaces: trace inputs + pinned published memory read-only, draft writable;
 *  - customer workspaces: published memory read-only, private $WORK/scratch writable.
 *
 * Rules every implementation must follow (ported from AEye/Silicon workspace
 * protection patterns, not a shell-string denylist):
 *  - Paths are validated by the host before use and passed only as argv
 *    elements or filesystem-API paths; scripts are passed as a single argv
 *    element (`bash -c <script>`), never interpolated into another command.
 *  - Agent-authored commands run as an unprivileged uid; protected trees are
 *    root-owned and read-only (enforced by the OS, verified at setup).
 *  - Outbound network is blocked; no host credentials or model keys are
 *    injected into the sandbox environment.
 *  - Every exec has a deadline and bounded stdout/stderr capture.
 *  - terminate() is idempotent and always called from a finally block.
 */
export interface SandboxLease {
  readonly provider: "modal" | "local";
  readonly id: string;
  /** Write files as root (setup). Parent directories are created. */
  writeFiles(files: ReadonlyArray<{ path: string; content: string | Uint8Array }>): Promise<void>;
  /** Recursively make absolute directory read-only and root-owned (setup); verifies the unprivileged user cannot write. */
  protectTree(absDir: string): Promise<void>;
  /** Create a directory owned by the unprivileged agent user. */
  makeAgentDir(absDir: string): Promise<void>;
  /** One-shot command with deadline and bounded output. */
  exec(argv: string[], opts: ExecOptions): Promise<ExecResult>;
  /** Long-running command with a durable handle (poll/stdin/cancel). */
  start(argv: string[], opts: ExecOptions): Promise<CommandHandle>;
  terminate(): Promise<void>;
}

export interface ExecOptions {
  /** "agent" = unprivileged uid; "root" only for host-owned setup/inspection. */
  user: "agent" | "root";
  cwd?: string;
  timeoutMs: number;
  stdin?: string;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export interface CommandHandle {
  readonly commandId: string;
  /** New output since the previous poll (bounded), and the final status once finished. */
  poll(waitMs: number): Promise<CommandPoll>;
  writeStdin(text: string, close: boolean): Promise<void>;
  cancel(): Promise<void>;
}

export interface CommandPoll {
  commandId: string;
  running: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
}
