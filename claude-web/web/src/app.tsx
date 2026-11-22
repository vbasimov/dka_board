import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { ApiClient, describeError, isUnauthorized } from './api';
import { UpdateBanner } from './components/UpdateBanner';
import { BootScreen } from './screens/BootScreen';
import { ChatScreen } from './screens/ChatScreen';
import { ExpiredScreen } from './screens/ExpiredScreen';
import { ServerDownScreen } from './screens/ServerDownScreen';
import { SessionListScreen } from './screens/SessionListScreen';
import { applyServiceWorkerUpdate, initServiceWorker } from './sw-register';

type Phase =
  | { kind: 'boot' }
  | { kind: 'ready' }
  | { kind: 'expired' }
  | { kind: 'unavailable'; message: string };

const SESSION_HASH = /^#\/s\/([A-Za-z0-9_-]{1,64})$/;

/** `#/s/<id>` keeps the current session across a PWA relaunch without server routing. */
function sessionFromHash(): string | null {
  const match = SESSION_HASH.exec(window.location.hash || '');
  return match ? match[1] : null;
}

export function App() {
  const api = useMemo(() => new ApiClient(), []);
  const [phase, setPhase] = useState<Phase>({ kind: 'boot' });
  const [sessionId, setSessionId] = useState<string | null>(() => sessionFromHash());
  const [updateReady, setUpdateReady] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const notify = useCallback((message: string) => setToast(message), []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const handleExpired = useCallback(() => setPhase({ kind: 'expired' }), []);

  // Any 401 from the API client switches to the expired screen (which closes SSE by unmounting).
  useEffect(() => {
    api.setUnauthorizedHandler(handleExpired);
    return () => api.setUnauthorizedHandler(null);
  }, [api, handleExpired]);

  const boot = useCallback(async () => {
    setPhase({ kind: 'boot' });
    try {
      await api.health();
      setPhase({ kind: 'ready' });
    } catch (cause) {
      if (isUnauthorized(cause)) setPhase({ kind: 'expired' });
      else setPhase({ kind: 'unavailable', message: describeError(cause) });
    }
  }, [api]);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    const onHashChange = () => setSessionId(sessionFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Heartbeat every 60 s: keeps the session alive through Caddy and tells the
  // server this tab is still reading the SSE stream. 401 ends the session.
  useEffect(() => {
    if (phase.kind !== 'ready') return undefined;
    let disposed = false;
    const beat = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        await api.heartbeat();
      } catch (cause) {
        if (!disposed && isUnauthorized(cause)) handleExpired();
      }
    };
    const timer = window.setInterval(() => void beat(), 60_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void beat();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void beat();
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [api, handleExpired, phase.kind]);

  useEffect(() => {
    initServiceWorker({ onUpdateAvailable: () => setUpdateReady(true) });
  }, []);

  const openSession = useCallback((id: string) => {
    window.location.hash = `#/s/${id}`;
  }, []);

  const backToList = useCallback(() => {
    window.location.hash = '';
  }, []);

  const onApplyUpdate = useCallback(() => {
    if (!applyServiceWorkerUpdate()) setUpdateReady(false);
  }, []);

  return (
    <div class="app">
      {phase.kind === 'boot' ? <BootScreen /> : null}

      {phase.kind === 'expired' ? <ExpiredScreen api={api} onRetry={() => void boot()} /> : null}

      {phase.kind === 'unavailable' ? (
        <ServerDownScreen message={phase.message} onRetry={() => void boot()} />
      ) : null}

      {phase.kind === 'ready' && sessionId === null ? (
        <SessionListScreen api={api} onOpen={openSession} onNotify={notify} />
      ) : null}

      {phase.kind === 'ready' && sessionId !== null ? (
        <ChatScreen
          key={sessionId}
          api={api}
          sessionId={sessionId}
          onBack={backToList}
          onExpired={handleExpired}
          onNotify={notify}
        />
      ) : null}

      {phase.kind === 'ready' && updateReady ? (
        <UpdateBanner onApply={onApplyUpdate} onLater={() => setUpdateReady(false)} />
      ) : null}

      {toast ? (
        <div class="toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
