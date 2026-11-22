/** Shared API/SSE types for the claude-web UI. Mirrors docs/CONTRACT.md §5–§6. */

export interface Workspace {
  id: string;
  name: string;
  path: string;
}

export type SessionStatus = 'waiting' | 'active' | 'idle' | 'closed' | 'error';

export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  mode?: string;
  status: SessionStatus;
  lastActive?: number | string;
  createdAt?: number | string;
}

export interface ToolRequest {
  reqId: string;
  tool: string;
  input: unknown;
  cwd?: string;
  warnings?: string[];
  expiresAt?: number | string | null;
  /**
   * Read-only calls (Read/Glob/Grep) are emitted for observability with
   * `auto: true`: the runtime already allowed them, no approval is expected.
   * Approval-required calls carry `auto: false`; snapshot pending approvals
   * omit the field entirely.
   */
  auto?: boolean;
}

export interface ToolResult {
  reqId: string;
  tool: string;
  ok: boolean;
  summary?: string;
}

export interface Snapshot {
  session: SessionInfo;
  pendingApprovals: ToolRequest[];
}

/** Status of the running turn reported by the `status` SSE event. */
export type ChatStatus = 'running' | 'idle' | 'waiting_approval' | 'waiting' | 'error';

export interface HealthInfo {
  ok: boolean;
  version?: string;
  active?: number;
  max?: number;
  mode?: string;
}

export interface AuthStatus {
  ok?: boolean;
  authenticated: boolean;
  userHash?: string | null;
  totpEnrolled?: boolean;
}

export interface ResultInfo {
  text?: string;
  usage?: unknown;
  stopReason?: string;
}
