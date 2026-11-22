export interface UpdateBannerProps {
  onApply: () => void;
  onLater: () => void;
}

/** Shown when a new service worker is installed and waiting. */
export function UpdateBanner({ onApply, onLater }: UpdateBannerProps) {
  return (
    <div class="update-banner" role="status">
      <span class="update-text">Доступно обновление</span>
      <div class="update-actions">
        <button type="button" class="btn primary small" onClick={onApply}>
          Обновить
        </button>
        <button type="button" class="btn ghost small" onClick={onLater}>
          Позже
        </button>
      </div>
    </div>
  );
}
