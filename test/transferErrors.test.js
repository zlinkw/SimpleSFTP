const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../extension.js"), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const headerEnd = source.indexOf(") {", start);
  assert.ok(headerEnd >= 0, `missing function header ${name}`);
  const body = headerEnd + 2;
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const sandbox = { Error };
vm.createContext(sandbox);
vm.runInContext(`${extractFunction("classifyTransportFailure")}\nthis.classify = classifyTransportFailure;`, sandbox);

test("transport failures expose the required diagnostic categories", () => {
  const cases = [
    ["SimpleSFTP 传输超过 600 秒未完成，已停止。", "transfer_timeout"],
    ["ssh: Permission denied (publickey,password).", "ssh_auth_failed"],
    ["connect ECONNREFUSED 127.0.0.1:18766", "local_forward_unavailable"],
    ["getaddrinfo ENOTFOUND gpu.example", "dns_tcp_unreachable"],
    ["mkdir /data/experiments/demo: permission denied", "remote_permission_denied"],
    ["target is outside the configured remote root", "remote_root_validation_failed"],
    ["传输已取消", "user_cancelled"],
  ];
  for (const [message, expected] of cases) {
    const error = sandbox.classify(new Error(message), { sshStderr: message });
    assert.equal(error.category, expected, message);
    assert.ok(error.diagnosis);
    assert.equal(typeof error.retryable, "boolean");
  }
});

test("process failures retain bounded stderr evidence", () => {
  const error = sandbox.classify(new Error("tar failed"), {
    sshCode: 255,
    tarCode: 2,
    sshStderr: "connection refused",
    tarStderr: "tar: x",
  });
  assert.equal(error.details.sshExitCode, 255);
  assert.equal(error.details.tarExitCode, 2);
  assert.match(error.details.tarStderr, /tar: x/);
});
