const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const filename = path.join(__dirname, "../transfer-settlement.js");
const startedAt = "2026-10-09T14:55:46.715Z";
const currentOwner = { ProcessId: 37832, ParentProcessId: 0, Name: "Code.exe", CreationDate: "2026-10-09T15:57:07.733Z" };
const otherRead = { ProcessId: 41000, ParentProcessId: 37832, Name: "ssh.exe", CreationDate: "2026-10-09T16:00:00.000Z" };

function fixture(rows, options = {}) {
  const calls = [];
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, process: { platform: "win32", pid: currentOwner.ProcessId },
    Buffer, __dirname: path.dirname(filename), require(name) {
      if (name !== "node:child_process") return require(name);
      return { execFile(binary, args, config, callback) {
        calls.push({ binary, args, config });
        callback(options.queryError, JSON.stringify(typeof rows === "function" ? rows(calls.length) : rows));
      } };
    } };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), sandbox, { filename });
  return { ...module.exports, calls };
}

test("legacy inventory exit proof ignores another live Worker read owned by the new service", async () => {
  const f = fixture([currentOwner, otherRead]);
  const proof = await f.localTransferExitProof(`35692:${startedAt}`);
  assert.equal(proof.localOwnerExited, true);
  assert.equal(proof.localTransportCount, 0);
});

test("new-service transport ownership is proven before an exited Windows shell ancestor", async () => {
  // Actual VS Code -> explorer.exe -> exited userinit.exe ancestry.
  const explorer = { ProcessId: 12392, ParentProcessId: 12308, Name: "explorer.exe", CreationDate: "2026-09-24T09:47:48.342Z" };
  const code = { ProcessId: 26580, ParentProcessId: 12392, Name: "Code.exe", CreationDate: "2026-10-09T15:57:06.068Z" };
  const service = { ...currentOwner, ParentProcessId: 26580 };
  const f = fixture([explorer, code, service, otherRead]);
  assert.equal((await f.localTransferExitProof(`35692:${startedAt}`)).localTransportCount, 0);
  await assert.rejects(fixture([explorer, code, service, { ...otherRead, CreationDate: null }])
    .localTransferExitProof(`35692:${startedAt}`), /UNAVAILABLE/);
});

test("a live original owner and its direct or nested transports still prevent replay", async () => {
  const oldOwner = { ProcessId: 35692, ParentProcessId: 0, Name: "Code.exe", CreationDate: "2026-10-09T14:50:00.000Z" };
  const direct = { ...otherRead, ParentProcessId: 35692 };
  const middle = { ProcessId: 39900, ParentProcessId: 35692, Name: "cmd.exe" };
  for (const rows of [[oldOwner], [direct], [middle, { ...otherRead, ParentProcessId: 39900 }]]) {
    await assert.rejects(fixture(rows).localTransferExitProof(`35692:${startedAt}`), /OWNER_STILL_ACTIVE/);
  }
});

test("current-generation drained owner is allowed but its remaining transport is not", async () => {
  const id = `37832:2026-10-09T15:57:12.686Z`;
  assert.equal((await fixture([currentOwner]).localTransferExitProof(id, true)).localTransportCount, 0);
  await assert.rejects(fixture([currentOwner, otherRead]).localTransferExitProof(id, true), /OWNER_STILL_ACTIVE/);
  await assert.rejects(fixture([currentOwner]).localTransferExitProof(id, false), /OWNER_STILL_ACTIVE/);
});

test("PID reuse is distinguished by creation time; children predating the replacement remain blocked", async () => {
  const replacement = { ...currentOwner, ProcessId: 35692 };
  const newChild = { ...otherRead, ParentProcessId: 35692 };
  assert.equal((await fixture([currentOwner, replacement, newChild]).localTransferExitProof(`35692:${startedAt}`)).localOwnerExited, true);
  await assert.rejects(fixture([replacement, { ...newChild, CreationDate: "2026-10-09T15:00:00.000Z" }])
    .localTransferExitProof(`35692:${startedAt}`), /OWNER_STILL_ACTIVE/);
});

test("missing or cyclic process ancestry and malformed censuses never count as exit evidence", async () => {
  for (const rows of [
    [otherRead],
    [currentOwner, { ...otherRead, ParentProcessId: undefined }],
    [currentOwner, currentOwner],
    [{ ...currentOwner, ParentProcessId: otherRead.ProcessId }, otherRead],
    [{ ProcessId: "invalid", Name: "ssh.exe" }],
    [],
    {},
  ]) await assert.rejects(fixture(rows).localTransferExitProof(`35692:${startedAt}`), /UNAVAILABLE/);
  await assert.rejects(fixture([],{ queryError: Error("access denied") }).localTransferExitProof(`35692:${startedAt}`), /UNAVAILABLE/);
});

test("the local census includes process ancestry and creation time with bounded hidden execution", async () => {
  const f = fixture([currentOwner]);
  await f.localTransferExitProof(`35692:${startedAt}`);
  assert.equal(f.calls[0].binary, "pwsh.exe");
  assert.equal(f.calls[0].config.windowsHide, true);
  assert.ok(f.calls[0].config.timeout <= 10000);
  assert.ok(f.calls[0].config.maxBuffer <= 1048576);
  const command = f.calls[0].args.at(-1);
  assert.match(command, /ParentProcessId/); assert.match(command, /CreationDate/);
  assert.doesNotMatch(command, /CommandLine|ExecutablePath|-Filter/);
});
