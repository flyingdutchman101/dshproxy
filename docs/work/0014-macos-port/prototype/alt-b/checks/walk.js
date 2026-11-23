async page => {
  const SS = '__REPO__/docs/work/0014-macos-port/prototype/alt-b/screenshots/';
  const URL = 'file://__REPO__/docs/work/0014-macos-port/prototype/alt-b/index.html';
  const out = [];
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const dlg = () => page.locator('dialog[open]').last();
  const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: SS + PFX + '-' + name + '.png' }); out.push(PFX + '-' + name); };
  const tab = async (name) => { await page.getByRole('tab', { name, exact: true }).click(); };
  const ws = async (name) => { await page.getByRole('radio', { name: name + ' workspace' }).click(); };
  const esc = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(150); };
  // Check for elements that overflow their container horizontally (clipping).
  const overflow = async (label) => {
    const r = await page.evaluate(() => {
      const bad = [];
      const W = document.documentElement.clientWidth;
      for (const el of document.querySelectorAll('#app *, dialog[open] *')) {
        const b = el.getBoundingClientRect();
        if (b.width && (b.right > W + 1 || b.left < -1)) bad.push(el.tagName + '.' + el.className + ' ' + (el.textContent || '').slice(0, 30));
      }
      const doc = document.documentElement.scrollWidth > W ? 'page scrolls horizontally' : '';
      return bad.slice(0, 5).concat(doc ? [doc] : []);
    });
    if (r.length) out.push('OVERFLOW ' + PFX + ' ' + label + ': ' + r.join(' | '));
  };
  let PFX = '';
  for (const [w, hgt] of [[1280, 800], [860, 600]]) {
    PFX = w + 'x' + hgt;
    await page.setViewportSize({ width: w, height: hgt });
    await page.goto(URL);
    await page.waitForTimeout(300);
    // ---- Chat › Accounts
    await shot('chat-accounts'); await overflow('accounts');
    await page.locator('#pageBody').evaluate(el => el.scrollTop = el.scrollHeight);
    await shot('chat-accounts-scrolled');
    await page.getByRole('button', { name: 'Sign out of Claude (b@example.com)…' }).click();
    await shot('dialog-sign-out'); await esc();
    await page.getByRole('button', { name: 'Use a reset on ChatGPT (c@example.com)…' }).click();
    await shot('dialog-reset-disabled');
    const resetDisabledOk = await dlg().getByRole('button', { name: 'Use this reset' }).isDisabled();
    await dlg().getByLabel('Type RESET to confirm:').fill('reset');
    const lowerStillDisabled = await dlg().getByRole('button', { name: 'Use this reset' }).isDisabled();
    await dlg().getByLabel('Type RESET to confirm:').fill('RESET');
    const enabledAfter = await dlg().getByRole('button', { name: 'Use this reset' }).isEnabled();
    out.push(`reset button: disabled at open=${resetDisabledOk}, disabled with "reset"=${lowerStillDisabled}, enabled with "RESET"=${enabledAfter}`);
    await shot('dialog-reset-typed'); await esc();
    await page.getByRole('button', { name: '+ Add account' }).first().click();
    await shot('dialog-add-choose');
    await dlg().getByRole('button', { name: /Kimi/ }).click();
    await page.waitForTimeout(1100);
    await shot('dialog-add-waiting-kimi');
    await dlg().getByRole('button', { name: 'Simulate: signed in' }).click();
    await shot('dialog-add-success');
    await dlg().getByRole('button', { name: 'Done' }).click();
    // ---- API keys
    await tab('API keys'); await shot('chat-keys'); await overflow('keys');
    await page.getByRole('button', { name: 'Add or replace key' }).click();
    const keyType = await dlg().getByLabel('API key for DeepSeek:').getAttribute('type');
    out.push('key field type=' + keyType);
    await dlg().getByLabel('API key for DeepSeek:').fill('sk-synthetic-not-a-key');
    await shot('dialog-key'); await esc();
    // ---- Lanes
    await tab('Lanes'); await shot('chat-lanes'); await overflow('lanes');
    await page.getByRole('button', { name: 'Cheap production' }).click();
    await shot('dialog-preset'); await dlg().getByRole('button', { name: 'Yes' }).click();
    await shot('chat-lanes-cheap');
    // ---- Models
    await tab('Models'); await shot('chat-models'); await overflow('models');
    await page.getByRole('button', { name: 'Use claude-fable-5-3' }).click();
    await shot('dialog-use-newer'); await esc();
    // ---- DeepSeek Harness
    await tab('DeepSeek Harness'); await shot('chat-harness'); await overflow('harness');
    await page.getByRole('button', { name: 'Preview changes' }).click(); await shot('dialog-preview'); await esc();
    await page.getByRole('button', { name: 'Verify', exact: true }).click(); await shot('dialog-verify'); await esc();
    await page.getByRole('button', { name: 'Remove from DeepSeek Harness' }).click(); await shot('dialog-remove'); await esc();
    await page.getByRole('button', { name: 'Apply to DeepSeek Harness' }).click();
    await page.waitForTimeout(700);
    await shot('dialog-apply-checklist');
    await dlg().getByRole('button', { name: 'Apply', exact: true }).click();
    await shot('dialog-apply-quit-harness');
    await dlg().getByRole('button', { name: 'Simulate: DeepSeek Harness has quit' }).click();
    await shot('dialog-apply-result');
    await dlg().getByRole('button', { name: 'OK' }).click();
    // ---- Log
    await tab('Log'); await page.waitForTimeout(2800); await shot('log');
    // ---- Video
    await ws('Video');
    await tab('Accounts'); await shot('video-accounts'); await overflow('v-accounts');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await shot('dialog-krea-sign-out');
    await dlg().getByRole('button', { name: 'Yes' }).click();
    await page.getByRole('button', { name: 'Sign in to Krea…' }).click(); await shot('video-accounts-signing-in');
    await page.getByRole('button', { name: 'Simulate: consent given in the browser' }).click();
    await tab('API keys'); await shot('video-keys'); await overflow('v-keys');
    await page.getByRole('button', { name: 'Add or replace key…' }).click();
    await dlg().getByLabel('API key for VideoRouter:').fill('has space');
    await dlg().getByRole('button', { name: 'Save' }).click();
    await shot('dialog-video-key-invalid'); await esc();
    await tab('Lanes'); await shot('video-lanes'); await overflow('v-lanes');
    await page.getByRole('radio', { name: 'seedance-2.0' }).check();
    await page.getByRole('button', { name: 'Change billing route…' }).click(); await shot('dialog-route');
    await dlg().getByLabel('Charge seedance-2.0 to:').selectOption('kovapi');
    await dlg().getByRole('button', { name: 'Save route' }).click();
    await tab('Models'); await shot('video-models'); await overflow('v-models');
    await tab('DeepSeek Harness'); await shot('video-harness'); await overflow('v-harness');
    await ws('Chat'); await tab('Accounts');
    // ---- Backend update / rollback
    await page.getByRole('button', { name: 'Update…' }).click(); await shot('dialog-update');
    await dlg().getByRole('button', { name: 'Yes' }).click(); await page.waitForTimeout(300); await shot('update-busy');
    await page.waitForSelector('dialog[open] >> text=passed the trial run', { timeout: 6000 });
    await shot('dialog-update-result'); await dlg().getByRole('button', { name: 'OK' }).click();
    await page.waitForTimeout(1800); await shot('update-rollback-bar');
    await page.getByRole('button', { name: 'Roll back…' }).click(); await shot('dialog-rollback'); await esc();
    // ---- Stop with requests in flight, then stopped state
    await page.getByRole('button', { name: 'Stop', exact: true }).click(); await shot('dialog-stop-in-flight');
    await dlg().getByRole('button', { name: 'Yes' }).click();
    await shot('stopped-accounts'); await tab('API keys'); await shot('stopped-keys'); await tab('Accounts');
    await page.getByRole('button', { name: 'Start', exact: true }).first().click();
    await page.waitForTimeout(300); await shot('starting-accounts');
    await page.waitForTimeout(1800);
    // ---- Scenarios
    await page.selectOption('#scenario', 'empty'); await shot('empty-accounts');
    await tab('API keys'); await shot('empty-keys'); await tab('Models'); await shot('empty-models'); await tab('Accounts');
    await page.selectOption('#scenario', 'notanswering'); await shot('not-answering-accounts');
    await page.selectOption('#scenario', 'sample');
    // ---- Menu-bar mock
    await page.getByRole('button', { name: 'Menu bar (mock)' }).click(); await shot('menubar-mock');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    const focused = await page.evaluate(() => document.activeElement.textContent);
    out.push('menu focus after 2×ArrowDown: ' + focused);
    await esc();
    const mbClosed = await page.locator('dialog.mb').count();
    out.push('menu mock open after Escape: ' + mbClosed);
    await page.getByRole('button', { name: 'Menu bar (mock)' }).click();
    await page.getByRole('menuitem', { name: 'Quit' }).click(); await shot('dialog-quit');
    await dlg().getByRole('button', { name: 'Yes' }).click(); await shot('quit');
  }
  out.push('errors: ' + JSON.stringify(errors));
  return out.join('\n');
}
