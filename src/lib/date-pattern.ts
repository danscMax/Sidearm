/** `{date:<pattern>}` as the backend fills it (input_synthesis::format_date_pattern):
 *  `yyyy` `yy` year, `MMMM` month name, `MM` `M` month, `dd` `d` day, `HH` `H`
 *  hour, `mm` minutes, `ss` seconds; anything else is copied. Here only for the
 *  examples the editor shows, so the two must follow the same rules. */
const PARTS = ["yyyy", "yy", "MMMM", "MM", "M", "dd", "d", "HH", "H", "mm", "ss"] as const;

export function formatDatePattern(pattern: string, now: Date, months: readonly string[]): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const value: Record<(typeof PARTS)[number], string> = {
    yyyy: String(now.getFullYear()).padStart(4, "0"),
    yy: pad(now.getFullYear() % 100),
    MMMM: months[now.getMonth()] ?? "",
    MM: pad(now.getMonth() + 1),
    M: String(now.getMonth() + 1),
    dd: pad(now.getDate()),
    d: String(now.getDate()),
    HH: pad(now.getHours()),
    H: String(now.getHours()),
    mm: pad(now.getMinutes()),
    ss: pad(now.getSeconds()),
  };
  let out = "";
  for (let rest = pattern; rest.length > 0; ) {
    const part = PARTS.find((candidate) => rest.startsWith(candidate));
    out += part ? value[part] : rest[0];
    rest = rest.slice(part ? part.length : 1);
  }
  return out;
}

/** The date and time formats the token menu offers (`{time}` = `HH:mm`). */
export const DATE_TOKENS = ["{date}", "{date:dd.MM.yyyy}", "{date:dd.MM.yy}", "{date:d MMMM yyyy}", "{time}", "{date:dd.MM.yyyy HH:mm}"] as const;

/** The pattern a date token fills. */
export function patternOf(token: string): string {
  if (token === "{date}") return "yyyy-MM-dd";
  if (token === "{time}") return "HH:mm";
  return token.slice("{date:".length, -1);
}
