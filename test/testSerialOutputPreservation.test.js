"use strict";
// 回归：scripts/test-serial.js 必须把子进程 stdout+stderr 原文持续落到唯一树外日志（不截断、不囤内存），
// 失败/超时/被杀都返回真实 exitCode/signal/limit 与完整日志引用；控制台只做有界预览；时限只能缩短且不超过 20000ms。
// 夹具是同目录 testSerial*.fixture.js（runner 只扫 *.test.js，不会自扫）；本测试不清理临时树与日志，保留可查。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const projectRoot = path.join(__dirname, "..");
const runner = path.join(projectRoot, "scripts", "test-serial.js");
const serial = require(runner);
const kept = [];
// logParent 用于“同一配置父目录连续两次执行”的回归；默认每次调用用自己的空目录。
function run(fixtureNames, env, logParent) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b-test-serial-"));
  const logs = logParent || path.join(root, "logs");
  const before = fs.existsSync(logs) ? new Set(fs.readdirSync(logs)) : new Set();
  fs.mkdirSync(path.join(root, "test"));
  for (const name of fixtureNames) {
    fs.copyFileSync(path.join(__dirname, name), path.join(root, "test", name.replace(/\.fixture\.js$/, ".test.js")));
  }
  const result = spawnSync(process.execPath, [runner, root], {
    cwd: projectRoot, windowsHide: true, timeout: 19000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8",
    env: Object.assign({}, process.env, { SIMPLESFTP_TEST_SERIAL_LOG_DIR: logs }, env || {}),
  });
  assert.ok(!result.error, "runner spawn failed: " + String(result.error && result.error.message));
  assert.equal(result.signal, null, "runner must exit on its own, got signal " + result.signal);
  kept.push(root);
  // 配置值只是父目录：每次执行必须在其中新开一个 run 目录，日志落在 run 目录里。
  const fresh = fs.readdirSync(logs).filter(name => !before.has(name));
  assert.equal(fresh.length, 1, "每次执行只应新开一个 run 目录：" + JSON.stringify({ before: [...before], after: fs.readdirSync(logs) }));
  const runDir = path.join(logs, fresh[0]);
  assert.ok(fs.statSync(runDir).isDirectory(), "run 目录必须是目录：" + runDir);
  const entries = fs.readdirSync(runDir).filter(name => name.endsWith(".log"));
  assert.equal(entries.length, fixtureNames.length, "每个测试文件必须有一份唯一日志：" + JSON.stringify(entries));
  const logFile = path.join(runDir, entries[0]);
  return { root, logs, runDir, logFile, log: fs.readFileSync(logFile, "utf8"),
    stdout: String(result.stdout || ""), stderr: String(result.stderr || ""), code: result.status };
}
test("runner keeps the whole >64KB child log out of tree and returns the log reference", () => {
  const { log, logFile, stderr, code } = run(["testSerialHeadOutput.fixture.js"]);
  assert.equal(code, 1, "failing fixture must produce a non-zero exit code");
  assert.ok(logFile.includes("b-test-serial-"), "log must live outside the project tree: " + logFile);
  assert.ok(stderr.includes("log: " + logFile), "failure must name the full log file");
  assert.ok(log.includes("SERIAL-FIXTURE-FIRST-LINE-a7f3c1"), "log must contain the first lines (no 64KB head loss)");
  assert.ok(Buffer.byteLength(log) > 65536, "fixture must exceed the old 64KB window, got " + Buffer.byteLength(log));
  assert.match(stderr, /serial fixture huge output keeps the failing assertion visible/, "console preview must still name the failing test");
  assert.match(stderr, /SERIAL-FIXTURE-ASSERTION-MESSAGE-5d8c22/, "console preview must keep the assertion message");
  assert.ok(stderr.length < 40000, "console preview must stay bounded, got " + stderr.length + " chars");
  assert.ok(/size: \d+ bytes/.test(stderr) && Number(stderr.match(/size: (\d+) bytes/)[1]) > 65536, "failure must report the real log size");
});
test("runner keeps every failing case name and full stack in the log", () => {
  const { log, stderr, code } = run(["testSerialMultiFail.fixture.js"]);
  assert.equal(code, 1);
  for (const name of ["serial fixture failing alpha", "serial fixture failing beta", "serial fixture failing gamma"]) {
    assert.ok(log.includes(name), "log must keep failing test name: " + name);
  }
  assert.ok(log.includes("gamma-fixture-stack-marker"), "log must keep the thrown error message");
  assert.ok(/at TestContext\.\w+/.test(log) || /testSerialMultiFail\.test\.js:\d+:\d+/.test(log), "log must keep stack frames");
  assert.match(stderr, /failed \(exit code 1\)/, "real exit code must be reported");
});
test("runner keeps multi-byte output line-oriented in the log", () => {
  // node --test 自己的捕获层在重负载下会偶发丢尾（不经本 runner 也复现），所以这里断言“首行 + 大量整行”，
  // 精确的字节/多字节边界保真由下面的纯函数用例覆盖，不去赌 node 捕获层的稳定性。
  const { log, code } = run(["testSerialMultiByte.fixture.js"]);
  assert.equal(code, 1);
  assert.ok(log.includes("串行夹具首行-MARK-头-3f9a12"), "log must keep the first multi-byte line");
  const lines = log.split(String.fromCharCode(10)).filter(row => row.includes("·校验通过・"));
  assert.ok(lines.length >= 3000, "log must keep thousands of multi-byte lines, got " + lines.length);
});
test("runner reports timeout with the real limit and keeps printed output in the log", () => {
  const { log, stdout, stderr, code } = run(["testSerialTimeout.fixture.js"], { SIMPLESFTP_TEST_SERIAL_TIMEOUT_MS: "1200" });
  assert.ok(stdout.split(String.fromCharCode(10))[0].includes("limit=1200ms"), "shortened limit must be announced: " + stdout.split(String.fromCharCode(10))[0]);
  assert.notEqual(code, 0, "a hanging fixture must not be reported as passing");
  assert.match(stderr, /testSerialTimeout\.test\.js/);
  assert.match(stderr, /(1\.2 second limit|killed by SIGKILL|exit code)/, "timeout/kill reason must be explicit: " + stderr.slice(0, 200));
  for (const row of ["exitCode: ", "signal: ", "limitMs: 1200"]) {
    assert.ok(stderr.includes(row), "超时失败也必须独立列出 " + row + "：" + stderr.split(String.fromCharCode(10)).slice(0, 5).join(" | "));
  }
  assert.match(stderr, /exitCode: (null|\d+)/, "exitCode 必须是真实值或 null");
  assert.match(stderr, /signal: (null|SIGKILL|SIGTERM)/, "signal 必须是真实值或 null");
  assert.ok(log.includes("SERIAL-FIXTURE-TIMEOUT-MARKER-4c07aa"), "output printed before the kill must reach the log");
});
test("failure metadata lists exitCode, signal and limitMs independently", () => {
  const { stderr, logFile } = run(["testSerialMultiFail.fixture.js"]);
  const lines = stderr.split(String.fromCharCode(10));
  assert.ok(lines.some(row => row === "exitCode: 1"), "exitCode 必须独立成行：" + lines.slice(0, 6).join(" | "));
  assert.ok(lines.some(row => row === "signal: null"), "未收到信号时 signal 要显式写 null：" + lines.slice(0, 6).join(" | "));
  assert.ok(lines.some(row => row === "limitMs: 20000"), "生效时限要显式写出：" + lines.slice(0, 6).join(" | "));
  assert.ok(stderr.includes("log: " + logFile), "必须给出完整日志路径");
  assert.ok(/size: \d+ bytes/.test(stderr), "必须给出日志真实字节数");
});
test("spawn failure keeps the system code and log path without inventing an exit code", () => {
  const message = serial.failureReport("x.test.js", "spawn failed: Permission denied", {
    code: null, signal: null, limitMs: 20000, logFile: "/tmp/x.test.js.log", systemCode: "EACCES", size: 0, previewText: "",
  });
  const rows = message.split(String.fromCharCode(10));
  for (const row of ["x.test.js: spawn failed: Permission denied", "exitCode: null", "signal: null", "limitMs: 20000",
    "log: /tmp/x.test.js.log", "spawnSystemCode: EACCES", "size: 0 bytes"]) {
    assert.ok(rows.includes(row), "缺少失败元数据行 " + row + "：" + message);
  }
});
test("configured log dir is only a parent: the second run keeps the old log bytes and gets its own run dir", () => {
  const parent = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "b-test-serial-parent-")), "logs");
  const first = run(["testSerialMultiFail.fixture.js"], {}, parent);
  const original = fs.readFileSync(first.logFile);
  const second = run(["testSerialMultiFail.fixture.js"], {}, parent);
  kept.push(path.dirname(parent));
  assert.equal(second.logs, first.logs, "配置父目录本身不变");
  assert.notEqual(second.runDir, first.runDir, "第二次执行必须落在新的 run 目录：" + first.runDir + " vs " + second.runDir);
  assert.notEqual(second.logFile, first.logFile, "两次执行的日志路径必须不同");
  assert.deepEqual(fs.readFileSync(first.logFile), original, "旧失败日志字节必须原样保留，不得被第二次执行覆盖");
  assert.ok(original.length > 200, "旧日志本身必须非空");
  assert.ok(second.log.includes("serial fixture failing gamma"), "新日志也必须完整写入");
});
test("logDirectory always opens a fresh run directory under the configured parent", () => {
  const saved = process.env.SIMPLESFTP_TEST_SERIAL_LOG_DIR;
  const parent = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "b-test-serial-dir-")), "configured");
  kept.push(path.dirname(parent));
  try {
    process.env.SIMPLESFTP_TEST_SERIAL_LOG_DIR = parent;
    const first = serial.logDirectory();
    const second = serial.logDirectory();
    assert.notEqual(first, parent, "配置目录本身不能当 run 目录用");
    assert.notEqual(first, second, "连续两次必须各得一个独立 run 目录");
    assert.ok(first.startsWith(parent + path.sep) && second.startsWith(parent + path.sep), "run 目录必须落在配置父目录内");
    assert.ok(fs.statSync(first).isDirectory() && fs.statSync(second).isDirectory(), "run 目录必须已创建");
    const nested = path.join(parent, "nested", "deeper");
    process.env.SIMPLESFTP_TEST_SERIAL_LOG_DIR = nested;
    assert.ok(serial.logDirectory().startsWith(nested + path.sep), "不存在的父目录要先递归创建");
    delete process.env.SIMPLESFTP_TEST_SERIAL_LOG_DIR;
    assert.ok(serial.logDirectory().startsWith(os.tmpdir()), "未配置时仍落在系统临时目录");
  } finally {
    if (saved === undefined) delete process.env.SIMPLESFTP_TEST_SERIAL_LOG_DIR;
    else process.env.SIMPLESFTP_TEST_SERIAL_LOG_DIR = saved;
  }
});
test("runner still counts passing files the same way and ignores the fixture suffix", () => {
  // 同时锁住另一类伪报通过：本测试跑在 node --test 下，NODE_TEST_CONTEXT 会被子进程继承；
  // runner 若不过滤，node 会打印 “skipping running files.” 并以 0 用例、退出码 0 伪报通过。
  const { stdout, stderr, code } = run(["testSerialPassing.fixture.js"]);
  assert.equal(code, 0, "passing fixture must exit 0, stderr: " + stderr.slice(0, 300));
  assert.match(stdout, /1 files, 2 passed/, "summary line must be unchanged: " + stdout.trim());
  assert.ok(stdout.includes("logs="), "runner must announce where the full logs live: " + stdout.split(String.fromCharCode(10))[0]);
});
test("timeout limit may only be shortened, never raised above 20000ms", () => {
  const saved = process.env.SIMPLESFTP_TEST_SERIAL_TIMEOUT_MS;
  try {
    for (const [value, expected] of [[undefined, 20000], ["", 20000], ["   ", 20000], ["not-a-number", 20000],
      ["99999999", 20000], ["1e9", 20000], ["20000", 20000], ["19999.7", 19999], ["300", 300], ["100", 250], ["-5", 250], ["0", 250]]) {
      if (value === undefined) delete process.env.SIMPLESFTP_TEST_SERIAL_TIMEOUT_MS;
      else process.env.SIMPLESFTP_TEST_SERIAL_TIMEOUT_MS = String(value);
      assert.equal(serial.timeoutLimit(), expected, "env " + JSON.stringify(value) + " must clamp to " + expected + "ms");
    }
    assert.equal(serial.DEFAULT_TIMEOUT_MS, 20000, "default limit must stay 20000ms");
    assert.ok(serial.MIN_TIMEOUT_MS >= 250 && serial.MIN_TIMEOUT_MS <= 1000, "lower bound must stay sane: " + serial.MIN_TIMEOUT_MS);
  } finally {
    if (saved === undefined) delete process.env.SIMPLESFTP_TEST_SERIAL_TIMEOUT_MS;
    else process.env.SIMPLESFTP_TEST_SERIAL_TIMEOUT_MS = saved;
  }
});
test("preview decoding never splits a multi-byte code point", () => {
  const text = "隔离与只读并发互不阻断·校验通过・漢字混じりの充填・";
  const payload = Buffer.from(text.repeat(4000) + String.fromCharCode(10), "utf8");
  assert.ok(payload.length > 65536, "fixture payload must exceed the old 64KB window");
  for (const cut of [1, 2, payload.length % 3, 65533, payload.length - 1]) {
    const decoded = serial.decodeFromBoundary(payload.subarray(cut));
    assert.equal(decoded.includes(String.fromCharCode(0xfffd)), false, "cut " + cut + " must not fabricate a replacement character");
  }
  const shown = serial.preview(payload.subarray(0, 4096), payload.subarray(payload.length - 16384));
  assert.equal(shown.includes(String.fromCharCode(0xfffd)), false, "preview must stay free of replacement characters");
  assert.ok(shown.includes(text.slice(0, 6)), "preview must keep readable head text");
  assert.ok(shown.includes("[…完整原文见日志文件…]"), "preview must mark the elided middle");
});
test("pass count is read from the last summary line in the log tail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b-test-serial-tail-"));
  kept.push(dir);
  const file = path.join(dir, "sample.log");
  fs.writeFileSync(file, "pass 7 (stale line inside a test name)\n" + "x".repeat(70000) + String.fromCharCode(10) + "ℹ pass 3" + String.fromCharCode(10));
  assert.equal(serial.tailNumber(file, /pass (\d+)/g), 3, "must take the trailing summary, not the first occurrence");
  fs.writeFileSync(file, "no summary at all" + String.fromCharCode(10));
  assert.equal(serial.tailNumber(file, /pass (\d+)/g), 0, "missing summary must count as zero");
  assert.equal(serial.tailNumber(path.join(dir, "missing.log"), /pass (\d+)/g), 0, "missing log must not throw");
});
test.after(() => { console.log("test-serial regression trees kept for review: " + kept.join(" ")); });
