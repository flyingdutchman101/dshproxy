async page => {
  const url = "file://__REPO__/docs/work/0014-macos-port/prototype/index.html";
  const audit = () => page.evaluate(() => {
    const p = [];
    const name = el => (el.getAttribute("aria-label") || (el.getAttribute("aria-labelledby") || "").split(" ").map(i => (document.getElementById(i) || {}).textContent || "").join(" ") || el.textContent || "").trim();
    document.querySelectorAll("button,[role=switch],[role=tab],[role=radio],[role^=menuitem]").forEach(b => { if (!name(b)) p.push("no name: " + b.outerHTML.slice(0, 80)); });
    document.querySelectorAll("input,select").forEach(i => { if (i.type === "radio") { if (!i.closest("label")) p.push("radio without label"); return; }
      if (!(i.labels && i.labels.length) && !i.getAttribute("aria-label") && !i.getAttribute("aria-labelledby") && !i.closest("label")) p.push("unlabelled input #" + i.id); });
    const ids = {}; document.querySelectorAll("[id]").forEach(e => ids[e.id] = (ids[e.id] || 0) + 1);
    Object.entries(ids).forEach(([k, v]) => { if (v > 1) p.push("duplicate id " + k); });
    document.querySelectorAll("[aria-labelledby],[aria-describedby],[aria-controls]").forEach(e => ["aria-labelledby", "aria-describedby", "aria-controls"].forEach(a => (e.getAttribute(a) || "").split(" ").filter(Boolean).forEach(i => { if (!document.getElementById(i)) p.push(`${a} -> missing #${i}`); })));
    const m = document.getElementById("main"); if (m && m.scrollWidth > m.clientWidth + 1) p.push(`main overflows horizontally ${m.scrollWidth}>${m.clientWidth}`);
    if (document.documentElement.scrollWidth > innerWidth + 1) p.push("page overflows horizontally");
    document.querySelectorAll("button").forEach(b => { if (b.offsetParent && b.scrollWidth > b.clientWidth + 1) p.push("button text clipped: " + b.textContent.trim().slice(0, 30)); });
    return p;
  });
  const out = [];
  for (const [w, h] of [[1280, 800], [860, 600]]) {
    await page.setViewportSize({ width: w, height: h }); await page.goto(url);
    for (const ws of ["chat", "video"]) {
      await page.click("#ws-" + ws);
      for (let i = 0; i < 6; i++) { await page.click("#tab-" + i); const p = await audit(); out.push(`${w} ${ws}/${i}: ${p.length ? p.join("; ") : "ok"}`); }
    }
    await page.click("#ws-chat"); await page.click("#tab-0");
    const dialogs = [["#accAdd", "add account"], ["#acc-rs-a3", "reset"], ["#hApply", "apply"], ["#uUpdate", "update"], ["#acc-so-a1", "sign out"]];
    for (const [sel, n] of dialogs) { await page.click(sel); const p = await audit(); out.push(`${w} dialog ${n}: ${p.length ? p.join("; ") : "ok"}`); await page.keyboard.press("Escape"); }
    await page.click("#tab-1"); await page.click("#key-set-zai"); out.push(`${w} dialog key: ${(await audit()).join("; ") || "ok"}`); await page.keyboard.press("Escape");
    await page.click("#pMenu"); out.push(`${w} menu mock: ${(await audit()).join("; ") || "ok"}`); await page.keyboard.press("Escape");
    for (const st of ["stopped", "starting", "notanswering"]) { await page.selectOption("#pState", st); for (const i of [0, 1, 2, 4]) { await page.click("#tab-" + i); const p = await audit(); if (p.length) out.push(`${w} ${st}/${i}: ${p.join("; ")}`); } }
    out.push(`${w} states checked`);
    await page.selectOption("#pState", "running"); await page.selectOption("#pData", "empty");
    for (const ws of ["chat", "video"]) { await page.click("#ws-" + ws); for (let i = 0; i < 5; i++) { await page.click("#tab-" + i); const p = await audit(); if (p.length) out.push(`${w} empty ${ws}/${i}: ${p.join("; ")}`); } }
    out.push(`${w} empty checked`);
  }
  return out.join("\n");
}
