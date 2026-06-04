import { useTranslation } from "react-i18next";
import type { Profile } from "../../lib/config";

export function ProfileSwitchEditor({
  value,
  onChange,
  profiles,
}: {
  value: string;
  onChange: (value: string) => void;
  profiles: Profile[];
}) {
  const { t } = useTranslation();
  return (
    <div className="editor-grid">
      <label className="field">
        <span className="field__label">{t("picker.switchProfile")}</span>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
