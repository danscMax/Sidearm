import { open } from "@tauri-apps/plugin-dialog";
import { PathField } from "./PathField";

/** Thin wrapper over PathField that browses for a directory. */
export function DirectoryPathField({
  label,
  value,
  onChange,
  browseTitle,
  browseLabel,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  browseTitle: string;
  browseLabel: string;
  placeholder?: string;
}) {
  return (
    <PathField
      label={label}
      value={value}
      onChange={onChange}
      browseLabel={browseLabel}
      placeholder={placeholder}
      browse={async () => {
        const selected = await open({ title: browseTitle, directory: true, multiple: false });
        return typeof selected === "string" ? selected : null;
      }}
    />
  );
}
