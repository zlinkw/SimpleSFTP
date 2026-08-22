const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../extension.js"), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function createPlanSandbox(rootPath) {
  return {
    fs,
    path,
    crypto,
    toPosixPath: (value) => String(value).replace(/\\/g, "/"),
    toTarPath: (value) => {
      const normalized = String(value).replace(/\\/g, "/").replace(/^\/+/, "");
      return normalized.startsWith("-") ? `./${normalized}` : normalized;
    },
    patternMatchesPath: (lowerPath, lowerPattern) => {
      if (lowerPattern.includes("*")) {
        const escaped = lowerPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
        return new RegExp(`^${escaped}$`, "i").test(lowerPath);
      }
      return lowerPath === lowerPattern || lowerPath.endsWith(`/${lowerPattern}`);
    },
    isIgnoredLocalPath: (relativePath, ignorePatterns) => {
      const normalized = String(relativePath).replace(/\\/g, "/");
      return ignorePatterns.some((pattern) => (
        normalized === pattern ||
        normalized.startsWith(`${pattern}/`) ||
        normalized.endsWith(`/${pattern}`) ||
        (pattern.startsWith("*.") && normalized.endsWith(pattern.slice(1)))
      ));
    },
  };
}

test("workspace upload plan excludes ignore rules and nested Git repositories", () => {
  const localPath = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-plan-"));
  try {
    fs.writeFileSync(path.join(localPath, "keep.py"), "print('ok')\n");
    fs.mkdirSync(path.join(localPath, ".git"), { recursive: true });
    fs.mkdirSync(path.join(localPath, "comparison_methods/_repos/demo"), { recursive: true });
    fs.writeFileSync(path.join(localPath, "comparison_methods/_repos/demo/file.py"), "x");
    fs.mkdirSync(path.join(localPath, "nested/repo"), { recursive: true });
    fs.mkdirSync(path.join(localPath, "nested/repo/.git"), { recursive: true });
    fs.writeFileSync(path.join(localPath, "nested/repo/file.py"), "x");

    const sandbox = createPlanSandbox(localPath);
    sandbox.rootPath = localPath;
    vm.createContext(sandbox);
    vm.runInContext([
      extractFunction("walkLocalFiles"),
      extractFunction("isIgnoredLocalPath"),
      extractFunction("patternMatchesPath"),
      extractFunction("toPosixPath"),
      extractFunction("createWorkspaceUploadPlan"),
      "this.createPlan = createWorkspaceUploadPlan;",
    ].join("\n"), sandbox);

    const plan = sandbox.createPlan(localPath, { ignore: [".git", "node_modules", "comparison_methods/_repos"] });
    assert.deepEqual(plan.files.map((file) => file.relativePath).join(","), "keep.py");
    assert.equal(plan.fileCount, 1);
    assert.ok(plan.byteCount > 0);
    assert.ok(plan.excludedRuleHits >= 2);
    assert.equal(plan.excludedNestedGitRepos, 1);
    assert.deepEqual([...plan.nestedGitRoots], ["nested/repo"]);
  } finally {
    fs.rmSync(localPath, { recursive: true, force: true });
  }
});

test("upload file list is checksummed in bounded chunks", () => {
  const files = Array.from({ length: 501 }, (_, index) => ({
    relativePath: `file-${index}.py`,
    fullPath: `/tmp/file-${index}.py`,
    size: index + 1,
  }));
  const sandbox = { crypto, toTarPath: (value) => value };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction("hashUploadPlanChunks") + "\nthis.hash = hashUploadPlanChunks;", sandbox);
  const verification = sandbox.hash(files, 250);
  assert.equal(verification.algorithm, "sha256");
  assert.equal(verification.chunkSize, 250);
  assert.equal(verification.chunks.length, 3);
  assert.match(verification.combinedChecksum, /^[a-f0-9]{64}$/);
});

test("tar upload uses a temporary NUL-delimited file list instead of path arguments", () => {
  assert.doesNotMatch(source, /createLocalTarArgs\(sftp,\s*relativePaths/);
  assert.doesNotMatch(source, /"--",\s*\.\.\.relativePaths\.map\(toTarPath\)/);
  assert.match(source, /function createLocalTarArgs\(_sftp, uploadPlan, fileListPath\)/);
  assert.match(source, /return \["-cf", "-", "--null", "-T", fileListPath\];/);
  assert.match(source, /const fileTempDir = fs\.mkdtempSync\(/);
  assert.match(source, /fileListContent = `\$\{plan\.files\.map\(\(file\) => toTarPath\(file\.relativePath\)\)\.join\(/);
  assert.match(source, /fs\.writeFileSync\(fileList, fileListContent, "utf8"\)/);
  assert.match(source, /"--null",\s*"-T",\s*fileList/);
  assert.match(source, /hashUploadPlanChunks\(plan\.files\)/);
  assert.match(source, /return upload\.finally\(\(\) => \{\s*fs\.rmSync\(fileTempDir,\s*\{ recursive: true, force: true \}\);/);
});

test("managed state uses simple_cluster and reports legacy directories for manual cleanup", () => {
  assert.match(source, /path\.join\(localPath, "simple_cluster", TARGET_IGNORE_STATE\)/);
  assert.match(source, /function writeLocalCodeSyncState\(localPath, state\) \{\s*const dir = path\.join\(localPath, "simple_cluster"\);/);
  assert.match(source, /function legacyTargetIgnoreStatePath\(localPath\) \{\s*return path\.join\(localPath, "zlk_cluster", TARGET_IGNORE_STATE\);/);
  assert.match(source, /检测到旧版托管路径 \$\{relativePath\}/);
  assert.match(source, /请人工核对后删除本地\/远端旧版 zlk_cluster 目录/);
  assert.match(source, /检测到旧版托管目录 \$\{legacyManagedDir\}/);
  assert.match(source, /请人工核对后手动删除/);
  const safeTest = source.match(/function isSafeRemoteManagedPath[\s\S]*?\n}/)?.[0] || "";
  assert.match(safeTest, /top === "simple_cluster"/);
});
