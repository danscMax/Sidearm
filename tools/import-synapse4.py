#!/usr/bin/env python3
"""Import Razer Synapse 4 backup (.synapse4) into Naga Workflow Studio config format.

Usage:
    python tools/import-synapse4.py <path-to-synapse4-file>

Outputs a JSON patch that can be merged into the app's config.json.
"""

import json
import base64
import sys
import uuid
from pathlib import Path

# ── Synapse inputID → our ControlId ──────────────────────────────────────────

SIDE_PANEL_MAP = {
    "KEY_1": "thumb_01",
    "KEY_2": "thumb_02",
    "KEY_3": "thumb_03",
    "KEY_4": "thumb_04",
    "KEY_5": "thumb_05",
    "KEY_6": "thumb_06",
    "KEY_7": "thumb_07",
    "KEY_8": "thumb_08",
    "KEY_9": "thumb_09",
    "KEY_0": "thumb_10",
    "KEY_HYPEN": "thumb_11",
    "KEY_EQUAL": "thumb_12",
}

TOP_PANEL_MAP = {
    "LeftClick": "mouse_left",
    "RightClick": "mouse_right",
    "ScrollButton": "wheel_click",
    "ScrollUp": "wheel_up",
    "ScrollDown": "wheel_down",
    "RepeatScrollLeft": "mouse_4",
    "RepeatScrollRight": "mouse_5",
}

DKM_MAP = {
    "DKM_M_01": "top_aux_01",
    "DKM_M_02": "top_aux_02",
}

# ── Synapse key names → our key names ────────────────────────────────────────

KEY_NAME_MAP = {
    "KEY_A": "A", "KEY_B": "B", "KEY_C": "C", "KEY_D": "D", "KEY_E": "E",
    "KEY_F": "F", "KEY_G": "G", "KEY_H": "H", "KEY_I": "I", "KEY_J": "J",
    "KEY_K": "K", "KEY_L": "L", "KEY_M": "M", "KEY_N": "N", "KEY_O": "O",
    "KEY_P": "P", "KEY_Q": "Q", "KEY_R": "R", "KEY_S": "S", "KEY_T": "T",
    "KEY_U": "U", "KEY_V": "V", "KEY_W": "W", "KEY_X": "X", "KEY_Y": "Y",
    "KEY_Z": "Z",
    "KEY_0": "0", "KEY_1": "1", "KEY_2": "2", "KEY_3": "3", "KEY_4": "4",
    "KEY_5": "5", "KEY_6": "6", "KEY_7": "7", "KEY_8": "8", "KEY_9": "9",
    "KEY_F1": "F1", "KEY_F2": "F2", "KEY_F3": "F3", "KEY_F4": "F4",
    "KEY_F5": "F5", "KEY_F6": "F6", "KEY_F7": "F7", "KEY_F8": "F8",
    "KEY_F9": "F9", "KEY_F10": "F10", "KEY_F11": "F11", "KEY_F12": "F12",
    "KEY_F13": "F13", "KEY_F14": "F14", "KEY_F15": "F15", "KEY_F16": "F16",
    "KEY_F17": "F17", "KEY_F18": "F18", "KEY_F19": "F19", "KEY_F20": "F20",
    "KEY_F21": "F21", "KEY_F22": "F22", "KEY_F23": "F23", "KEY_F24": "F24",
    "KEY_ENTER": "Enter", "KEY_SPACEBAR": "Space", "KEY_TAB": "Tab",
    "KEY_BACKSPACE": "Backspace", "KEY_DELETE": "Delete", "KEY_INSERT": "Insert",
    "KEY_ESCAPE": "Escape", "KEY_HOME": "Home", "KEY_END": "End",
    "KEY_PAGE_UP": "PageUp", "KEY_PAGE_DOWN": "PageDown",
    "KEY_UP_ARROW": "Up", "KEY_DOWN_ARROW": "Down",
    "KEY_LEFT_ARROW": "Left", "KEY_RIGHT_ARROW": "Right",
    "KEY_HYPEN": "-", "KEY_EQUAL": "=",
    "KEY_LEFT_BRACKET": "[", "KEY_RIGHT_BRACKET": "]",
    "KEY_SEMICOLON": ";", "KEY_APOSTROPHE": "'",
    "KEY_COMMA": ",", "KEY_PERIOD": ".", "KEY_SLASH": "/",
    "KEY_BACKSLASH": "\\", "KEY_GRAVE": "`",
    "KEY_CAPS_LOCK": "CapsLock", "KEY_NUM_LOCK": "NumLock",
    "KEY_SCROLL_LOCK": "ScrollLock",
    "KEY_PRINT_SCREEN": "PrintScreen", "KEY_PAUSE": "Pause",
}

