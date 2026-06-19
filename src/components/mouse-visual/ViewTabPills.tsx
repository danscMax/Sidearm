// The view-mode tab strip (Combined / Top / Side) shared by both visualizers.
// The pill-track itself is identical in both; mode-toggle buttons (photo ↔
// schematic) stay in each consumer's nav next to this.

import { useTranslation } from "react-i18next";
import type { ViewTab } from "../../lib/mouse-visual";
import { PillTrack } from "../PillTrack";

interface ViewTabPillsProps {
  activeTab: ViewTab;
  onSelect: (tab: ViewTab) => void;
}

export function ViewTabPills({ activeTab, onSelect }: ViewTabPillsProps) {
  const { t } = useTranslation();
  return (
    <PillTrack
      active={activeTab}
      onSelect={onSelect}
      items={[
        { key: "combined", label: t("visualization.tabAll") },
        { key: "top", label: t("visualization.tabTop") },
        { key: "side", label: t("visualization.tabSide") },
      ]}
    />
  );
}
