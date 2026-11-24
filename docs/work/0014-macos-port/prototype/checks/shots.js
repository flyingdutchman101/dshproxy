async page => {
  const dir = "__REPO__/docs/work/0014-macos-port/prototype/screenshots/";
  const url = "file://__REPO__/docs/work/0014-macos-port/prototype/index.html";
  const sizes = [[1280, 800], [860, 600]];
  const out = [];
  const shot = async (w, name) => { const f = `${dir}${w}-${name}.png`; await page.screenshot({ path: f }); out.push(`${w}-${name}`); };
  const click = sel => page.click(sel);
  const esc = () => page.keyboard.press("Escape");
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(url);
    const tabs = ["accounts", "keys", "lanes", "models", "harness", "log"];
    for (let i = 0; i < 6; i++) { await click(`#tab-${i}`); await shot(w, `chat-${tabs[i]}`); }
    await click("#ws-video");
    for (let i = 0; i < 5; i++) { await click(`#tab-${i}`); await shot(w, `video-${tabs[i]}`); }
    // dialogs
    await click("#ws-chat"); await click("#tab-0");
    await click("#accAdd"); await shot(w, "dlg-add-account-choose");
    await click("#tile-claude"); await page.waitForTimeout(900); await shot(w, "dlg-add-account-browser-opened");
    await click("#siMockOk"); await shot(w, "dlg-add-account-signed-in");
    await click("#siDone");
    await click("#acc-rs-a3"); await page.fill("#resetConfirm", "RESET"); await shot(w, "dlg-reset-typed");
    await esc();
    await click("#acc-so-a2"); await shot(w, "dlg-sign-out-confirm"); await esc();
    await click("#tab-1"); await click("#key-set-qwen"); await page.fill("#kValue", "sk-synthetic-0000"); await shot(w, "dlg-api-key"); await esc();
    await click("#hApply"); await shot(w, "dlg-apply-checklist"); await esc();
    await click("#uUpdate"); await shot(w, "dlg-update-confirm"); await esc();
    await click("#ws-video"); await click("#tab-2"); await click("#vroute-minimax-h3"); await shot(w, "dlg-video-route"); await esc();
    await click("#tab-0"); await click("#kSignIn"); await shot(w, "video-accounts-krea-signing-in"); await click("#kCancel");
    // states
    await click("#ws-chat"); await click("#tab-0");
    await page.selectOption("#pState", "stopped"); await shot(w, "state-stopped-accounts");
    await click("#tab-1"); await shot(w, "state-stopped-keys");
    await click("#tab-0");
    await page.selectOption("#pState", "starting"); await shot(w, "state-starting-accounts");
    await page.selectOption("#pState", "running");
    await page.selectOption("#pData", "empty"); await shot(w, "empty-accounts");
    await click("#tab-3"); await shot(w, "empty-models");
    await click("#tab-0"); await page.selectOption("#pData", "sample");
    await click("#pMenu"); await shot(w, "menu-bar-mock"); await esc();
  }
  return out.join("\n");
}
