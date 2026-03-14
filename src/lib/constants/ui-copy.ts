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

export const editableActionTypes: Array<{
  value: ActionType;
  label: string;
}> = [
  { value: "shortcut", label: "Клавиатура" },
  { value: "mouseAction", label: "Мышь" },
  { value: "textSnippet", label: "Текст" },
  { value: "sequence", label: "Макрос" },
  { value: "launch", label: "Запуск" },
  { value: "mediaKey", label: "Медиа" },
  { value: "profileSwitch", label: "Профиль" },
  { value: "menu", label: "Меню" },
  { value: "disabled", label: "Отключено" },
];

export const ACTION_CATEGORIES: ActionCategory[] = [
  { id: "shortcut", icon: "KB", label: "Клавиатура", actionType: "shortcut" },
  { id: "mouseAction", icon: "MS", label: "Мышь", actionType: "mouseAction" },
  { id: "textSnippet", icon: "Tx", label: "Текст", actionType: "textSnippet" },
  { id: "sequence", icon: "Sq", label: "Макрос", actionType: "sequence" },
  { id: "launch", icon: "Ex", label: "Запуск", actionType: "launch" },
  { id: "mediaKey", icon: "Md", label: "Медиа", actionType: "mediaKey" },
  { id: "profileSwitch", icon: "Pf", label: "Профиль", actionType: "profileSwitch" },
  { id: "menu", icon: "Mn", label: "Контекстное меню", actionType: "menu" },
  { id: "disabled", icon: "—", label: "Отключено", actionType: "disabled" },
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
