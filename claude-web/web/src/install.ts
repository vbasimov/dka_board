/**
 * Установка PWA (`/claude/`) наравне с DSH.
 *
 * DSH и Claude живут на одном origin, но это два разных устанавливаемых
 * приложения: у них разные `id`/`scope`/`start_url` (DSH — `/`, Claude —
 * `/claude/`), свои иконки и имена. Chrome (desktop) и Android поддерживают
 * несколько PWA с одного origin, если манифесты различаются.
 *
 * `beforeinstallprompt` не всегда приходит, если на origin уже стоит другое
 * приложение (вложенный scope), поэтому кнопка — подсказка, а не гарантия:
 * при её отсутствии приложение ставится через меню браузера «Установить
 * приложение»/«Добавить на главный экран».
 */

export interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
let installedDuringSession = false;
let onChange: (() => void) | null = null;
let listening = false;

export function isStandalone(): boolean {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  } catch {
    // matchMedia may be unavailable in tests/old browsers.
  }
  return (navigator as unknown as { standalone?: boolean }).standalone === true;
}

/** Кнопку «Установить» показываем только когда браузер реально готов. */
export function canInstall(): boolean {
  return deferred !== null && !installedDuringSession && !isStandalone();
}

/** Запросить установку. Возвращает итог выбора или 'unavailable'. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferred;
  if (!event) return 'unavailable';
  deferred = null;
  onChange?.();
  try {
    await event.prompt();
    const choice = await event.userChoice;
    if (choice.outcome === 'accepted') {
      installedDuringSession = true;
      onChange?.();
    }
    return choice.outcome;
  } catch {
    return 'dismissed';
  }
}

/**
 * Подписка на события установки. Возвращает функцию отписки.
 * Вызывается один раз из компонента; повторные вызовы не плодят слушатели.
 */
export function initInstallPrompt(listener: () => void): () => void {
  onChange = listener;
  if (listening) return () => {};
  listening = true;

  const onBeforeInstall = (event: Event): void => {
    // Не даём браузеру показать свой мини-infobar: покажем кнопку у себя.
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    onChange?.();
  };
  const onInstalled = (): void => {
    deferred = null;
    installedDuringSession = true;
    onChange?.();
  };

  window.addEventListener('beforeinstallprompt', onBeforeInstall);
  window.addEventListener('appinstalled', onInstalled);
  return () => {
    window.removeEventListener('beforeinstallprompt', onBeforeInstall);
    window.removeEventListener('appinstalled', onInstalled);
    listening = false;
    onChange = null;
  };
}
