import { useTranslation } from "react-i18next";
import type { ActionCondition } from "../../lib/config";
import { CONDITION_TYPE_KEYS } from "../../lib/action-picker-helpers";

export function ConditionsEditor({
  conditions,
  onChange,
}: {
  conditions: ActionCondition[];
  onChange: (conditions: ActionCondition[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="editor-grid mt-12">
      <div className="field__header">
        <span className="field__label">{t("picker.conditionsLabel")}</span>
        <button
          type="button"
          className="action-button action-button--secondary action-button--small"
          onClick={() => onChange([...conditions, { type: "windowTitleContains", value: "" }])}
        >
          {t("picker.conditionsAdd")}
        </button>
      </div>

      {conditions.length === 0 ? (
        <p className="panel__muted">
          {t("picker.conditionsEmpty")}
        </p>
      ) : (
        <div className="stack-list">
          {conditions.map((condition, index) => (
            <div className="compound-card" key={index}>
              <div className="compound-card__header">
                <strong>{t("picker.conditionTitle", { index: index + 1 })}</strong>
                <button
                  type="button"
                  className="action-button action-button--secondary action-button--small"
                  onClick={() => onChange(conditions.filter((_, i) => i !== index))}
                >
                  {t("common.delete")}
                </button>
              </div>
              <div className="editor-grid">
                <label className="field">
                  <span className="field__label">{t("picker.conditionType")}</span>
                  <select
                    value={condition.type}
                    onChange={(e) => {
                      const nextType = e.target.value as ActionCondition["type"];
                      onChange(
                        conditions.map((c, i) =>
                          i === index ? { type: nextType, value: c.value } : c,
                        ),
                      );
                    }}
                  >
                    {CONDITION_TYPE_KEYS.map((ct) => (
                      <option key={ct.value} value={ct.value}>
                        {t(ct.key)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">{t("picker.conditionValue")}</span>
                  <input
                    type="text"
                    value={condition.value}
                    placeholder={
                      condition.type.startsWith("exe")
                        ? t("picker.conditionPlaceholderExe")
                        : t("picker.conditionPlaceholderTitle")
                    }
                    onChange={(e) =>
                      onChange(
                        conditions.map((c, i) =>
                          i === index ? { ...c, value: e.target.value } : c,
                        ),
                      )
                    }
                  />
                </label>
              </div>
            </div>
          ))}
          <p className="panel__muted">
            {t("picker.conditionsAllRequired")}
          </p>
        </div>
      )}
    </div>
  );
}
