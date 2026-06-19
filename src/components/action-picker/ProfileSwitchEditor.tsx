import { useTranslation } from "react-i18next";
import type { Profile } from "../../lib/config";
import { SelectField } from "../shared";

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
      <SelectField
        label={t("picker.switchProfile")}
        value={value}
        onChange={onChange}
        options={profiles.map((p) => ({ value: p.id, label: p.name }))}
      />
    </div>
  );
}
