#!/usr/bin/env node
"use strict";

// simple-sftp-api 独立命令体系已按用户决定（2026-10-23）撤销：不再保留公开注册与帮助，
// package.json 已移除 bin/files 注册。本文件原地保留为撤销说明（git 历史保留旧实现证据）。
// SimpleSFTP 全部功能改由统一入口 simpleex 提供：simpleex sftp <domain> <action>。

const REVOKED_MESSAGE = [
  "simple-sftp-api has been revoked; the unified entry is the only public CLI.",
  "Use instead:",
  "  simpleex sftp status | capabilities --json",
  "  simpleex sftp server list|activate|delete|save|import-ssh|config-path",
  "  simpleex sftp config list|get|set|reset",
  "  simpleex sftp target show|update",
  "  simpleex sftp confirmations reset",
  "  simpleex doctor        (both plugins: discovery + live instance identity)",
  "Full live method list: simpleex sftp capabilities --json",
].join("\n");

function main() {
  console.error(REVOKED_MESSAGE);
  return 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main };
