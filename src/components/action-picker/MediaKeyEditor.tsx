import type { MediaKeyKind } from "../../lib/config";
import { MEDIA_KEY_OPTIONS } from "../../lib/constants";
import { PickerGrid } from "./shared/PickerGrid";

export function MediaKeyEditor({
  value,
  onChange,
}: {
  value: MediaKeyKind;
  onChange: (value: MediaKeyKind) => void;
}) {
  return (
    <div className="editor-grid">
      <PickerGrid options={MEDIA_KEY_OPTIONS} value={value} onChange={onChange} />
    </div>
  );
}
