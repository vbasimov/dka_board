export interface ServerDownScreenProps {
  message: string;
  onRetry: () => void;
}

/** Network failure or 5xx at startup. Retry is manual on purpose: the shared
 *  `/verify` bucket in front of DSH must not be hammered by a reload loop. */
export function ServerDownScreen({ message, onRetry }: ServerDownScreenProps) {
  return (
    <main class="screen centered">
      <div class="brand-mark offline" aria-hidden="true" />
      <h1 class="screen-title">Сервер недоступен</h1>
      <p class="muted">{message}</p>
      <p class="hint">Проверьте сеть или подключение Tailscale, затем повторите попытку.</p>
      <div class="screen-actions">
        <button type="button" class="btn primary" onClick={onRetry}>
          Повторить
        </button>
      </div>
    </main>
  );
}
