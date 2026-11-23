'use strict';
// What DSHProxy does on Windows but not yet on macOS (docs/work/0014-macos-port,
// stage C). Each part says so in one sentence and changes nothing.
// The one place to edit when a stage brings its part: remove its line here.
const NOT_YET = {
  // Stage C: the video tools plugin for DeepSeek Harness.
  bundle: 'Installing the video plugin into DeepSeek Harness is not available on macOS yet. Nothing was changed.'
};

// The sentence for `part` on this system, or null when it is there.
function notYet(part, platform = process.platform) {
  if (platform !== 'darwin') return null;
  return NOT_YET[part] || null;
}

module.exports = { notYet };
