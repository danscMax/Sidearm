import type {
  Action,
  AppConfig,
  Binding,
  CapabilityStatus,
  EncoderMapping,
  Layer,
  PhysicalControl,
  SnippetLibraryItem,
} from "../lib/config";
import {
  ensureEncoderMapping,
  updateControlCapabilityStatus,
  upsertEncoderMapping,
} from "../lib/config-editing";
import {
  describeActionSummary,
  labelForCapability,
  labelForControlFamily,
  labelForEncoderSource,
} from "../lib/helpers";
import { Fact } from "./shared";

export interface ControlPropertiesPanelProps {
  selectedLayer: Layer;
  selectedControl: PhysicalControl | null;
  selectedBinding: Binding | null;
  selectedAction: Action | null;
  selectedEncoder: EncoderMapping | null;
  snippetById: Map<string, SnippetLibraryItem>;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
}

export function ControlPropertiesPanel({
  selectedLayer,
  selectedControl,
  selectedBinding,
  selectedAction,
  selectedEncoder,
  snippetById,
  updateDraft,
}: ControlPropertiesPanelProps) {
  return (
    <>
      <section className="panel panel--accent">
        <p className="panel__eyebrow">Свойства кнопки</p>
        {selectedControl ? (
          <>
            <h2>{selectedControl.defaultName}</h2>
            <p className="inspector__lede">
              {selectedControl.notes ??
                "Для этой кнопки пока нет дополнительных заметок."}
            </p>

            <div className="fact-grid">
              <Fact
                label="Статус"
                value={labelForCapability(selectedControl.capabilityStatus)}
              />
              <Fact
                label="Сигнал"
                value={selectedEncoder?.encodedKey ?? "не назначен"}
              />
              <Fact
                label="Можно переназначить"
                value={selectedControl.remappable ? "Да" : "Нет"}
              />
              <Fact label="Группа" value={labelForControlFamily(selectedControl.family)} />
              <Fact label="ID кнопки" value={selectedControl.id} />
              <Fact
                label="Источник сигнала"
                value={labelForEncoderSource(selectedEncoder?.source)}
              />
            </div>

            <label className="field">
              <span className="field__label">Статус кнопки</span>
              <select
                value={selectedControl.capabilityStatus}
                onChange={(event) => {
                  updateDraft((config) =>
                    updateControlCapabilityStatus(
                      config,
                      selectedControl.id,
                      event.target.value as CapabilityStatus,
                    ),
                  );
                }}
              >
                <option value="verified">Подтверждена</option>
                <option value="needsValidation">Нужна проверка</option>
                <option value="partiallyRemappable">Частично переназначается</option>
                <option value="reserved">Зарезервирована</option>
              </select>
            </label>

            <div className="inspector__binding-card">
              <h3>Что сработает</h3>
              {selectedBinding ? (
                <>
                  <p>
                    <strong>{selectedBinding.label}</strong>
                  </p>
                  <p>{describeActionSummary(selectedAction, snippetById)}</p>
                  <p>
                    Ссылка на действие: <code>{selectedBinding.actionRef}</code>
                  </p>
                  <p>
                    Тип действия:{" "}
                    <code>{selectedAction?.type ?? "действие отсутствует"}</code>
                  </p>
                </>
              ) : (
                <p>Для этой кнопки на текущем слое назначение ещё не создано.</p>
              )}
            </div>
          </>
        ) : (
          <p>Выберите кнопку на схеме мыши</p>
        )}
      </section>

      <section className="panel">
        <p className="panel__eyebrow">Сигнал кнопки</p>
        {selectedControl ? (
          selectedEncoder ? (
            <div className="editor-grid">
              <label className="field">
                <span className="field__label">Код сигнала</span>
                <input
                  type="text"
                  value={selectedEncoder.encodedKey}
                  placeholder="F13"
                  onChange={(event) => {
                    updateDraft((config) =>
                      upsertEncoderMapping(config, {
                        ...selectedEncoder,
                        encodedKey: event.target.value,
                      }),
                    );
                  }}
                  onBlur={(event) => {
                    if (!event.target.value.trim()) {
                      updateDraft((config) =>
                        upsertEncoderMapping(config, {
                          ...selectedEncoder,
                          encodedKey: selectedEncoder.encodedKey || "F13",
                        }),
                      );
                    }
                  }}
                />
              </label>

              <label className="field">
                <span className="field__label">Источник</span>
                <select
                  value={selectedEncoder.source}
                  onChange={(event) => {
                    updateDraft((config) =>
                      upsertEncoderMapping(config, {
                        ...selectedEncoder,
                        source: event.target.value as EncoderMapping["source"],
                      }),
                    );
                  }}
                >
                  <option value="synapse">Synapse</option>
                  <option value="detected">Обнаружен</option>
                  <option value="reserved">Зарезервирован</option>
                </select>
              </label>

              <label className="field field--inline">
                <span className="field__label">Подтверждён</span>
                <input
                  type="checkbox"
                  checked={selectedEncoder.verified}
                  onChange={(event) => {
                    updateDraft((config) =>
                      upsertEncoderMapping(config, {
                        ...selectedEncoder,
                        verified: event.target.checked,
                      }),
                    );
                  }}
                />
              </label>
            </div>
          ) : (
            <div className="editor-grid">
              <p className="panel__muted">
                Для <code>{selectedControl.id}</code> на текущем слое ещё нет сигнала.
              </p>
              <button
                type="button"
                className="action-button"
                onClick={() => {
                  updateDraft((config) =>
                    ensureEncoderMapping(config, selectedLayer, selectedControl),
                  );
                }}
              >
                Создать временный сигнал
              </button>
            </div>
          )
        ) : (
          <p className="panel__muted">
            Выберите кнопку перед редактированием сигнала.
          </p>
        )}
      </section>
    </>
  );
}
