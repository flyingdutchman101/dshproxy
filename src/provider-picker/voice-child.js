'use strict';
// The sole credential-resolving process. Sensitive input arrives via IPC, never argv.
// A lost parent cannot leave an orphan submitting or retaining paid output.
process.once('disconnect', () => process.exit(1));
process.once('message', async input => {
  try {
    const home = process.env.DSHPROXY_HOME;
    const enabledIds = () => require('./voice').entries(home).map(m => 'elevenlabs:tts:' + m.model);
    if (!process.connected || !enabledIds().includes(input.entryId)) throw Error();
    const picker = require('../voice/picker').createVoicePicker({enabledIds: enabledIds()});
    const proposal = picker.prepare(input);
    if (!process.connected || !enabledIds().includes(input.entryId)) throw Error();
    const result = await picker.execute({...proposal, confirmCharge: true});
    if (!process.connected) throw Error();
    const audio = picker.output(result.outputId).bytes;
    process.send({audio: audio.toString('base64')}, () => process.exit(0));
  } catch { process.exit(1); }
});
// Parent rechecks cancellation before sending any sensitive input.
process.send({ready: true});
