import { useEffect, useRef, useState } from 'preact/hooks';
import { BASE_URL, type ApiClient } from '../api';

export interface ExpiredScreenProps {
  api: ApiClient;
  onRetry: () => void;
}

/**
 * Gateway session ended. `/auth/tg` opens the shared login page; while it is
 * open we poll `/auth/status` (it is the auth gateway's own public endpoint, not
 * `/claude/api`) and reload `/claude/` as soon as the session is valid again —
 * the gateway currently ignores `next`, so polling is the only automatic way
 * back into the app.
 */
export function ExpiredScreen({ api, onRetry }: ExpiredScreenProps) {
  const [checking, setChecking] = useState(false);
  const [lastCheck, setLastCheck] = useState<string | null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    stoppedRef.current = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      if (stoppedRef.current) return;
      if (document.visibilityState !== 'visible') return;
      const status = await api.authStatus();
      if (stoppedRef.current) return;
      setLastCheck(new Date().toLocaleTimeString('ru-RU'));
      if (status.authenticated) {
        stoppedRef.current = true;
        // Full reload: the SPA behind /claude/ has to be fetched with the new session.
        window.location.replace(BASE_URL);
      }
    };

    timer = window.setInterval(() => {
      setChecking(true);
      void poll().finally(() => {
        if (!stoppedRef.current) setChecking(false);
      });
    }, 4000);
    void poll();

    return () => {
      stoppedRef.current = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [api]);

  return (
    <main class="screen centered">
      <div class="brand-mark expired" aria-hidden="true" />
      <h1 class="screen-title">Сессия завершилась</h1>
      <p class="muted">Шлюз авторизации закрыл сессию. Войдите снова, чтобы продолжить в этом окне.</p>

      <div class="screen-actions">
        <a class="btn primary" href="/auth/tg" target="_blank" rel="noopener noreferrer">
          Войти
        </a>
        <button type="button" class="btn ghost" onClick={onRetry}>
          Повторить
        </button>
      </div>

      <p class="hint">
        Вход откроется на странице шлюза. Как только он подтвердит сессию, приложение перезагрузится само.
        {lastCheck ? ` Последняя проверка: ${lastCheck}.` : ''}
        {checking ? ' Проверяю…' : ''}
      </p>
    </main>
  );
}
