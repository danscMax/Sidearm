import { Toggle } from "../../shared";

export type Modifiers = { ctrl: boolean; shift: boolean; alt: boolean; win: boolean };

const MODIFIER_KEYS = ["ctrl", "shift", "alt", "win"] as const;

const labelFor = (mod: string) => mod.charAt(0).toUpperCase() + mod.slice(1);

/** The Ctrl/Shift/Alt/Win toggle row shared by the shortcut and mouse editors. */
export function ModifierRow({
  value,
  onChange,
}: {
  value: Modifiers;
  onChange: (next: Modifiers) => void;
}) {
  return (
    <div className="modifier-row">
      {MODIFIER_KEYS.map((mod) => (
        <label key={mod} className="field field--inline">
          <Toggle
            checked={value[mod]}
            onChange={(checked) => onChange({ ...value, [mod]: checked })}
            ariaLabel={labelFor(mod)}
          />
          <span className="field__label">{labelFor(mod)}</span>
        </label>
      ))}
    </div>
  );
}
