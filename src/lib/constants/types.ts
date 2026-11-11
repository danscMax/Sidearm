import type {
  Action,
  ActionType,
  Binding,
  EncoderMapping,
  Layer,
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
  /** Derived from current settings, never persisted as a binding or control. */
  isHypershiftTrigger?: boolean;
  /** With `isHypershiftTrigger`: the profile's HyperShift 2 trigger, not HyperShift. */
  isHypershift2Trigger?: boolean;
  /** No assignment of its own on this layer: what a press plays instead,
   *  from the layer below (HyperShift layers fall back). */
  fallback?: { action: Action; layer: Layer } | null;
};

export type HotspotPosition = { left: number; top: number; label: string; size?: "sm" | "lg" };

export type ActionCategory = {
  id: string;
  icon: string;
  label: string;
  actionType: ActionType;
};
