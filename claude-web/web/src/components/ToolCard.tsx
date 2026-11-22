import { useEffect, useState } from 'preact/hooks';
import { needsApproval } from '../timeline';
import type { ToolRequest, ToolResult } from '../types';

/** Timeline entry for one tool request/approval/result cycle. */
export interface ToolEntry {
  kind: 'tool';
  id: string;
  request: ToolRequest;
  decision?: 'allow' | 'deny';
  submitting?: boolean;
  result?: ToolResult;
}

function toMillis(value: number | string | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  const source = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(source)) return null;
  // Values below ~1e12 are seconds, not milliseconds.
  return source < 1e12 ? source * 1000 : source;
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function prettyInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    const text = JSON.stringify(input, null, 2);
    if (text === undefined) return String(input);
    return text.length > 12000 ? `${text.slice(0, 12000)}\n… (вход усечён для отображения)` : text;
  } catch {
    return String(input);
  }
}

export interface ToolCardProps {
  entry: ToolEntry;
  onDecision: (decision: 'allow' | 'deny') => void;
}

export function ToolCard({ entry, onDecision }: ToolCardProps) {
  const expiresAt = toMillis(entry.request.expiresAt);
  // Read-only tools are emitted with auto:true: informational card, no buttons.
  const auto = !needsApproval(entry.request);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (expiresAt === null || entry.decision || entry.result) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, entry.decision, entry.result]);

  const remaining = expiresAt === null ? null : expiresAt - now;
  const toolExpired = entry.decision === undefined && entry.result === undefined && remaining !== null && remaining <= 0;
  const canDecide = !auto && entry.decision === undefined && entry.result === undefined && !toolExpired;
  const warnings = entry.request.warnings ?? [];
  const pendingLabel = entry.submitting ? 'Отправка…' : null;

  return (
    <section
      class={[
        'tool-card',
        auto ? 'auto-card' : '',
        entry.decision ? `decision-${entry.decision}` : '',
        toolExpired ? 'expired' : '',
      ].join(' ').trim()}
    >
      <header class="tool-card-header">
        <span class="tool-icon" aria-hidden="true">⚙</span>
        <span class="tool-name">{entry.request.tool}</span>
        {auto ? <span class="tool-badge auto">авто</span> : null}
        {entry.decision === 'allow' ? <span class="tool-badge allow">разрешено</span> : null}
        {entry.decision === 'deny' ? <span class="tool-badge deny">запрещено</span> : null}
        {toolExpired ? <span class="tool-badge deny">истекло</span> : null}
        {entry.result ? (
          <span class={['tool-badge', entry.result.ok ? 'allow' : 'deny'].join(' ')}>
            {entry.result.ok ? 'выполнено' : 'отклонено'}
          </span>
        ) : null}
      </header>

      {entry.request.cwd ? (
        <div class="tool-row">
          <span class="tool-label">cwd</span>
          <code class="tool-cwd">{entry.request.cwd}</code>
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <ul class="tool-warnings">
          {warnings.map((warning) => (
            <li key={warning}>⚠ {warning}</li>
          ))}
        </ul>
      ) : null}

      <details class="tool-input" open={warnings.length > 0 || auto}>
        <summary>Вход инструмента</summary>
        <pre>{prettyInput(entry.request.input)}</pre>
      </details>

      {entry.result?.summary ? <p class="tool-summary">{entry.result.summary}</p> : null}

      {canDecide ? (
        <div class="tool-actions">
          <button type="button" class="btn primary" disabled={entry.submitting} onClick={() => onDecision('allow')}>
            Разрешить
          </button>
          <button type="button" class="btn danger" disabled={entry.submitting} onClick={() => onDecision('deny')}>
            Запретить
          </button>
          {remaining !== null ? <span class="tool-timer">осталось {formatRemaining(remaining)}</span> : null}
          {pendingLabel ? <span class="tool-timer">{pendingLabel}</span> : null}
        </div>
      ) : null}

      {entry.decision && !entry.result ? (
        <p class="tool-pending">{entry.decision === 'allow' ? 'Ожидаю выполнения…' : 'Запрос отклонён.'}</p>
      ) : null}

      {auto && !entry.result ? (
        <p class="tool-pending">Автоматический вызов — подтверждение не требуется.</p>
      ) : null}
    </section>
  );
}
