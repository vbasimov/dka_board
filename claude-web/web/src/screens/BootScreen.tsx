export function BootScreen() {
  return (
    <main class="screen centered">
      <div class="brand-mark" aria-hidden="true" />
      <h1 class="screen-title">Claude Workspace</h1>
      <p class="muted">Подключаюсь к серверу…</p>
      <div class="spinner" role="progressbar" aria-label="Загрузка" />
    </main>
  );
}
