// Mirrors hotkeys::parse_primary_key; canonical names also keep conflict ids stable.
const NAMED_KEYS: readonly (readonly [number, string])[] = [
  [0x0D, "ENTER RETURN"], [0x09, "TAB"], [0x20, "SPACE SPACEBAR"],
  [0x08, "BACKSPACE BKSP"], [0x2E, "DELETE DEL"], [0x2D, "INSERT INS"],
  [0x1B, "ESC ESCAPE"], [0x24, "HOME"], [0x23, "END"],
  [0x21, "PAGEUP PGUP"], [0x22, "PAGEDOWN PGDOWN PGDN"],
  [0x25, "LEFT LEFTARROW"], [0x27, "RIGHT RIGHTARROW"],
  [0x26, "UP UPARROW"], [0x28, "DOWN DOWNARROW"],
  [0x14, "CAPSLOCK"], [0x90, "NUMLOCK"], [0x2C, "PRINTSCREEN PRTSC PRTSCN"],
  [0x91, "SCROLLLOCK"], [0x13, "PAUSE"], [0x5D, "APPS APPLICATION MENU"],
  [0xBD, "- MINUS HYPHEN"], [0xBB, "= EQUAL EQUALS PLUS"],
  [0xBC, ", COMMA"], [0xBE, ". PERIOD DOT"], [0xBF, "/ SLASH FORWARDSLASH"],
  [0xBA, "; SEMICOLON"], [0xDE, "' APOSTROPHE QUOTE"],
  [0xDB, "[ LBRACKET LEFTBRACKET"], [0xDD, "] RBRACKET RIGHTBRACKET"],
  [0xDC, "\\ BACKSLASH"], [0xC0, "` GRAVE BACKTICK"],
];
const codes = new Map(NAMED_KEYS.flatMap(([code, names]) => names.split(" ").map((name) => [name, code] as const)));
const names = new Map(NAMED_KEYS.map(([code, aliases]) => [code, aliases.split(" ")[0]]));
const CYRILLIC = "\u0401\u0419\u0426\u0423\u041a\u0415\u041d\u0413\u0428\u0429\u0417\u0425\u042a\u0424\u042b\u0412\u0410\u041f\u0420\u041e\u041b\u0414\u0416\u042d\u042f\u0427\u0421\u041c\u0418\u0422\u042c\u0411\u042e";
const LATIN = "`QWERTYUIOP[]ASDFGHJKL;'ZXCVBNM,.";

/** Windows VK, using the same layout-independent aliases as the backend. */
export function primaryKeyCode(raw: string): number | null {
  const key = [...raw.trim()].map((ch) => {
    const index = CYRILLIC.indexOf(ch.toUpperCase());
    return index < 0 ? ch : LATIN[index];
  }).join("").replace(/[a-z]/g, (ch) => ch.toUpperCase());
  if (/^[A-Z0-9]$/.test(key)) return key.charCodeAt(0);
  const compact = key.replace(/[ _]/g, "");
  const named = codes.get(compact);
  if (named !== undefined) return named;
  const f = /^F(\+?\d+)$/.exec(compact);
  if (f && Number(f[1]) >= 1 && Number(f[1]) <= 24) return 0x6F + Number(f[1]);
  const vk = /^VK(\+?\d+)$/.exec(compact);
  return vk && Number(vk[1]) > 0 && Number(vk[1]) <= 0xFFFF ? Number(vk[1]) : null;
}

export function canonicalPrimaryKey(raw: string): string {
  const code = primaryKeyCode(raw);
  if (code === null) return raw.trim().toUpperCase();
  if ((code >= 0x41 && code <= 0x5A) || (code >= 0x30 && code <= 0x39)) return String.fromCharCode(code);
  if (code >= 0x70 && code <= 0x87) return `F${code - 0x6F}`;
  return names.get(code) ?? `VK_${code}`;
}
