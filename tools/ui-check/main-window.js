// Screenshot of the main window with a fake backend (mock.js + config.js), for
// playwright-cli run-code --filename=<this file>; the page it starts on must be the
// Vite server (its origin serves the two scripts). Run playwright-cli from the
// gitignored output/ folder: the screenshot lands in output/ui-check/, its own
// .playwright-cli/ scratch in output/.
async (page) => {
  const viewport = { width: 1280, height: 800 };
  const base = new URL(page.url()).origin;
  const script = async (name, marker) => {
    const response = await page.request.get(`${base}/tools/ui-check/${name}`);
    const text = await response.text();
    if (!response.ok() || !text.includes(marker)) throw new Error(`${base}/tools/ui-check/${name}: not served (run make-config.mjs; is ${base} the Vite server?)`);
    return text;
  };
  const config = await script("config.js", "window.__UI_CONFIG__");
  const mock = await script("mock.js", "__TAURI_INTERNALS__");

  const context = await page.context().browser().newContext({ viewport, deviceScaleFactor: 1 });
  try {
    const target = await context.newPage();
    const errors = [];
    target.on("pageerror", (error) => errors.push(error.message));
    await target.addInitScript({ content: config });
    await target.addInitScript({ content: mock });
    await target.goto(`${base}/`);
    // Loaded = the workspace replaced the "waiting for the config" panel.
    await target.waitForFunction(() => document.querySelector(".shell") && !document.querySelector(".workspace--1col .loading-spinner"), null, { timeout: 15000 });
    await target.evaluate(() => document.fonts.ready);
    const file = `ui-check/main-${viewport.width}x${viewport.height}.png`;
    await target.screenshot({ path: file });
    return { screenshot: file, unansweredCommands: await target.evaluate(() => [...window.__UI_CHECK__.unknown]), errors };
  } finally {
    await context.close();
  }
}
