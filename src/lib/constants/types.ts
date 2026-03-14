import type {
  Action,
  ActionType,
  Binding,
  EncoderMapping,
  PhysicalControl,
} from "../config";

export type ViewState = "idle" | "loading" | "ready" | "saving" | "error";
export type WorkspaceMode = "profiles" | "debug" | "settings";

export type FamilySection = {
  family: string;
  entries: ControlSurfaceEntry[];
};

export type ControlSurfaceEntry = {
  control: PhysicalControl;
  binding: Binding | null;
  action: Action | null;
  mapping: EncoderMapping | null;
  isSelected: boolean;
};

export type HotspotPosition = { left: number; top: number; label: string; size?: "sm" | "lg" };

export type CalloutAnchor = HotspotPosition & {
  calloutSide: "left" | "right";
};

export type ActionCategory = {
  id: string;
  icon: string;
  label: string;
  actionType: ActionType;
};
