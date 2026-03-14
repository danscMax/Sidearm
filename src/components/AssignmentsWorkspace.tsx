import { startTransition } from "react";
import type {
  Action,
  AppConfig,
  Binding,
  ControlId,
  Layer,
  PhysicalControl,
} from "../lib/config";
import type { ControlSurfaceEntry } from "../lib/constants";
import { useActionPicker } from "../hooks/useActionPicker";
import { MouseVisualization } from "./MouseVisualization";

export interface FamilySection {
  family: string;
  entries: ControlSurfaceEntry[];
}

export interface AssignmentsWorkspaceProps {
  effectiveProfileId: string | null;
  selectedLayer: Layer;
  selectedControl: PhysicalControl | null;
  selectedBinding: Binding | null;
  selectedAction: Action | null;
  multiSelectedControlIds: Set<ControlId>;
  familySections: FamilySection[];
  activeProfileName: string | null;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
  setSelectedControlId: (id: ControlId | null) => void;
  setMultiSelectedControlIds: (ids: Set<ControlId> | ((prev: Set<ControlId>) => Set<ControlId>)) => void;
  onSelectLayer: (layer: Layer) => void;
  setActionPickerBindingId: (id: string | null) => void;
  setActionPickerOpen: (open: boolean) => void;
}

export function AssignmentsWorkspace({
  effectiveProfileId,
  selectedLayer,
  selectedControl: _selectedControl,
  selectedBinding: _selectedBinding,
  selectedAction: _selectedAction,
  multiSelectedControlIds,
  familySections,
  activeProfileName: _activeProfileName,
  updateDraft,
  onSelectLayer,
  setSelectedControlId,
  setMultiSelectedControlIds,
  setActionPickerBindingId,
  setActionPickerOpen,
}: AssignmentsWorkspaceProps) {
  const handleOpenActionPicker = useActionPicker({
    effectiveProfileId,
    selectedLayer,
    updateDraft,
    setActionPickerBindingId,
    setActionPickerOpen,
  });

  return (
    <div className="workspace__center" data-layer={selectedLayer}>
      <MouseVisualization
        entries={familySections.flatMap((section) => section.entries)}
        selectedLayer={selectedLayer}
        multiSelectedControlIds={multiSelectedControlIds}
        onSelectControl={(id) => {
          startTransition(() => {
            setSelectedControlId(id);
            setMultiSelectedControlIds(new Set());
          });
        }}
        onToggleMultiSelect={(id) => {
          setMultiSelectedControlIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
        }}
        onOpenActionPicker={handleOpenActionPicker}
        onSelectLayer={onSelectLayer}
      />
    </div>
  );
}
