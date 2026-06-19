import { pickExecutablePath } from "../lib/backend";
import { PathField } from "./PathField";

const DEFAULT_EXE_EXTENSIONS = ["exe", "lnk", "bat", "cmd"];

/** Thin wrapper over PathField that browses for an executable. */
export function ExecutablePathField({
  label,
  value,
  onChange,
  browseTitle,
  filterName,
  browseLabel,
  placeholder = "C:\\Program Files\\app.exe",
  extensions = DEFAULT_EXE_EXTENSIONS,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  browseTitle: string;
  filterName: string;
  browseLabel: string;
  placeholder?: string;
  extensions?: string[];
}) {
  return (
    <PathField
      label={label}
      value={value}
      onChange={onChange}
      browseLabel={browseLabel}
      placeholder={placeholder}
      browse={async () => {
        const pick = await pickExecutablePath({ title: browseTitle, filterName, extensions });
        return pick?.path ?? null;
      }}
    />
  );
}
