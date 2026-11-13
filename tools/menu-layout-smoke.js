// Open public/menu.html with playwright-cli, then run-code --filename=<this file>.
// Run from a gitignored artifact directory. Only Tauri IPC is replaced; HTML/CSS/layout stay real.
async (page) => {
  const install = async target => {
    await target.addInitScript(() => {
      window.__menuLayouts = [];
      window.__TAURI_INTERNALS__ = {
        transformCallback: callback => { window.__menuRender = callback; return 1; },
        invoke: async (command, args) => {
          if (command === "menu_layout") window.__menuLayouts.push(args);
        },
      };
    });
    await target.goto(page.url());
    await target.evaluate(() => window.__menuRender({ payload: {
        generation: 1, title: "Layout regression", parent: null, query: "", highlight: 79,
        placeholder: "Search", empty: "Empty", pickModes: ["Run", "Enter", "Copy", "Edit"], maxHeight: 900,
        items: Array.from({ length: 80 }, (_, i) => ({ label: `Phrase ${i + 1}`, number: i + 1, enabled: true, submenu: false })),
      } }));
  };
  const measure = async (target, dpr) => {
    await target.waitForFunction(expected => {
      const root = document.getElementById("menu");
      return window.devicePixelRatio === expected && root.style.getPropertyValue("--menu-max-height") === `${900 / expected}px`;
    }, dpr);
    const measured = await target.evaluate(() => {
      const root = document.getElementById("menu").getBoundingClientRect();
      const rows = document.querySelector(".rows");
      const viewport = rows.getBoundingClientRect();
      const last = document.querySelectorAll(".row")[79].getBoundingClientRect();
      return {
        dpr: window.devicePixelRatio, physicalHeight: root.height * window.devicePixelRatio,
        rootTop: root.top, rootBottom: root.bottom, viewportHeight: window.innerHeight, documentScroll: window.scrollY,
        rowsTop: viewport.top, rowsBottom: viewport.bottom, lastTop: last.top, lastBottom: last.bottom,
        scrollTop: rows.scrollTop, ipcHeight: window.__menuLayouts.at(-1).height,
      };
    });
    if (measured.physicalHeight > 901 || measured.ipcHeight > 900 || measured.scrollTop <= 0
        || measured.rootTop < 0 || measured.rootBottom > measured.viewportHeight + 1 || measured.documentScroll !== 0
        || measured.lastTop < measured.rowsTop - 1 || measured.lastBottom > measured.rowsBottom + 1) {
      throw new Error(`80-row menu is clipped: ${JSON.stringify(measured)}`);
    }
    return measured;
  };
  const measurements = [];
  for (const dpr of [1, 2.25]) {
    const context = await page.context().browser().newContext({
      viewport: { width: Math.floor(1600 / dpr), height: Math.floor(900 / dpr) }, deviceScaleFactor: dpr,
    });
    try {
      const target = await context.newPage();
      await install(target);
      measurements.push(await measure(target, dpr));
      await target.screenshot({ path: `P01-r2-layout-${dpr}.png` });
      if (dpr === 1) {
        const cdp = await context.newCDPSession(target);
        for (const changed of [2.25, 1]) {
          await cdp.send("Emulation.setDeviceMetricsOverride", {
            width: Math.floor(1600 / changed), height: Math.floor(900 / changed), deviceScaleFactor: changed, mobile: false,
          });
          measurements.push(await measure(target, changed));
        }
        await cdp.detach();
      }
    } finally {
      await context.close();
    }
  }
  return measurements;
}
