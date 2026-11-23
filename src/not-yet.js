'use strict';
// What DSHProxy does on Windows but not yet on macOS (docs/work/0014-macos-port,
// stages B and C). Each part says so in one sentence and changes nothing.
// The one place to edit when a stage brings its part: remove its line here.
const NOT_YET = {
  // Stage B: video. Paid jobs, the video picker of the chat model list and
  // everything on the Krea route.
  video: 'Paid video is not available on macOS yet. Nothing was changed.',
  // Stage C: the video tools plugin for DeepSeek Harness.
  bundle: 'Installing the video plugin into DeepSeek Harness is not available on macOS yet. Nothing was changed.'
};

// The sentence for `part` on this system, or null when it is there.
function notYet(part, platform = process.platform) {
  if (platform !== 'darwin') return null;
  return NOT_YET[part] || null;
}

// Whether a `dshproxy video ...` command needs stage B. Help, the model list,
// the settings and entries, the offline quotes of the API routes and the
// saved keys need only the master key, and work.
function videoCommandWaits(args) {
  const [action] = args;
  if (['picker', 'submit', 'status', 'krea', 'balance'].includes(action)) return true;
  return action === 'quote' && args.includes('krea');
}

module.exports = { notYet, videoCommandWaits };
