import type {
  ActionType,
  ControlFamily,
  Layer,
  MediaKeyKind,
  MouseActionKind,
} from "../config";
import type { VerificationSessionScope } from "../verification-session";
import type { ActionCategory, WorkspaceMode } from "./types";

export const controlFamilyOrder: ControlFamily[] = ["thumbGrid", "topPanel", "system"];
export const workspaceModeCopy: Array<{
  value: WorkspaceMode;
  label: string;
  body: string;
  heading: string;
  meta: string;
}> = [
  {
    value: "profiles",
    label: "Назначения",
    heading: "Назначения",
    body: "Профили, кнопки и правила для приложений.",
    meta: "Назначения кнопок",
  },
  {
    value: "debug",
    label: "Диагностика",
    heading: "Диагностика",
    body: "Сигналы, проверка кнопок, журнал событий.",
    meta: "Диагностика и проверка",
  },
  {
    value: "settings",
    label: "Настройки",
    heading: "Настройки",
    body: "Профили, приоритеты и общие параметры приложения.",
    meta: "Настройки профилей",
  },
];

export const verificationScopeCopy: Array<{
  value: VerificationSessionScope;
  label: string;
  body: string;
}> = [
  {
    value: "currentFamily",
    label: "Текущая группа",
    body: "Только кнопки из выбранной группы: боковая клавиатура, верхняя панель, колесо или системные контролы.",
  },
  {
    value: "all",
    label: "Весь слой",
    body: "Все контролы текущего слоя по очереди.",
  },
];


export const layerCopy: Array<{ value: Layer; label: string; body: string }> = [
  {
    value: "standard",
    label: "Стандартный",
    body: "Основной слой назначений и сигналов.",
  },
  {
    value: "hypershift",
    label: "Hypershift",
    body: "Второй слой со своими биндами и отдельной валидацией.",
  },
];

/** Single source of truth for action-type display labels. Both
 *  `editableActionTypes` and `ACTION_CATEGORIES` derive their labels from here
 *  so the two lists cannot drift (previously "Меню" vs "Контекстное меню"). */
export const ACTION_TYPE_LABELS: Record<ActionType, string> = {
  shortcut: "Клавиатура",
  mouseAction: "Мышь",
  textSnippet: "Текст",
  sequence: "Макрос",
  launch: "Запуск",
  mediaKey: "Медиа",
  profileSwitch: "Профиль",
  menu: "Контекстное меню",
  disabled: "Отключено",
};

export const editableActionTypes: Array<{
  value: ActionType;
  label: string;
}> = [
  { value: "shortcut", label: ACTION_TYPE_LABELS.shortcut },
  { value: "mouseAction", label: ACTION_TYPE_LABELS.mouseAction },
  { value: "textSnippet", label: ACTION_TYPE_LABELS.textSnippet },
  { value: "sequence", label: ACTION_TYPE_LABELS.sequence },
  { value: "launch", label: ACTION_TYPE_LABELS.launch },
  { value: "mediaKey", label: ACTION_TYPE_LABELS.mediaKey },
  { value: "profileSwitch", label: ACTION_TYPE_LABELS.profileSwitch },
  { value: "menu", label: ACTION_TYPE_LABELS.menu },
  { value: "disabled", label: ACTION_TYPE_LABELS.disabled },
];

export const ACTION_CATEGORIES: ActionCategory[] = [
  { id: "shortcut", icon: "KB", label: ACTION_TYPE_LABELS.shortcut, actionType: "shortcut" },
  { id: "mouseAction", icon: "MS", label: ACTION_TYPE_LABELS.mouseAction, actionType: "mouseAction" },
  { id: "textSnippet", icon: "Tx", label: ACTION_TYPE_LABELS.textSnippet, actionType: "textSnippet" },
  { id: "sequence", icon: "Sq", label: ACTION_TYPE_LABELS.sequence, actionType: "sequence" },
  { id: "launch", icon: "Ex", label: ACTION_TYPE_LABELS.launch, actionType: "launch" },
  { id: "mediaKey", icon: "Md", label: ACTION_TYPE_LABELS.mediaKey, actionType: "mediaKey" },
  { id: "profileSwitch", icon: "Pf", label: ACTION_TYPE_LABELS.profileSwitch, actionType: "profileSwitch" },
  { id: "menu", icon: "Mn", label: ACTION_TYPE_LABELS.menu, actionType: "menu" },
  { id: "disabled", icon: "—", label: ACTION_TYPE_LABELS.disabled, actionType: "disabled" },
];

export const MOUSE_ACTION_OPTIONS: Array<{ value: MouseActionKind; label: string }> = [
  { value: "leftClick", label: "Левый клик" },
  { value: "rightClick", label: "Правый клик" },
  { value: "middleClick", label: "Средний клик" },
  { value: "doubleClick", label: "Двойной клик" },
  { value: "scrollUp", label: "Скролл вверх" },
  { value: "scrollDown", label: "Скролл вниз" },
  { value: "scrollLeft", label: "Скролл влево" },
  { value: "scrollRight", label: "Скролл вправо" },
  { value: "mouseBack", label: "Назад" },
  { value: "mouseForward", label: "Вперёд" },
];

export const MEDIA_KEY_OPTIONS: Array<{ value: MediaKeyKind; label: string }> = [
  { value: "playPause", label: "Play / Pause" },
  { value: "nextTrack", label: "Следующий трек" },
  { value: "prevTrack", label: "Предыдущий трек" },
  { value: "stop", label: "Стоп" },
  { value: "volumeUp", label: "Громкость +" },
  { value: "volumeDown", label: "Громкость −" },
  { value: "mute", label: "Без звука" },
];
