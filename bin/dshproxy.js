#!/usr/bin/env node
// On macOS every file and folder this program and its children create is
// private to this account from the first byte (spec 0014, design 3).
if (process.platform === "darwin") process.umask(0o077);
const { main } = require("../src/cli");

main(process.argv.slice(2)).catch((error) => {
  console.error(`DSHProxy: ${error.message}`);
  process.exit(1);
});
