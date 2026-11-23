export const DEVICE_PRESETS = [
  { id: "preset-mouse.svg", labelKey: "device.presetMouse" },
  { id: "preset-mmo-mouse.svg", labelKey: "device.presetMmoMouse" },
  { id: "preset-macropad.svg", labelKey: "device.presetMacropad" },
  { id: "preset-keyboard.svg", labelKey: "device.presetKeyboard" },
] as const;

export type DevicePresetId = (typeof DEVICE_PRESETS)[number]["id"];

const PRESET_SET = new Set<string>(DEVICE_PRESETS.map((preset) => preset.id));

export function isPresetDeviceImage(image: string | undefined | null): image is DevicePresetId {
  return typeof image === "string" && PRESET_SET.has(image);
}

/** Suggest a readable control name from a captured canonical signal. */
export function friendlyNameForSignal(
  encodedKey: string,
  fallback: string,
  isRussian: boolean,
): string {
  const key = encodedKey.trim();
  if (!key) return fallback;
  const ruMap: Record<string, string> = {
    Mouse4: "Боковая 4",
    Mouse5: "Боковая 5",
    MouseMiddle: "Средняя кнопка",
    MouseRight: "Правая кнопка",
    VolumeUp: "Громкость +",
    VolumeDown: "Громкость -",
    VolumeMute: "Без звука",
    MediaPlayPause: "Пауза / Плей",
    MediaNext: "Следующий трек",
    MediaPrev: "Предыдущий трек",
    MediaStop: "Стоп",
  };
  const enMap: Record<string, string> = {
    Mouse4: "Side 4",
    Mouse5: "Side 5",
    MouseMiddle: "Middle click",
    MouseRight: "Right click",
    VolumeUp: "Volume Up",
    VolumeDown: "Volume Down",
    VolumeMute: "Mute",
    MediaPlayPause: "Play / Pause",
    MediaNext: "Next Track",
    MediaPrev: "Prev Track",
    MediaStop: "Stop",
  };
  const named = isRussian ? ruMap[key] : enMap[key];
  if (named) return named;
  if (/^Numpad\d$/i.test(key)) return `Numpad ${key.slice(6)}`;
  if (/^F\d{1,2}$/i.test(key)) return key.toUpperCase();
  return key.length <= 24 ? key : fallback;
}

/** Smart initial hotspot coordinates (percent 0..100) for newly learned buttons
 *  so they immediately appear in sensible places on built-in device schematics. */
export function defaultHotspotForControl(
  image: string | undefined,
  encodedKey: string,
  existingCount: number,
): { x: number; y: number } {
  const key = encodedKey.trim();
  if (image === "preset-mouse.svg") {
    if (key === "Mouse4") return { x: 34, y: 44 };
    if (key === "Mouse5") return { x: 34, y: 58 };
    if (key === "MouseMiddle") return { x: 50, y: 27 };
    if (key === "MouseRight") return { x: 63, y: 26 };
  }
  if (image === "preset-mmo-mouse.svg") {
    if (key === "MouseMiddle") return { x: 50, y: 24 };
    if (key === "MouseRight") return { x: 64, y: 24 };
    const col = existingCount % 3;
    const row = Math.floor(existingCount / 3) % 4;
    return { x: 24 + col * 8, y: 38 + row * 12 };
  }
  if (image === "preset-macropad.svg") {
    const col = existingCount % 4;
    const row = Math.floor(existingCount / 4) % 3;
    return { x: 24 + col * 17, y: 34 + row * 22 };
  }
  if (image === "preset-keyboard.svg") {
    const col = existingCount % 6;
    const row = Math.floor(existingCount / 6) % 3;
    return { x: 18 + col * 13, y: 34 + row * 20 };
  }
  // Custom uploaded photo: tidy staggered grid near top-left so user can drag pins freely.
  const col = existingCount % 5;
  const row = Math.floor(existingCount / 5) % 4;
  return { x: 20 + col * 15, y: 25 + row * 18 };
}
