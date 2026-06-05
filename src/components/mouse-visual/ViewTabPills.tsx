// The view-mode tab strip (Combined / Top / Side) shared by both visualizers.
// The pill-track itself is identical in both; mode-toggle buttons (photo ↔
// schematic) stay in each consumer's nav next to this.

import { useTranslation } from "react-i18next";
import type { ViewTab } from "../../lib/mouse-visual";

interface ViewTabPillsProps {
  activeTab: ViewTab;
  onSelect: (tab: ViewTab) => void;
}

export function ViewTabPills({ activeTab, onSelect }: ViewTabPillsProps) {
  const { t } = useTranslation();
  const viewTabs: { key: ViewTab; label: string }[] = [
    { key: "combined", label: t("visualization.tabAll") },
    { key: "top", label: t("visualization.tabTop") },
    { key: "side", label: t("visualization.tabSide") },
  ];
  const viewIdx = viewTabs.findIndex((tab) => tab.key === activeTab);
  return (
    <div
      className="pill-track"
      ref={(el) => {
        if (el) el.style.setProperty("--pill-count", String(viewTabs.length));
      }}
    >
      {viewIdx >= 0 ? (
        <div
          className="pill-track__indicator"
          ref={(el) => {
            if (el) el.style.setProperty("--pill-offset", `${viewIdx * 100}%`);
          }}
        />
      ) : null}
      {viewTabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          aria-pressed={tab.key === activeTab}
          className={`pill-track__pill${tab.key === activeTab ? " pill-track__pill--active" : ""}`}
          onClick={() => onSelect(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
