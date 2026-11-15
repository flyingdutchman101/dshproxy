// Syntax-checks every source file.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".js")) files.push(full);
  }
};
for (const dir of ["bin", "src", "scripts", "test"]) walk(path.join(root, dir));
for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
console.log(`${files.length} files OK`);
