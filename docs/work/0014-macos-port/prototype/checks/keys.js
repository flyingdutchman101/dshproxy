async page => {
  const url = "file://__REPO__/docs/work/0014-macos-port/prototype/index.html";
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(url);
  const r = [];
  const cur = () => page.evaluate(() => { const a = document.activeElement; return a ? `${a.tagName.toLowerCase()}#${a.id || ""}[${(a.getAttribute("aria-label") || a.textContent || "").trim().slice(0, 40)}]` : "none"; });
  // 1. Tab order on Chat > Accounts
  const order = [];
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  for (let i = 0; i < 26; i++) { await page.keyboard.press("Tab"); order.push(await cur()); }
  r.push("TAB ORDER (Chat > Accounts):\n  " + order.join("\n  "));
  // focus ring visible on a focused button?
  await page.focus("#accAdd"); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
  const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return `${document.activeElement.id}: outline ${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`; });
  r.push("FOCUS RING: " + ring);
  // 2. Arrow keys in tablist
  await page.focus("#tab-0"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
  r.push("ARROWS on tabs -> " + await cur() + " selected=" + await page.evaluate(() => document.querySelector('[role=tab][aria-selected=true]').id));
  await page.keyboard.press("Home");
  // 3. Dialog trap: sign-out confirm
  await page.focus("#acc-so-a2"); await page.keyboard.press("Enter");
  const inDlg = []; inDlg.push(await cur());
  for (let i = 0; i < 5; i++) { await page.keyboard.press("Tab"); inDlg.push(await cur()); }
  const trapped = await page.evaluate(() => document.getElementById("dlg").contains(document.activeElement));
  r.push("SIGN-OUT DIALOG focus sequence: " + inDlg.join(" -> ") + " | still inside: " + trapped);
  await page.keyboard.press("Escape");
  r.push("AFTER ESCAPE: dialog open=" + await page.evaluate(() => document.getElementById("dlg").open) + ", focus=" + await cur());
  // 4. Reset dialog: button disabled until RESET
  await page.focus("#acc-rs-a3"); await page.keyboard.press("Enter");
  const d0 = await page.evaluate(() => document.getElementById("rsUse").disabled);
  await page.keyboard.type("reset"); const d1 = await page.evaluate(() => document.getElementById("rsUse").disabled);
  await page.fill("#resetConfirm", " RESET "); const d2 = await page.evaluate(() => document.getElementById("rsUse").disabled);
  r.push(`RESET DIALOG: initial focus ${await cur()}; disabled empty=${d0}, 'reset'=${d1}, ' RESET '=${d2}`);
  const sh = []; for (let i = 0; i < 8; i++) { await page.keyboard.press("Shift+Tab"); sh.push(await cur()); }
  r.push("RESET DIALOG Shift+Tab: " + sh.join(" -> ") + " | inside: " + await page.evaluate(() => document.getElementById("dlg").contains(document.activeElement)));
  await page.keyboard.press("Escape");
  r.push("AFTER ESCAPE: focus=" + await cur());
  // 5. Menu-bar mock by keyboard
  await page.focus("#pMenu"); await page.keyboard.press("Enter");
  const mm = [await cur()]; for (let i = 0; i < 4; i++) { await page.keyboard.press("ArrowDown"); mm.push(await cur()); }
  r.push("MENU MOCK ArrowDown: " + mm.join(" -> "));
  await page.keyboard.press("Escape");
  r.push("MENU MOCK after Escape: open=" + await page.evaluate(() => document.getElementById("menuMock").open) + " focus=" + await cur());
  // 6. Stop with requests in flight asks first; Start comes back
  await page.click("#hStop"); r.push("STOP -> dialog: " + await page.evaluate(() => document.getElementById("dlgTitle") && document.getElementById("dlgTitle").textContent) + ", default focus " + await cur());
  await page.click("#dlgOk"); r.push("state chip after stop: " + await page.textContent("#stateChip"));
  r.push("Accounts page says: " + (await page.textContent("main h3")));
  await page.click("#npStart"); r.push("after Start: " + await page.textContent("#stateChip"));
  await page.waitForTimeout(2100); r.push("after 2 s: " + await page.textContent("#stateChip"));
  // 7. menu: Quit
  await page.click("#pMenu"); await page.click("[data-a=login]"); r.push("Start at login switch after menu toggle: " + await page.getAttribute("#fLogin", "aria-checked"));
  const errs = await page.evaluate(() => window.__errs || []);
  r.push("page errors captured: " + JSON.stringify(errs));
  return r.join("\n");
}
