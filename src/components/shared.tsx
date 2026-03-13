import type { ValidationWarning, CommandError } from "../lib/config";

export function PanelGroup({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="panel-group" open={defaultOpen || undefined}>
      <summary>{title}</summary>
      <div className="panel-group__body">{children}</div>
    </details>
  );
}

export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function WarningsPanel({ warnings }: { warnings: ValidationWarning[] }) {
  return (
    <div className="notice notice--warning">
      <strong>Предупреждения проверки</strong>
      <ul>
        {warnings.map((warning) => (
          <li key={`${warning.code}-${warning.path ?? warning.message}`}>
            <span>{warning.message}</span>
            {warning.path ? <code>{warning.path}</code> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ErrorPanel({ error }: { error: CommandError }) {
  return (
    <div className="notice notice--error">
      <strong>{error.code}</strong>
      <p>{error.message}</p>
      {error.details?.length ? (
        <ul>
          {error.details.map((detail) => (
            <li key={detail}>
              <code>{detail}</code>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