MODIFIER_KEYS = {
    "KEY_LEFT_CTRL", "KEY_RIGHT_CTRL",
    "KEY_LEFT_SHIFT", "KEY_RIGHT_SHIFT",
    "KEY_LEFT_ALT", "KEY_RIGHT_ALT",
    "KEY_LEFT_GUI", "KEY_RIGHT_GUI",
}

MOUSE_ASSIGNMENT_MAP = {
    "LeftClick": "leftClick",
    "RightClick": "rightClick",
    "MiddleClick": "middleClick",
    "Menu": "rightClick",
    "Previous": "mouseBack",
    "Next": "mouseForward",
    "ScrollUp": "scrollUp",
    "ScrollDown": "scrollDown",
    "ScrollLeft": "scrollLeft",
    "ScrollRight": "scrollRight",
}

# ── Scancode → key name (for macro events) ──────────────────────────────────

SCANCODE_MAP = {
    1: "Escape", 2: "1", 3: "2", 4: "3", 5: "4", 6: "5", 7: "6", 8: "7",
    9: "8", 10: "9", 11: "0", 12: "-", 13: "=", 14: "Backspace", 15: "Tab",
    16: "Q", 17: "W", 18: "E", 19: "R", 20: "T", 21: "Y", 22: "U", 23: "I",
    24: "O", 25: "P", 26: "[", 27: "]", 28: "Enter", 29: "Ctrl", 30: "A",
    31: "S", 32: "D", 33: "F", 34: "G", 35: "H", 36: "J", 37: "K", 38: "L",
    39: ";", 40: "'", 41: "`", 42: "Shift", 43: "\\", 44: "Z", 45: "X",
    46: "C", 47: "V", 48: "B", 49: "N", 50: "M", 51: ",", 52: ".", 53: "/",
    54: "Shift", 55: "NumMul", 56: "Alt", 57: "Space", 58: "CapsLock",
    59: "F1", 60: "F2", 61: "F3", 62: "F4", 63: "F5", 64: "F6", 65: "F7",
    66: "F8", 67: "F9", 68: "F10", 69: "NumLock", 70: "ScrollLock",
    71: "Num7", 72: "Num8", 73: "Num9", 74: "NumMinus", 75: "Num4",
    76: "Num5", 77: "Num6", 78: "NumPlus", 79: "Num1", 80: "Num2",
    81: "Num3", 82: "Num0", 83: "NumDel",
    87: "F11", 88: "F12",
    91: "Win", 92: "Win",
    # Extended keys
    256 + 28: "NumEnter", 256 + 29: "RCtrl", 256 + 53: "NumDiv",
    256 + 55: "PrintScreen", 256 + 56: "RAlt",
    256 + 71: "Home", 256 + 72: "Up", 256 + 73: "PageUp",
    256 + 75: "Left", 256 + 77: "Right",
    256 + 79: "End", 256 + 80: "Down", 256 + 81: "PageDown",
    256 + 82: "Insert", 256 + 83: "Delete",
    256 + 91: "Win",
}


def gen_id() -> str:
    return str(uuid.uuid4())[:13]


def resolve_control_id(mapping: dict) -> str | None:
    input_type = mapping["inputType"]
    input_id = mapping["inputID"]

    if input_type == "KeyInput":
        return SIDE_PANEL_MAP.get(input_id)
    elif input_type == "MouseInput":
        return TOP_PANEL_MAP.get(input_id)
    elif input_type == "DKMInput":
        return DKM_MAP.get(input_id)
    return None


def parse_modifiers(modifiers: list[str]) -> dict:
    ctrl = any(k in ("KEY_LEFT_CTRL", "KEY_RIGHT_CTRL") for k in modifiers)
    shift = any(k in ("KEY_LEFT_SHIFT", "KEY_RIGHT_SHIFT") for k in modifiers)
    alt = any(k in ("KEY_LEFT_ALT", "KEY_RIGHT_ALT") for k in modifiers)
    win = any(k in ("KEY_LEFT_GUI", "KEY_RIGHT_GUI") for k in modifiers)
    return {"ctrl": ctrl, "shift": shift, "alt": alt, "win": win}


