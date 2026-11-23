async page => {
  const URL = 'file://__REPO__/docs/work/0014-macos-port/prototype/alt-b/index.html';
  const out = [];
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(URL);
  await page.waitForTimeout(300);
  const desc = () => page.evaluate(() => {
    const el = document.activeElement;
    const cs = getComputedStyle(el);
    const ring = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 || cs.boxShadow !== 'none';
    const name = el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].textContent) || el.textContent || el.id;
    return `${el.tagName.toLowerCase()}${el.getAttribute('role') ? '[' + el.getAttribute('role') + ']' : ''} "${(name || '').trim().slice(0, 40)}" ring=${ring}`;
  });
  // 1. Tab order through the whole window
  await page.mouse.click(5, 790);
  const order = [];
  for (let i = 0; i < 34; i++) { await page.keyboard.press('Tab'); order.push(await desc()); }
  out.push('TAB ORDER (Accounts page, 1280x800):\n  ' + order.join('\n  '));
  // 2. Arrow keys on the section strip and the workspace switch
  await page.getByRole('tab', { name: 'Accounts' }).focus();
  await page.keyboard.press('ArrowRight');
  out.push('ArrowRight on strip -> ' + await desc() + ' title=' + await page.textContent('#pageTitle'));
  await page.keyboard.press('End');
  out.push('End on strip -> ' + await desc());
  await page.getByRole('radio', { name: 'Chat workspace' }).focus();
  await page.keyboard.press('ArrowRight');
  out.push('ArrowRight on workspace -> ' + await desc() + ' title=' + await page.textContent('#pageTitle'));
  await page.keyboard.press('ArrowLeft');
  await page.getByRole('tab', { name: 'Accounts' }).click();
  // 3. Dialog focus trap and Escape
  const opener = page.getByRole('button', { name: '+ Add account' });
  await opener.focus(); await page.keyboard.press('Enter');
  const inside = [];
  for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); inside.push(await page.evaluate(() => !!document.activeElement.closest('dialog[open]'))); }
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Shift+Tab'); inside.push(await page.evaluate(() => !!document.activeElement.closest('dialog[open]'))); }
  out.push('Add account dialog: focus stayed inside for 12 Tab + 4 Shift+Tab: ' + inside.every(Boolean));
  await page.keyboard.press('Escape');
  out.push('After Escape: dialog open=' + await page.locator('dialog[open]').count() + ', focus -> ' + await desc());
  // Same for the reset dialog and a Yes/No box
  await page.getByRole('button', { name: /Use a reset on ChatGPT/ }).focus(); await page.keyboard.press('Enter');
  out.push('Reset dialog initial focus -> ' + await desc());
  const ins2 = [];
  for (let i = 0; i < 10; i++) { await page.keyboard.press('Tab'); ins2.push(await page.evaluate(() => !!document.activeElement.closest('dialog[open]'))); }
  out.push('Reset dialog trap: ' + ins2.every(Boolean));
  await page.keyboard.press('Escape');
  out.push('After Escape: dialog open=' + await page.locator('dialog[open]').count() + ', focus -> ' + await desc());
  await page.getByRole('button', { name: 'Sign out of Claude (a@example.com)…' }).focus(); await page.keyboard.press('Enter');
  out.push('Sign-out box initial focus (safe answer) -> ' + await desc());
  await page.keyboard.press('Escape');
  out.push('After Escape: accounts still 5 = ' + (await page.locator('article.card').count() === 5));
  // 4. Static semantic checks across every page and both workspaces
  const issues = new Set();
  const check = async (where) => {
    const r = await page.evaluate(() => {
      const bad = [];
      const ids = {};
      document.querySelectorAll('[id]').forEach(e => { ids[e.id] = (ids[e.id] || 0) + 1; });
      Object.entries(ids).forEach(([k, v]) => { if (v > 1) bad.push('duplicate id ' + k); });
      document.querySelectorAll('input,select,textarea').forEach(e => {
        const name = e.getAttribute('aria-label') || (e.labels && e.labels.length && e.labels[0].textContent.trim()) || (e.getAttribute('aria-labelledby') && document.getElementById(e.getAttribute('aria-labelledby')));
        if (!name) bad.push('unlabelled ' + e.tagName + ' ' + (e.id || e.name || e.type));
      });
      document.querySelectorAll('button').forEach(b => { if (!(b.getAttribute('aria-label') || b.textContent.trim())) bad.push('button without name'); if (!b.getAttribute('type')) bad.push('button without type: ' + b.textContent.trim().slice(0, 20)); });
      document.querySelectorAll('img').forEach(i => { if (!i.hasAttribute('alt')) bad.push('img without alt'); });
      document.querySelectorAll('[onclick], div[tabindex], span[tabindex]').forEach(e => bad.push('non-button clickable ' + e.tagName));
      document.querySelectorAll('[aria-labelledby]').forEach(e => e.getAttribute('aria-labelledby').split(' ').forEach(id => { if (!document.getElementById(id)) bad.push('aria-labelledby missing target ' + id); }));
      document.querySelectorAll('[aria-describedby]').forEach(e => e.getAttribute('aria-describedby').split(' ').forEach(id => { if (!document.getElementById(id)) bad.push('aria-describedby missing target ' + id); }));
      return bad;
    });
    r.forEach(x => issues.add(where + ': ' + x));
  };
  for (const w of ['Chat', 'Video']) {
    await page.getByRole('radio', { name: w + ' workspace' }).click();
    for (const t of ['Accounts', 'API keys', 'Lanes', 'Models', 'DeepSeek Harness', 'Log']) { await page.getByRole('tab', { name: t, exact: true }).click(); await check(w + '/' + t); }
  }
  await page.getByRole('radio', { name: 'Chat workspace' }).click();
  await page.getByRole('tab', { name: 'API keys', exact: true }).click();
  await page.getByRole('button', { name: 'Add or replace key' }).click(); await check('key dialog'); await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Accounts', exact: true }).click();
  await page.getByRole('button', { name: /Use a reset on ChatGPT/ }).click(); await check('reset dialog'); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Menu bar (mock)' }).click(); await check('menu mock'); await page.keyboard.press('Escape');
  out.push('SEMANTIC CHECK issues: ' + (issues.size ? '\n  ' + [...issues].join('\n  ') : 'none'));
  // 5. Contrast of key text pairs (WCAG ratio, against the solid colour under glass)
  const contrast = await page.evaluate(() => {
    const L = hex => { const c = hex.match(/\w\w/g).map(x => parseInt(x, 16) / 255).map(v => v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4)); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
    const r = (a, b) => { const x = L(a), y = L(b); return ((Math.max(x, y) + .05) / (Math.min(x, y) + .05)).toFixed(2); };
    const bg = '0A1D26';
    return { text: r('F5FCFB', bg), muted: r('B4CCD4', bg), faint: r('86A0AA', bg), ok: r('5BDCA8', bg), warn: r('F2C14E', bg), bad: r('F27C6C', bg), brass: r('E4B26A', bg), inkOnBrass: r('1E1403', 'E4B26A'), whiteOnResetRed: r('FFFFFF', 'B9473A'), disabled: r('6F8791', bg) };
  });
  out.push('CONTRAST (approx., on #0A1D26): ' + JSON.stringify(contrast));
  return out.join('\n');
}
