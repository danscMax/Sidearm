import type {
  Action,
  ActionType,
  AppConfig,
  MenuItem,
  SequenceStep,
  SnippetLibraryItem,
} from "../lib/config";
import {
  coerceActionType,
  createDefaultActionMenuItem,
  createDefaultSubmenuItem,
  promoteInlineSnippetActionToLibrary,
  upsertAction,
} from "../lib/config-editing";
import { editableActionTypes } from "../lib/constants";
import {
  parseCommaSeparatedList,
  parseCommaSeparatedUniqueValues,
  parseOptionalNumber,
} from "../lib/helpers";
import { labelForSequenceStep } from "../lib/labels";
import {
  coerceSequenceStepType,
  createDefaultSequenceStep,
  describeActionSummary,
  setSequenceStepDelay,
  withLaunchPayload,
  withMenuPayload,
  withSequencePayload,
  withShortcutPayload,
  withTextSnippetPayload,
} from "../lib/action-helpers";
import {
  appendMenuItem,
  collectMenuItemIds,
  removeMenuItem,
  updateMenuItem,
} from "../lib/menu-helpers";

export interface ActionInspectorProps {
  activeConfig: AppConfig;
  selectedAction: Action | null;
  snippetById: Map<string, SnippetLibraryItem>;
  selectedActionUsageCount: number;
  updateDraft: (updater: (config: AppConfig) => AppConfig) => void;
}