def convert_keyboard_group(kg: dict) -> dict | None:
    """Convert Synapse keyboardGroup to our shortcut action."""
    key_name = kg["key"]
    modifiers = kg.get("modifiers", [])

    # If the primary key IS a modifier, treat as modifier-only shortcut
    if key_name in MODIFIER_KEYS:
        mods = parse_modifiers(modifiers)
        # Add the "primary" modifier key
        if key_name in ("KEY_LEFT_CTRL", "KEY_RIGHT_CTRL"):
            mods["ctrl"] = True
        elif key_name in ("KEY_LEFT_SHIFT", "KEY_RIGHT_SHIFT"):
            mods["shift"] = True
        elif key_name in ("KEY_LEFT_ALT", "KEY_RIGHT_ALT"):
            mods["alt"] = True
        elif key_name in ("KEY_LEFT_GUI", "KEY_RIGHT_GUI"):
            mods["win"] = True

        our_key = ""
    else:
        our_key = KEY_NAME_MAP.get(key_name)
        if our_key is None:
            return None  # Unknown key
        mods = parse_modifiers(modifiers)

    parts = []
    if mods["ctrl"]: parts.append("Ctrl")
    if mods["shift"]: parts.append("Shift")
    if mods["alt"]: parts.append("Alt")
    if mods["win"]: parts.append("Win")
    if our_key: parts.append(our_key)
    pretty = " + ".join(parts) if parts else "Shortcut"

    action_id = gen_id()
    return {
        "action": {
            "id": action_id,
            "type": "shortcut",
            "payload": {"key": our_key, **mods},
            "pretty": pretty,
        },
        "action_id": action_id,
    }


def convert_text_block(tb: dict) -> dict:
    """Convert Synapse textBlockGroup to our textSnippet action."""
    action_id = gen_id()
    text = tb["text"]
    pretty = text[:30] if text else "Текст"
    return {
        "action": {
            "id": action_id,
            "type": "textSnippet",
            "payload": {"source": "inline", "text": text, "pasteMode": "sendText", "tags": []},
            "pretty": pretty,
        },
        "action_id": action_id,
    }


def convert_mouse_group(mg: dict) -> dict | None:
    """Convert Synapse mouseGroup to our mouseAction."""
    assignment = mg.get("mouseAssignment")
    our_action = MOUSE_ASSIGNMENT_MAP.get(assignment)
    if our_action is None:
        return None

    action_id = gen_id()
    return {
        "action": {
            "id": action_id,
            "type": "mouseAction",
            "payload": {"action": our_action},
            "pretty": f"Мышь: {assignment}",
        },
        "action_id": action_id,
    }


def convert_macro(macro_payload: dict, macro_name: str) -> dict | None:
    """Convert Synapse macro events to our sequence action."""
    events = macro_payload.get("macroEvents", [])
    steps: list[dict] = []

    for event in events:
        evt_type = event.get("Type")
        if evt_type == "actionBar":
            continue  # skip metadata

        # Delay
        if evt_type == 0:
            delay_sec = float(event.get("Number", 0))
            delay_ms = int(delay_sec * 1000)
            if delay_ms > 0 and steps:
                # Attach delay to previous step
                steps[-1]["delayAfterMs"] = delay_ms
            continue

        # Key event
        if evt_type == 1:
            ke = event.get("KeyEvent", {})
            scancode = ke.get("Makecode", 0)
            state = ke.get("State", 0)  # 0=down, 1=up, 2=extended down, 3=extended up
            if state in (2, 3):
                scancode += 256
            key = SCANCODE_MAP.get(scancode, f"SC{scancode}")

            # Only record key-down events as "send" steps
            if state in (0, 2):
                # Check if this is a modifier
                if key in ("Ctrl", "Shift", "Alt", "Win", "RCtrl", "RAlt"):
                    # Modifiers: build as part of combo — for now, represent as send
                    steps.append({"type": "send", "value": key})
                else:
                    steps.append({"type": "send", "value": key})
            continue

        # Mouse event
        if evt_type == 2:
            me = event.get("MouseEvent", {})
            btn = me.get("MouseButton", 0)
            state = me.get("State")
            if state == 0:  # down
                btn_name = {0: "LeftClick", 1: "RightClick", 2: "MiddleClick",
                            8: "ScrollUp", 9: "ScrollDown"}.get(btn, f"Mouse{btn}")
                steps.append({"type": "send", "value": btn_name})
            continue

    if not steps:
        return None

    action_id = gen_id()
    return {
        "action": {
            "id": action_id,
            "type": "sequence",
            "payload": {"steps": steps},
            "pretty": macro_name,
        },
        "action_id": action_id,
    }


