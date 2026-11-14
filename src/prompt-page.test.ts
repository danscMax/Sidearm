import { beforeEach, expect, it } from "vitest";
import source from "../public/prompt.js?raw";

type View = { generation: number; title: string; fields: string[]; submit: string; hint: string };
let render: (event: { payload: View }) => void;
const calls: { command: string; args: Record<string, unknown> }[] = [];

beforeEach(async () => {
  calls.length = 0;
  const root = document.createElement("div");
  root.id = "prompt";
  document.body.replaceChildren(root);
  Object.assign(window, { __TAURI_INTERNALS__: {
    invoke: (command: string, args: Record<string, unknown>) => { calls.push({ command, args }); return Promise.resolve(); },
    transformCallback: (handler: typeof render) => { render = handler; return 1; },
  } });
  new Function("window", "document", source)(window, document);
  await Promise.resolve();
});

const key = (target: Element, name: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));

it("asks each field, Enter moves on and finally sends the values", () => {
  expect(calls.at(-1)?.command).toBe("prompt_ready");
  render({ payload: { generation: 3, title: "SSH", fields: ["user", "host"], submit: "Insert", hint: "Enter" } });
  expect(calls.at(-1)?.command).toBe("prompt_layout");
  const [user, host] = [...document.querySelectorAll<HTMLInputElement>("input")];
  user.value = "admin";
  host.value = "server5";
  key(user, "Enter");
  expect(calls.at(-1)?.command).toBe("prompt_layout"); // the first Enter only moved on
  key(host, "Enter");
  expect(calls.at(-1)).toEqual({ command: "prompt_submit", args: { generation: 3, values: { user: "admin", host: "server5" } } });
});

it("Esc sends nothing", () => {
  render({ payload: { generation: 4, title: "T", fields: ["x"], submit: "Insert", hint: "" } });
  key(document.querySelector("input")!, "Escape");
  expect(calls.at(-1)).toEqual({ command: "prompt_cancel", args: { generation: 4 } });
});
