async page => {
  const dir = "__REPO__/docs/work/0014-macos-port/prototype/screenshots/";
  const url = "file://__REPO__/docs/work/0014-macos-port/prototype/index.html";
  await page.setViewportSize({ width: 1280, height: 800 }); await page.goto(url);
  const r = []; const ok = (c, m) => r.push(`${c ? "PASS" : "FAIL"} ${m}`);
  const txt = s => page.textContent(s); const has = async s => (await page.$(s)) !== null;
  const title = () => page.evaluate(() => (document.getElementById("dlgTitle") || {}).textContent || null);
  // accounts
  await page.click("#acc-pz-a2"); ok((await txt("#acc-pz-a2")) === "Resume", "Pause -> Resume label");
  ok((await page.textContent("main")).includes("Paused: DSHProxy does not use this account"), "paused note shown");
  await page.click("#acc-pz-a2");
  await page.click("#acc-mp-a2"); ok(await has("#acc-np-a2") && await has("#acc-mp-a1"), "Make primary swaps primary");
  await page.click("#acc-so-a4"); ok((await title()) === "Sign out", "Sign out asks"); await page.click("#dlgCancel"); ok(await has("#acc-so-a4"), "Cancel keeps account");
  await page.click("#acc-so-a4"); await page.click("#dlgOk"); ok(!(await has("#acc-so-a4")), "Confirm removes account");
  await page.click("#accAdd"); await page.click("#tile-kimi"); await page.waitForTimeout(900);
  ok((await page.textContent("#dlg")).includes("KQ7M-4XPD"), "Kimi device code shown");
  await page.click("#siMockFail"); ok((await title()).includes("did not finish"), "failure screen");
  await page.click("#siRetry"); await page.waitForTimeout(900); await page.click("#siMockOk"); ok((await page.textContent("#dlg")).includes("Signed in to Kimi"), "success screen");
  await page.click("#siDone"); ok((await page.textContent("main")).includes("f@example.com"), "new account card appears");
  await page.click("#acc-rs-a3"); await page.fill("#resetConfirm", "RESET"); await page.click("#rsUse");
  ok((await title()) === "Limit reset", "reset result shown"); await page.click("#dlgOkOnly");
  ok((await page.textContent("main")).includes("⚠ 1 limit reset"), "one reset left after using one");
  // keys + restart wait
  await page.click("#tab-1"); await page.click("#key-set-deepseek"); ok(await page.isDisabled("#kSave"), "Save disabled while empty");
  await page.fill("#kValue", "sk-synthetic"); await page.click("#kSave"); ok((await title()) === "Restart gateway?", "restart question after key save");
  await page.click("#rqNow"); ok((await title()) === "Restart gateway", "restart waits for in-flight requests");
  await page.screenshot({ path: dir + "1280-dlg-restart-wait.png" });
  await page.waitForTimeout(3200); ok(["● Starting", "● Running"].includes((await txt("#stateChip")).trim()), "gateway restarts after wait");
  await page.waitForTimeout(2000);
  await page.click("#key-rm-openrouter"); await page.click("#dlgOk"); await page.click("#rqLater"); ok((await page.textContent("main")).includes("Not set"), "key removed");
  // lanes
  await page.click("#tab-2"); await page.click("#pr-cheap"); await page.click("#dlgOk"); ok((await page.getAttribute("#pr-cheap", "aria-pressed")) === "true", "preset Cheap production active");
  ok(!(await page.textContent("main")).includes("gpt-6-astra"), "cheap ladders drop GPT");
  // models
  await page.click("#pr-balanced"); await page.click("#dlgOk");
  await page.click("#tab-3"); await page.click("#md-claude-haiku-5-5"); ok((await page.getAttribute("#md-claude-haiku-5-5", "aria-checked")) === "false", "model switched off");
  await page.click("#mdUse"); await page.click("#dlgOk"); ok(!(await has("#mdUse")), "suggestion used and gone");
  await page.click("#tab-2"); ok((await page.textContent("main")).includes("claude-opus-5-6") && (await page.getAttribute("#pr-custom", "aria-pressed")) === "true", "ladder now has opus-5-6, routing Custom");
  await page.screenshot({ path: dir + "1280-chat-lanes-custom.png" });
  // harness
  await page.click("#tab-4"); await page.click("#hvVerify"); ok((await title()) === "Verify DeepSeek Harness", "verify result"); await page.screenshot({ path: dir + "1280-dlg-verify-result.png" }); await page.keyboard.press("Escape");
  await page.click("#hvPreview"); ok((await title()) === "Preview", "preview"); await page.keyboard.press("Escape");
  await page.click("#hvRemove"); await page.click("#dlgOk"); await page.keyboard.press("Escape"); ok((await page.textContent("main")).includes("Not applied"), "remove -> Not applied");
  await page.click("#hApply"); await page.click("#apGo"); await page.waitForTimeout(1400); ok((await title()) === "DeepSeek Harness is set up", "apply result");
  await page.screenshot({ path: dir + "1280-dlg-apply-result.png" }); await page.click("#apOk");
  ok(!(await page.textContent("main")).includes("Not applied"), "profiles applied again");
  // update / rollback
  await page.click("#uUpdate"); await page.click("#dlgOk"); ok((await page.textContent("#upd")).includes("Downloading"), "update in progress text");
  await page.waitForTimeout(2500); ok((await title()) === "Update CLIProxyAPI", "update result"); await page.screenshot({ path: dir + "1280-dlg-update-result.png" }); await page.click("#dlgOkOnly");
  await page.waitForTimeout(1700); ok((await page.textContent("#upd")).includes("previous version 6.9.2"), "rollback bar shown"); await page.screenshot({ path: dir + "1280-update-bar-rollback.png" });
  await page.click("#uRollback"); await page.click("#dlgOk"); await page.waitForTimeout(1700); ok((await page.textContent("#upd")).includes("6.10.0 is available"), "rolled back");
  // video
  await page.click("#ws-video"); await page.click("#tab-1"); await page.click("#vkey-set-kovapi"); await page.fill("#kValue", "has space"); await page.click("#kSave");
  ok((await txt("#kErr")).includes("printable"), "video key validation message"); await page.screenshot({ path: dir + "1280-dlg-video-key-invalid.png" }); await page.fill("#kValue", "kov-synthetic"); await page.click("#kSave");
  ok((await page.textContent("main")).includes("Remove…"), "video key saved");
  await page.click("#tab-3"); await page.click("#vm-seedance-2-lite"); ok((await title()) === "Video billing route", "switching on without a route asks for one");
  ok(await page.isDisabled("#rtSave"), "Save route disabled until chosen"); await page.selectOption("#rtSel", "kovapi"); await page.click("#rtSave");
  ok((await page.getAttribute("#vm-seedance-2-lite", "aria-checked")) === "true", "model enabled with route");
  await page.click("#tab-2"); await page.click("#vroute-minimax-h3"); await page.selectOption("#rtSel", "callirra"); await page.click("#rtSave"); ok((await page.textContent("main")).includes("Callirra · callirra"), "route saved");
  await page.click("#tab-0"); await page.click("#kSignOut"); await page.click("#dlgOk"); ok((await page.textContent("main")).includes("Not signed in"), "Krea signed out");
  await page.click("#kSignIn"); await page.click("#kMockOk"); ok((await page.textContent("main")).includes("Signed in · until"), "Krea signed in");
  // log grows
  await page.click("#tab-5"); const n1 = (await txt("#logpre")).split("\n").length; await page.waitForTimeout(3000); const n2 = (await txt("#logpre")).split("\n").length; ok(n2 > n1, `log grows live (${n1} -> ${n2} lines)`);
  // not answering stop variant, quit
  await page.selectOption("#pState", "notanswering"); await page.click("#hStop"); ok((await page.textContent("#dlg")).includes("did not answer"), "not-answering stop text"); await page.keyboard.press("Escape");
  await page.selectOption("#pState", "running");
  await page.click("#pMenu"); await page.click("[data-a=quit]"); ok((await title()) === "Quit DSHProxy", "quit asks with requests in flight"); await page.click("#dlgOk");
  ok((await page.textContent("body")).includes("DSHProxy has quit"), "quit screen"); await page.screenshot({ path: dir + "1280-quit.png" });
  return r.join("\n");
}