def convert_mapping(mapping: dict, macros_by_guid: dict) -> dict | None:
    """Convert a single Synapse mapping to our action + binding info."""
    output_type = mapping["outputType"]

    if output_type == "hyperShiftGroup":
        return None  # Hypershift activator — not a binding

    if output_type == "keyboardGroup":
        return convert_keyboard_group(mapping["keyboardGroup"])

    if output_type == "textBlockGroup":
        return convert_text_block(mapping["textBlockGroup"])

    if output_type == "mouseGroup":
        return convert_mouse_group(mapping["mouseGroup"])

    if output_type == "macroGroup":
        mg = mapping["macroGroup"]
        guid = mg.get("guid")
        macro_name = mg.get("name", "Макрос")
        macro_payload = macros_by_guid.get(guid)
        if macro_payload:
            result = convert_macro(macro_payload, macro_name)
            if result:
                return result
        # Return None — caller will add warning about missing macro
        return None

    return None


def import_synapse4(filepath: str) -> dict:
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Decode macros
    macros_by_guid: dict[str, dict] = {}
    for macro in data.get("macros", []):
        payload = json.loads(base64.b64decode(macro["payload"]))
        guid = payload.get("guid")
        if guid:
            macros_by_guid[guid] = payload

    result = {
        "profiles": [],
        "actions": [],
        "bindings": [],
        "warnings": [],
    }

    for profile_data in data["profiles"]:
        profile_name = profile_data["name"]
        payload = json.loads(base64.b64decode(profile_data["payload"]))
        profile_id = gen_id()

        result["profiles"].append({
            "id": profile_id,
            "name": profile_name,
            "source": "synapse4-import",
        })

        all_mappings = payload.get("mappings", []) + \
                       payload.get("sidePanelMappings", {}).get("12ButtonSide", [])

        for mapping in all_mappings:
            control_id = resolve_control_id(mapping)
            if control_id is None:
                result["warnings"].append(
                    f"[{profile_name}] Unknown input: {mapping['inputType']}:{mapping['inputID']}"
                )
                continue

            layer = "hypershift" if mapping["isHyperShift"] else "standard"

            converted = convert_mapping(mapping, macros_by_guid)
            if converted is None:
                if mapping["outputType"] == "hyperShiftGroup":
                    pass  # Expected — hypershift activator, not a binding
                elif mapping["outputType"] == "macroGroup":
                    mg = mapping["macroGroup"]
                    result["warnings"].append(
                        f"[{profile_name}] Macro \"{mg.get('name','?')}\" "
                        f"(guid={mg.get('guid','?')}) not found in backup — "
                        f"skipping {control_id}/{layer}"
                    )
                else:
                    result["warnings"].append(
                        f"[{profile_name}] Unsupported output: {mapping['outputType']} "
                        f"for {control_id}/{layer}"
                    )
                continue

            action = converted["action"]
            action_id = converted["action_id"]

            # Avoid duplicate actions
            result["actions"].append(action)

            binding_id = gen_id()
            result["bindings"].append({
                "id": binding_id,
                "profileId": profile_id,
                "layer": layer,
                "controlId": control_id,
                "label": action["pretty"],
                "actionRef": action_id,
                "enabled": True,
            })

    return result


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <path-to-synapse4-file>", file=sys.stderr)
        sys.exit(1)

    filepath = sys.argv[1]
    if not Path(filepath).exists():
        print(f"File not found: {filepath}", file=sys.stderr)
        sys.exit(1)

    result = import_synapse4(filepath)

    # Print summary
    print(f"Profiles: {len(result['profiles'])}", file=sys.stderr)
    print(f"Actions:  {len(result['actions'])}", file=sys.stderr)
    print(f"Bindings: {len(result['bindings'])}", file=sys.stderr)

    if result["warnings"]:
        print(f"\nWarnings ({len(result['warnings'])}):", file=sys.stderr)
        for w in result["warnings"]:
            print(f"  ⚠ {w}", file=sys.stderr)

    # Print importable JSON to stdout
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