export function ActionInspector({
  activeConfig,
  selectedAction,
  snippetById,
  selectedActionUsageCount,
  updateDraft,
}: ActionInspectorProps) {
  // --- Derived values ---
  const selectedSequencePayload =
    selectedAction && selectedAction.type === "sequence"
      ? selectedAction.payload
      : null;
  const selectedMenuPayload =
    selectedAction && selectedAction.type === "menu"
      ? selectedAction.payload
      : null;
  const menuActionOptions =
    selectedAction
      ? activeConfig.actions.filter((action) => action.id !== selectedAction.id)
      : [];

  // --- Helper functions ---

  function updateSelectedActionDraft(updateAction: (action: Action) => Action) {
    if (!selectedAction) {
      return;
    }

    const actionId = selectedAction.id;
    updateDraft((config) => {
      const freshAction = config.actions.find((a) => a.id === actionId);
      if (!freshAction) return config;
      return upsertAction(config, updateAction(freshAction));
    });
  }

  function updateSelectedMenuItems(updateItems: (items: MenuItem[]) => MenuItem[]) {
    updateSelectedActionDraft((action) =>
      withMenuPayload(action, (payload) => ({
        ...payload,
        items: updateItems(payload.items),
      })),
    );
  }

  function addMenuActionItem(parentId?: string) {
    const fallbackAction = menuActionOptions[0];
    if (!selectedAction || !fallbackAction) {
      return;
    }

    const existingIds =
      selectedMenuPayload ? collectMenuItemIds(selectedMenuPayload.items) : [];
    const nextItem = createDefaultActionMenuItem(
      existingIds,
      fallbackAction.id,
      fallbackAction.pretty,
    );

    updateSelectedMenuItems((items) => appendMenuItem(items, parentId ?? null, nextItem));
  }

  function addSubmenuItem(parentId?: string) {
    const fallbackAction = menuActionOptions[0];
    if (!selectedAction || !fallbackAction) {
      return;
    }

    const existingIds =
      selectedMenuPayload ? collectMenuItemIds(selectedMenuPayload.items) : [];
    const nextItem = createDefaultSubmenuItem(
      existingIds,
      fallbackAction.id,
      fallbackAction.pretty,
    );

    updateSelectedMenuItems((items) => appendMenuItem(items, parentId ?? null, nextItem));
  }

  function renderMenuItemEditor(
    item: MenuItem,
    depth: number,
    canRemove: boolean,
  ) {
    return (
      <div
        className="compound-card compound-card--menu"
        key={item.id}
        style={{ marginLeft: `${depth * 18}px` }}
      >
        <div className="compound-card__header">
          <div>
            <strong>{item.label}</strong>
            <span className="compound-card__meta">
              {item.kind === "action" ? "Пункт действия" : "Подменю"}
            </span>
          </div>
          <button
            type="button"
            className="action-button action-button--secondary action-button--small"
            disabled={!canRemove}
            onClick={() => {
              updateSelectedMenuItems((items) => removeMenuItem(items, item.id));
            }}
          >
            Удалить
          </button>
        </div>

        <div className="editor-grid">
          <div className="field">
            <span className="field__label">ID пункта меню</span>
            <code className="field__static">{item.id}</code>
          </div>

          <label className="field">
            <span className="field__label">Название</span>
            <input
              type="text"
              value={item.label}
              onChange={(event) => {
                updateSelectedMenuItems((items) =>
                  updateMenuItem(items, item.id, (currentItem) => ({
                    ...currentItem,
                    label: event.target.value,
                  })),
                );
              }}
            />
          </label>

          <label className="field field--inline">
            <span className="field__label">Включено</span>
            <input
              type="checkbox"
              checked={item.enabled}
              onChange={(event) => {
                updateSelectedMenuItems((items) =>
                  updateMenuItem(items, item.id, (currentItem) => ({
                    ...currentItem,
                    enabled: event.target.checked,
                  })),
                );
              }}
            />
          </label>

          {item.kind === "action" ? (
            <label className="field">
              <span className="field__label">Ссылка на действие</span>
              <select
                value={item.actionRef}
                onChange={(event) => {
                  updateSelectedMenuItems((items) =>
                    updateMenuItem(items, item.id, (currentItem) =>
                      currentItem.kind === "action"
                        ? {
                            ...currentItem,
                            actionRef: event.target.value,
                          }
                        : currentItem,
                    ),
                  );
                }}
              >
                {menuActionOptions.map((action) => (
                  <option key={action.id} value={action.id}>
                    {action.pretty} ({action.type})
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <div className="field__header">
                <span className="field__label">Вложенные пункты</span>
                <div className="editor-actions">
                  <button
                    type="button"
                    className="action-button action-button--secondary action-button--small"
                    onClick={() => {
                      addMenuActionItem(item.id);
                    }}
                    disabled={menuActionOptions.length === 0}
                  >
                    Добавить действие
                  </button>
                  <button
                    type="button"
                    className="action-button action-button--secondary action-button--small"
                    onClick={() => {
                      addSubmenuItem(item.id);
                    }}
                    disabled={menuActionOptions.length === 0}
                  >
                    Добавить подменю
                  </button>
                </div>
              </div>

              <div className="stack-list">
                {item.items.map((childItem) =>
                  renderMenuItemEditor(
                    childItem,
                    depth + 1,
                    item.items.length > 1,
                  ),
                )}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <section className="panel">
      <p className="panel__eyebrow">Действие кнопки</p>
      {selectedAction ? (
        <div className="editor-grid">
          <label className="field">
            <span className="field__label">Название действия</span>
            <input
              type="text"
              value={selectedAction.pretty}
              onChange={(event) => {
                updateSelectedActionDraft((action) => ({
                  ...action,
                  pretty: event.target.value,
                }));
              }}
            />
          </label>

          <label className="field">
            <span className="field__label">Тип действия</span>
            <select
              value={selectedAction.type}
              onChange={(event) => {
                updateDraft((config) =>
                  coerceActionType(
                    config,
                    selectedAction.id,
                    event.target.value as ActionType,
                  ),
                );
              }}
            >
              {editableActionTypes.map((actionType) => (
                <option key={actionType.value} value={actionType.value}>
                  {actionType.label}
                </option>
              ))}
            </select>
          </label>

          {selectedAction.type === "shortcut" ? (
            <>
              <label className="field">
                <span className="field__label">Клавиша</span>
                <input
                  type="text"
                  value={selectedAction.payload.key}
                  onChange={(event) => {
                    updateSelectedActionDraft((action) =>
                      withShortcutPayload(action, (payload) => ({
                        ...payload,
                        key: event.target.value,
                      })),
                    );
                  }}
                />
              </label>

              <div className="field">
                <span className="field__label">Модификаторы</span>
                <div className="toggle-grid">
                  {(
                    [
                      ["ctrl", "Ctrl"],
                      ["shift", "Shift"],
                      ["alt", "Alt"],
                      ["win", "Win"],
                    ] as const
                  ).map(([modifierKey, modifierLabel]) => (
                    <label className="toggle-chip" key={modifierKey}>
                      <input
                        type="checkbox"
                        checked={
                          selectedAction.payload[modifierKey]
                        }
                        onChange={(event) => {
                          updateSelectedActionDraft((action) =>
                            withShortcutPayload(action, (payload) => ({
                              ...payload,
                              [modifierKey]: event.target.checked,
                            })),
                          );
                        }}
                      />
                      <span>{modifierLabel}</span>
                    </label>
                  ))}
                </div>
              </div>

              <label className="field">
                <span className="field__label">Исходная строка шортката</span>
                <input
                  type="text"
                  value={selectedAction.payload.raw ?? ""}
                  onChange={(event) => {
                    updateSelectedActionDraft((action) =>
                      withShortcutPayload(action, (payload) => ({
                        ...payload,
                        raw: event.target.value || undefined,
                      })),
                    );
                  }}
                />
              </label>
            </>
          ) : null}

          {selectedAction.type === "textSnippet" ? (
            <>
              <label className="field">
                <span className="field__label">Источник фрагмента</span>
                <select
                  value={selectedAction.payload.source}
                  onChange={(event) => {
                    updateSelectedActionDraft((action) =>
                      withTextSnippetPayload(action, (payload) =>
                        event.target.value === "libraryRef"
                          ? {
                              source: "libraryRef",
                              snippetId:
                                activeConfig.snippetLibrary[0]?.id ??
                                "snippet-missing",
                            }
                          : {
                              source: "inline",
                              text:
                                payload.source === "inline"
                                  ? payload.text
                                  : action.pretty,
                              pasteMode:
                                payload.source === "inline"
                                  ? payload.pasteMode
                                  : "sendText",
                              tags:
                                payload.source === "inline"
                                  ? payload.tags
                                  : [],
                            },
                      ),
                    );
                  }}
                >
                  <option value="inline">Встроенный текст</option>
                  <option
                    value="libraryRef"
                    disabled={activeConfig.snippetLibrary.length === 0}
                  >
                    Библиотека фрагментов
                  </option>
                </select>
              </label>

              {selectedAction.payload.source === "inline" ? (
                <>
                  <label className="field">
                    <span className="field__label">Текст</span>
                    <textarea
                      rows={5}
                      value={selectedAction.payload.text}
                      onChange={(event) => {
                        updateSelectedActionDraft((action) =>
                          withTextSnippetPayload(action, (payload) =>
                            payload.source === "inline"
                              ? {
                                  ...payload,
                                  text: event.target.value,
                                }
                              : payload,
                          ),
                        );
                      }}
                    />
                  </label>

                  <label className="field">
                    <span className="field__label">Способ вставки</span>
                    <select
                      value={selectedAction.payload.pasteMode}
                      onChange={(event) => {
                        updateSelectedActionDraft((action) =>
                          withTextSnippetPayload(action, (payload) =>
                            payload.source === "inline"
                              ? {
                                  ...payload,
                                  pasteMode: event.target.value as
                                    | "clipboardPaste"
                                    | "sendText",
                                }
                              : payload,
                          ),
                        );
                      }}
                    >
                      <option value="clipboardPaste">Через буфер обмена</option>
                      <option value="sendText">Прямой ввод текста</option>
                    </select>
                  </label>

                  <label className="field">
                    <span className="field__label">Теги</span>
                    <input
                      type="text"
                      value={selectedAction.payload.tags.join(", ")}
                      placeholder="тег1, тег2, тег3"
                      onChange={(event) => {
                        updateSelectedActionDraft((action) =>
                          withTextSnippetPayload(action, (payload) =>
                            payload.source === "inline"
                              ? {
                                  ...payload,
                                  tags: parseCommaSeparatedUniqueValues(event.target.value),
                                }
                              : payload,
                          ),
                        );
                      }}
                    />
                  </label>

                  <button
                    type="button"
                    className="action-button action-button--secondary"
                    onClick={() => {
                      updateDraft((config) =>
                        promoteInlineSnippetActionToLibrary(
                          config,
                          selectedAction.id,
                          selectedAction.pretty,
                        ),
                      );
                    }}
                  >
                    Создать запись в библиотеке
                  </button>
                </>
              ) : (
                <label className="field">
                  <span className="field__label">Запись из библиотеки</span>
                  <select
                    value={selectedAction.payload.snippetId}
                    onChange={(event) => {
                      updateSelectedActionDraft((action) =>
                        withTextSnippetPayload(action, (payload) =>
                          payload.source === "libraryRef"
                            ? {
                                ...payload,
                                snippetId: event.target.value,
                              }
                            : payload,
                        ),
                      );
                    }}
                  >
                    {activeConfig.snippetLibrary.map((snippet) => (
                      <option key={snippet.id} value={snippet.id}>
                        {snippet.name} ({snippet.id})
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          ) : null}

          {selectedSequencePayload ? (
            <div className="field">
              <div className="field__header">
                <span className="field__label">Шаги последовательности</span>
                <div className="editor-actions">
                  {(
                    [
                      ["send", "Добавить отправку"],
                      ["text", "Добавить текст"],
                      ["sleep", "Добавить паузу"],
                      ["launch", "Добавить запуск"],
                    ] as const
                  ).map(([stepType, label]) => (
                    <button
                      type="button"
                      key={stepType}
                      className="action-button action-button--secondary action-button--small"
                      onClick={() => {
                        updateSelectedActionDraft((action) =>
                          withSequencePayload(action, (payload) => ({
                            ...payload,
                            steps: [
                              ...payload.steps,
                              createDefaultSequenceStep(stepType),
                            ],
                          })),
                        );
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="stack-list">
                {selectedSequencePayload.steps.map((step, index) => (
                  <div className="compound-card" key={index}>
                    <div className="compound-card__header">
                      <div>
                        <strong>Шаг {index + 1}</strong>
                        <span className="compound-card__meta">
                          {labelForSequenceStep(step.type)}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="action-button action-button--secondary action-button--small"
                        disabled={selectedSequencePayload.steps.length === 1}
                        onClick={() => {
                          updateSelectedActionDraft((action) =>
                            withSequencePayload(action, (payload) => ({
                              ...payload,
                              steps: payload.steps.filter(
                                (_, stepIndex) => stepIndex !== index,
                              ),
                            })),
                          );
                        }}
                      >
                        Удалить
                      </button>
                    </div>

                    <div className="editor-grid">
                      <label className="field">
                        <span className="field__label">Тип шага</span>
                        <select
                          value={step.type}
                          onChange={(event) => {
                            updateSelectedActionDraft((action) =>
                              withSequencePayload(action, (payload) => ({
                                ...payload,
                                steps: payload.steps.map(
                                  (currentStep, stepIndex) =>
                                    stepIndex === index
                                      ? coerceSequenceStepType(
                                          currentStep,
                                          event.target
                                            .value as SequenceStep["type"],
                                        )
                                      : currentStep,
                                ),
                              })),
                            );
                          }}
                        >
                          <option value="send">Отправка сочетания</option>
                          <option value="text">Ввод текста</option>
                          <option value="sleep">Пауза</option>
                          <option value="launch">Запуск</option>
                        </select>
                      </label>

                      {step.type !== "sleep" ? (
                        <label className="field">
                          <span className="field__label">Значение</span>
                          <input
                            type="text"
                            value={step.value}
                            onChange={(event) => {
                              updateSelectedActionDraft((action) =>
                                withSequencePayload(action, (payload) => ({
                                  ...payload,
                                  steps: payload.steps.map(
                                    (currentStep, stepIndex) =>
                                      stepIndex === index &&
                                      "value" in currentStep
                                        ? {
                                            ...currentStep,
                                            value: event.target.value,
                                          }
                                        : currentStep,
                                  ),
                                })),
                              );
                            }}
                          />
                        </label>
                      ) : null}

                      <label className="field">
                        <span className="field__label">Задержка (мс, макс. 30 000)</span>
                        <input
                          type="number"
                          min={0}
                          max={30000}
                          value={step.delayMs ?? ""}
                          onChange={(event) => {
                            const raw = parseOptionalNumber(
                              event.target.value,
                            );
                            const nextDelay =
                              raw !== undefined
                                ? Math.max(0, Math.min(30000, Math.round(raw)))
                                : undefined;
                            updateSelectedActionDraft((action) =>
                              withSequencePayload(action, (payload) => ({
                                ...payload,
                                steps: payload.steps.map(
                                  (currentStep, stepIndex) =>
                                    stepIndex === index
                                      ? setSequenceStepDelay(
                                          currentStep,
                                          nextDelay,
                                        )
                                      : currentStep,
                                ),
                              })),
                            );
                          }}
                        />
                      </label>

                      {step.type === "launch" ? (
                        <>
                          <label className="field">
                            <span className="field__label">Аргументы</span>
                            <input
                              type="text"
                              value={(step.args ?? []).join(", ")}
                              placeholder="арг1, арг2"
                              onChange={(event) => {
                                updateSelectedActionDraft((action) =>
                                  withSequencePayload(action, (payload) => ({
                                    ...payload,
                                    steps: payload.steps.map(
                                      (currentStep, stepIndex) =>
                                        stepIndex === index &&
                                        currentStep.type === "launch"
                                          ? {
                                              ...currentStep,
                                              args:
                                                parseCommaSeparatedList(
                                                  event.target.value,
                                                ),
                                            }
                                          : currentStep,
                                    ),
                                  })),
                                );
                              }}
                            />
                          </label>

                          <label className="field">
                            <span className="field__label">Рабочая папка</span>
                            <input
                              type="text"
                              value={step.workingDir ?? ""}
                              onChange={(event) => {
                                updateSelectedActionDraft((action) =>
                                  withSequencePayload(action, (payload) => ({
                                    ...payload,
                                    steps: payload.steps.map(
                                      (currentStep, stepIndex) =>
                                        stepIndex === index &&
                                        currentStep.type === "launch"
                                          ? {
                                              ...currentStep,
                                              workingDir:
                                                event.target.value ||
                                                undefined,
                                            }
                                          : currentStep,
                                    ),
                                  })),
                                );
                              }}
                            />
                          </label>
                        </>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {selectedAction.type === "launch" ? (
            <>
              <label className="field">
                <span className="field__label">Цель запуска</span>
                <input
                  type="text"
                  value={selectedAction.payload.target}
                  placeholder="C:\Path\To\App.exe"
                  onChange={(event) => {
                    updateSelectedActionDraft((action) =>
                      withLaunchPayload(action, (payload) => ({
                        ...payload,
                        target: event.target.value,
                      })),
                    );
                  }}
                  onBlur={(event) => {
                    if (!event.target.value.trim()) {
                      updateSelectedActionDraft((action) =>
                        withLaunchPayload(action, (payload) => ({
                          ...payload,
                          target: payload.target || "C:\\Path\\To\\App.exe",
                        })),
                      );
                    }
                  }}
                />
              </label>

              <label className="field">
                <span className="field__label">Аргументы</span>
                <input
                  type="text"
                  value={(selectedAction.payload.args ?? []).join(", ")}
                  placeholder="арг1, арг2"
                  onChange={(event) => {
                    updateSelectedActionDraft((action) =>
                      withLaunchPayload(action, (payload) => ({
                        ...payload,
                        args: parseCommaSeparatedList(event.target.value),
                      })),
                    );
                  }}
                />
              </label>

              <label className="field">
                <span className="field__label">Рабочая папка</span>
                <input
                  type="text"
                  value={selectedAction.payload.workingDir ?? ""}
                  onChange={(event) => {
                    updateSelectedActionDraft((action) =>
                      withLaunchPayload(action, (payload) => ({
                        ...payload,
                        workingDir: event.target.value || undefined,
                      })),
                    );
                  }}
                />
              </label>
            </>
          ) : null}

          {selectedMenuPayload ? (
            <div className="field">
              <div className="field__header">
                <span className="field__label">Пункты меню</span>
                <div className="editor-actions">
                  <button
                    type="button"
                    className="action-button action-button--secondary action-button--small"
                    onClick={() => {
                      addMenuActionItem();
                    }}
                    disabled={menuActionOptions.length === 0}
                  >
                    Добавить действие
                  </button>
                  <button
                    type="button"
                    className="action-button action-button--secondary action-button--small"
                    onClick={() => {
                      addSubmenuItem();
                    }}
                    disabled={menuActionOptions.length === 0}
                  >
                    Добавить подменю
                  </button>
                </div>
              </div>

              {menuActionOptions.length === 0 ? (
                <div className="notice notice--warning">
                  <strong>Нет доступных действий для меню</strong>
                  <p>
                    Пункты меню должны ссылаться на другие действия.
                    Создайте хотя бы ещё одно действие.
                  </p>
                </div>
              ) : null}

              <div className="stack-list">
                {selectedMenuPayload.items.map((item) =>
                  renderMenuItemEditor(
                    item,
                    0,
                    selectedMenuPayload.items.length > 1,
                  ),
                )}
              </div>
            </div>
          ) : null}

          <p className="panel__muted">
            {describeActionSummary(selectedAction, snippetById)}
            {" "}Назначений: {selectedActionUsageCount}.
          </p>
        </div>
      ) : (
        <p className="panel__muted">
          Сначала выберите или создайте назначение.
        </p>
      )}
    </section>
  );
}
