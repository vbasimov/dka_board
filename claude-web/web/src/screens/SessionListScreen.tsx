import { useCallback, useEffect, useState } from 'preact/hooks';
import { describeError, isUnauthorized, type ApiClient } from '../api';
import type { SessionInfo, SessionStatus, Workspace } from '../types';

const STATUS_LABELS: Record<SessionStatus, string> = {
  waiting: 'ожидает слот',
  active: 'активна',
  idle: 'простаивает',
  closed: 'закрыта',
  error: 'ошибка',
};

function toMillis(value?: number | string): number | null {
  if (value === undefined || value === null) return null;
  const source = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(source)) return null;
  return source < 1e12 ? source * 1000 : source;
}

function formatRelative(value?: number | string): string {
  const millis = toMillis(value);
  if (millis === null) return '';
  const delta = Date.now() - millis;
  if (delta < 60_000) return 'только что';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} мин назад`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} ч назад`;
  return `${Math.floor(delta / 86_400_000)} дн назад`;
}

function baseName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export interface SessionListScreenProps {
  api: ApiClient;
  onOpen: (id: string) => void;
  onNotify: (message: string) => void;
}

export function SessionListScreen({ api, onOpen, onNotify }: SessionListScreenProps) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedCwd, setSelectedCwd] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [workspaceList, sessionList] = await Promise.all([api.workspaces(), api.sessions()]);
      setWorkspaces(workspaceList);
      setSessions(sessionList);
      setSelectedCwd((current) => current || workspaceList[0]?.path || '');
    } catch (cause) {
      if (isUnauthorized(cause)) return; // the app switches to the expired screen
      setError(describeError(cause));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const createSession = async () => {
    if (creating) return;
    if (!selectedCwd) {
      onNotify('Нет доступных workspace на сервере.');
      return;
    }
    setCreating(true);
    try {
      const session = await api.createSession(selectedCwd);
      setShowCreate(false);
      onOpen(session.id);
    } catch (cause) {
      if (isUnauthorized(cause)) return;
      onNotify(describeError(cause));
      void load();
    } finally {
      setCreating(false);
    }
  };

  const closeSession = async (session: SessionInfo) => {
    setBusyId(session.id);
    try {
      await api.closeSession(session.id);
      onNotify('Сессия закрыта. Метаданные сохранены для возобновления.');
      await load();
    } catch (cause) {
      if (!isUnauthorized(cause)) onNotify(describeError(cause));
    } finally {
      setBusyId(null);
    }
  };

  const deleteSession = async (session: SessionInfo) => {
    const confirmed = window.confirm(
      `Удалить сессию «${session.title || session.id}»? Транскрипт и метаданные будут удалены.`,
    );
    if (!confirmed) return;
    setBusyId(session.id);
    try {
      await api.deleteSession(session.id);
      onNotify('Сессия удалена.');
      await load();
    } catch (cause) {
      if (!isUnauthorized(cause)) onNotify(describeError(cause));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div class="screen list-screen">
      <header class="app-header">
        <div class="app-brand">
          <span class="brand-mark small" aria-hidden="true" />
          <div>
            <h1 class="app-title">Claude Workspace</h1>
            <p class="app-subtitle">Claude Code на своём сервере</p>
          </div>
        </div>
        <div class="header-actions">
          <button type="button" class="btn ghost small" onClick={() => void load()} disabled={loading}>
            Обновить
          </button>
          <button
            type="button"
            class="btn primary"
            onClick={() => setShowCreate((value) => !value)}
            disabled={loading || workspaces === null}
          >
            Новая сессия
          </button>
        </div>
      </header>

      {showCreate ? (
        <section class="create-panel">
          <label class="field">
            <span class="field-label">Workspace</span>
            <select
              class="select"
              value={selectedCwd}
              onChange={(event) => setSelectedCwd((event.currentTarget as HTMLSelectElement).value)}
            >
              {(workspaces ?? []).map((workspace) => (
                <option key={workspace.id} value={workspace.path}>
                  {workspace.name} — {workspace.path}
                </option>
              ))}
            </select>
          </label>
          {workspaces !== null && workspaces.length === 0 ? (
            <p class="hint">На сервере нет доступных workspace (каталог WORKSPACES пуст).</p>
          ) : null}
          <div class="screen-actions left">
            <button type="button" class="btn primary" disabled={creating || !selectedCwd} onClick={() => void createSession()}>
              {creating ? 'Создаю…' : 'Создать'}
            </button>
            <button type="button" class="btn ghost" onClick={() => setShowCreate(false)}>
              Отмена
            </button>
          </div>
        </section>
      ) : null}

      {error ? (
        <section class="notice error">
          <p>{error}</p>
          <button type="button" class="btn ghost small" onClick={() => void load()}>
            Повторить
          </button>
        </section>
      ) : null}

      {loading && sessions === null ? (
        <div class="list-loading">
          <div class="spinner" role="progressbar" aria-label="Загрузка сессий" />
        </div>
      ) : null}

      {sessions !== null && sessions.length === 0 && !error ? (
        <section class="empty-state">
          <p class="empty-title">Сессий пока нет</p>
          <p class="muted">Создайте новую сессию и выберите каталог проекта.</p>
        </section>
      ) : null}

      {sessions !== null && sessions.length > 0 ? (
        <ul class="session-list">
          {sessions.map((session) => {
            const busy = busyId === session.id;
            return (
              <li class="session-row" key={session.id}>
                <button type="button" class="session-open" onClick={() => onOpen(session.id)} disabled={busy}>
                  <span class="session-main">
                    <span class="session-title">{session.title || 'Без названия'}</span>
                    <span class="session-meta">
                      {baseName(session.cwd || '')}
                      {formatRelative(session.lastActive ?? session.createdAt)
                        ? ` · ${formatRelative(session.lastActive ?? session.createdAt)}`
                        : ''}
                    </span>
                  </span>
                  <span class={['status-chip', `status-${session.status}`].join(' ')}>
                    {STATUS_LABELS[session.status] ?? session.status}
                  </span>
                </button>
                <div class="session-actions">
                  <button
                    type="button"
                    class="btn ghost small"
                    disabled={busy || session.status === 'closed'}
                    onClick={() => void closeSession(session)}
                  >
                    Закрыть
                  </button>
                  <button type="button" class="btn danger small" disabled={busy} onClick={() => void deleteSession(session)}>
                    Удалить
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
