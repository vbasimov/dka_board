/**
 * HTTP client for the claude-web API (CONTRACT.md §6).
 *
 * - JSON only; POST always carries `Content-Type: application/json` (the server
 *   enforces it for unsafe methods), GET sends an `Accept` header.
 * - Non-2xx responses carry `{error, code}`; they are surfaced as `ApiError`.
 * - 401 means the gateway session is gone: the client notifies the app once so
 *   it can close the SSE stream and switch to the "session expired" screen.
 * - Network failures and 5xx become `NetworkError`/`ApiError`, and
 *   `describeError()` turns both into Russian human text for toasts/screens.
 */
import type { AuthStatus, HealthInfo, ResultInfo, SessionInfo, Snapshot, ToolRequest, Workspace } from './types';

/** `/claude/` in production, whatever `base` the build used. */
export const BASE_URL: string = import.meta.env.BASE_URL || '/claude/';
/** Trailing slash matters: request paths are appended verbatim. */
const API_ROOT = `${BASE_URL.replace(/\/+$/, '')}/api/`;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export class NetworkError extends Error {
  constructor(message = 'Сервер недоступен. Проверьте сеть и повторите.') {
    super(message);
    this.name = 'NetworkError';
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function isUnauthorized(error: unknown): boolean {
  return isApiError(error) && error.status === 401;
}

const DEFAULT_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'limit',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
  500: 'internal',
};

/** Human Russian message for any failure; never leaks a token or a stack. */
export function describeError(error: unknown): string {
  if (error instanceof NetworkError) return error.message;
  if (isApiError(error)) {
    switch (error.status) {
      case 401:
        return 'Сессия истекла. Войдите заново.';
      case 403:
        return 'Доступ запрещён.';
      case 404:
        return 'Сессия не найдена.';
      case 409:
        return 'Достигнут лимит активных сессий (2). Закройте другую сессию.';
      case 413:
        return 'Слишком большое сообщение: максимум 32 КБ.';
      case 415:
        return 'Неверный формат запроса.';
      case 429:
        return 'Слишком часто. Подождите несколько секунд.';
      default:
        if (error.status >= 500) return 'Сервер недоступен. Попробуйте ещё раз.';
        return error.message || 'Не удалось выполнить запрос.';
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Неизвестная ошибка.';
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export class ApiClient {
  private readonly root: string;
  private unauthorizedHandler: (() => void) | null = null;
  private unauthorizedNotified = false;

  constructor(root: string = API_ROOT) {
    this.root = root;
  }

  setUnauthorizedHandler(handler: (() => void) | null): void {
    this.unauthorizedHandler = handler;
  }

  /** Reset by the app when a session becomes valid again (e.g. after reload). */
  private notifyUnauthorized(): void {
    if (this.unauthorizedNotified) return;
    this.unauthorizedNotified = true;
    this.unauthorizedHandler?.();
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    } else if (method !== 'GET') {
      // The server requires JSON content type on every unsafe method.
      headers['Content-Type'] = 'application/json';
      body = '{}';
    }

    let response: Response;
    try {
      response = await fetch(this.root + path, {
        method,
        headers,
        body,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: options.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new NetworkError();
    }

    if (!response.ok) {
      let code = DEFAULT_CODES[response.status] ?? `http_${response.status}`;
      let message = response.statusText;
      try {
        const data = (await response.json()) as { error?: unknown; code?: unknown };
        if (typeof data?.code === 'string' && data.code) code = data.code;
        if (typeof data?.error === 'string' && data.error) message = data.error;
      } catch {
        // Non-JSON error body (e.g. a gateway HTML page): keep the HTTP defaults.
      }
      if (response.status === 401) this.notifyUnauthorized();
      throw new ApiError(message || `HTTP ${response.status}`, response.status, code);
    }

    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      // Should not happen for our API; keep the caller from crashing on HTML.
      throw new ApiError('Неожиданный ответ сервера.', response.status, 'unexpected_body');
    }
    return (await response.json()) as T;
  }

  health(): Promise<HealthInfo> {
    return this.request<HealthInfo>('health');
  }

  workspaces(): Promise<Workspace[]> {
    return this.request<Workspace[]>('workspaces');
  }

  async sessions(): Promise<SessionInfo[]> {
    const data = await this.request<SessionInfo[] | { sessions: SessionInfo[] }>('sessions');
    return Array.isArray(data) ? data : (data?.sessions ?? []);
  }

  async createSession(cwd: string): Promise<{ id: string }> {
    // The server answers 201 {id}; only the id is needed to open the new session.
    const data = await this.request<{ id?: unknown }>('sessions', {
      method: 'POST',
      body: { cwd },
    });
    return { id: String(data?.id ?? '') };
  }

  getSession(id: string): Promise<Snapshot> {
    return this.request<Snapshot>(`sessions/${encodeURIComponent(id)}`);
  }

  sendMessage(id: string, text: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`sessions/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: { text },
    });
  }

  resolveApproval(
    id: string,
    reqId: string,
    decision: 'allow' | 'deny',
    reason?: string,
  ): Promise<{ ok: boolean }> {
    const body: { decision: 'allow' | 'deny'; reason?: string } = { decision };
    if (reason) body.reason = reason;
    return this.request<{ ok: boolean }>(
      `sessions/${encodeURIComponent(id)}/approvals/${encodeURIComponent(reqId)}`,
      { method: 'POST', body },
    );
  }

  interrupt(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`sessions/${encodeURIComponent(id)}/interrupt`, { method: 'POST' });
  }

  closeSession(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`sessions/${encodeURIComponent(id)}/close`, { method: 'POST' });
  }

  deleteSession(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  heartbeat(): Promise<{ ok: boolean; ts?: number }> {
    return this.request<{ ok: boolean; ts?: number }>('heartbeat', { method: 'POST' });
  }

  /**
   * Gateway status probe, used by the "session expired" screen. This path is
   * served by the auth gateway, not by the Claude app, so it bypasses `API_ROOT`.
   */
  async authStatus(): Promise<AuthStatus> {
    try {
      const response = await fetch('/auth/status', {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) return { authenticated: false };
      const data = (await response.json()) as AuthStatus;
      return { ...data, authenticated: Boolean(data?.authenticated) };
    } catch {
      return { authenticated: false };
    }
  }
}

export type { ResultInfo, Snapshot, ToolRequest };
