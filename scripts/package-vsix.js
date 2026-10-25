"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const pkg = require("../package.json");
const project = path.join(__dirname, "..");
const file = path.join(project, `simple-sftp-${pkg.version}.vsix`);
const staging = file + ".writing";
const before = fs.existsSync(file) ? fs.lstatSync(file) : undefined;
if (before && (!process.argv.includes("--replace") || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1))
  throw new Error(`Release artifact already exists; rebuilding an owned unpublished package requires --replace: ${file}`);
if (fs.existsSync(staging)) throw new Error(`Inspect the unfinished fixed package slot first: ${staging}`);
// vsce packs the explicit pkg.files whitelist and auto-attaches a root guide README, which would ship the
// full development guide inside the runtime artifact. The release closure is runtime files plus legal notices
// only, so vsce runs in a fresh temp assembly directory: every whitelisted entry except the README slot is
// byte-copied along with package.json, and a minimal readme.md is generated there that carries the extension
// name, the existing short description and a valid link to the complete guide in the repository. The source
// README.md keeps the full guide untouched; the assembly directory is retained after the run for inspection.
const assembly = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-package-"));
for (const entry of pkg.files) {
  if (/^readme\.md$/i.test(entry)) continue;
  fs.copyFileSync(path.join(project, entry), path.join(assembly, entry));
}
fs.copyFileSync(path.join(project, "package.json"), path.join(assembly, "package.json"));
fs.writeFileSync(path.join(assembly, "readme.md"),
  `# ${pkg.displayName}\n\n${pkg.description}\n\n完整安装、配置、使用、API、故障排查与开发指南：https://github.com/zlinkw/SimpleSFTP#readme\n`);
const result = spawnSync(process.execPath, [require.resolve("@vscode/vsce/vsce"), "package", "--no-dependencies", "--out", staging, "--allow-missing-repository"], { cwd: assembly, stdio: "inherit", windowsHide: true, timeout: 60000 });
if (result.status !== 0) throw new Error(result.error?.message || "VSIX packaging failed");
if (before) {
  const current = fs.lstatSync(file);
  if (current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs)
    throw new Error("Release artifact identity changed; fixed staging package retained");
} else if (fs.existsSync(file)) throw new Error("Release artifact appeared during build; fixed staging package retained");
fs.renameSync(staging, file);
