// The view-mode tab strip (Combined / Top / Side) shared by both visualizers.
// The pill-track itself is identical in both; mode-toggle buttons (photo ↔
// schematic) stay in each consumer's nav next to this.

import { useTranslation } from "react-i18next";
import type { ViewTab } from "../../lib/mouse-visual";
import { PillTrack } from "../PillTrack";

interface ViewTabPillsProps {
  activeTab: ViewTab;
  onSelect: (tab: ViewTab) => void;
  /** Tabs in display order; the default is the V2 photo set. */
  views?: readonly ViewTab[];
  /** i18n keys that replace the default tab labels. */
  labels?: Partial<Record<ViewTab, string>>;
}

const DEFAULT_LABELS: Record<ViewTab, string> = {
  combined: "visualization.tabAll",
  top: "visualization.tabTop",
  side: "visualization.tabSide",
  bottom: "visualization.v3Bottom",
};

export function ViewTabPills({ activeTab, onSelect, views = ["combined", "top", "side"], labels }: ViewTabPillsProps) {
  const { t } = useTranslation();
  return (
    <PillTrack
      active={activeTab}
      onSelect={onSelect}
      items={views.map((key) => ({ key, label: t(labels?.[key] ?? DEFAULT_LABELS[key]) }))}
    />
  );
}
