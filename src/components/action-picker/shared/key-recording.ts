import { setKeyRecording } from "../../../lib/backend";

let users = 0;
let pending: Promise<void> = Promise.resolve();

function syncRecording(): Promise<void> {
  pending = pending.catch(() => {}).then(() => setKeyRecording(users > 0));
  return pending;
}

/** Keep the shared backend mode on until every capture owner has released it. */
export function acquireKeyRecording() {
  users += 1;
  const ready = users === 1 ? syncRecording() : pending;
  let released = false;
  return {
    ready,
    release(): Promise<void> {
      if (released) return pending;
      released = true;
      users -= 1;
      return users === 0 ? syncRecording() : pending;
    },
  };
}
