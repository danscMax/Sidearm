import { useTranslation } from "react-i18next";
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

export function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={`fact${mono ? " fact--mono" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
}) {
  return (
    <label className="toggle-switch">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={ariaLabel}
      />
      <span className="toggle-switch__track">
        <span className="toggle-switch__knob">
          <svg className="toggle-switch__icon" viewBox="0 0 12 12" aria-hidden="true">
            {checked ? (
              <polyline points="2.5 6 5 8.5 9.5 3.5" />
            ) : (
              <>
                <line x1="3" y1="3" x2="9" y2="9" />
                <line x1="9" y1="3" x2="3" y2="9" />
              </>
            )}
          </svg>
        </span>
      </span>
    </label>
  );
}

export function WarningsPanel({ warnings }: { warnings: ValidationWarning[] }) {
  const { t } = useTranslation();
  return (
    <div className="notice notice--warning">
      <strong>{t("shared.warnings")}</strong>
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
