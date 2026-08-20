const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  LocalApiServer,
  confirmationRequired,
  loopbackRequest,
  parseRemoteAddress,
} = require("../api-server.js");

const extensionSource = fs.readFileSync(path.join(__dirname, "../extension.js"), "utf8");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function startServer(methods = {}, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-api-test-"));
  const port = await freePort();
  const server = new LocalApiServer({
    name: "SimpleSFTP Test",
    version: "0.2.0-test",
    preferredPort: port,
    discoveryPath: path.join(root, "api.json"),
    methods,
    ...options,
  });
  const discovery = await server.start();
  return {
    root,
    server,
    baseUrl: discovery.baseUrl,
    token: discovery.token,
    cleanup: async () => {
      await server.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function request(port, requestOptions, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "127.0.0.1",
      port,
      ...requestOptions,
    };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, text, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function rpcPayload(method, params = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
}

async function rpc(port, token, method, params = {}) {
  const response = await request(port, {
    method: "POST",
    path: "/api/v1/rpc",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  }, rpcPayload(method, params));
  return { status: response.status, body: JSON.parse(response.text) };
}

test("local API rejects non-loopback peers", () => {
  assert.equal(parseRemoteAddress("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(loopbackRequest({ socket: { remoteAddress: "127.0.0.1" } }), true);
  assert.equal(loopbackRequest({ socket: { remoteAddress: "::1" } }), true);
  assert.equal(loopbackRequest({ socket: { remoteAddress: "10.0.0.1" } }), false);
  assert.equal(loopbackRequest({ socket: { remoteAddress: "fe80::1" } }), false);
});

test("local API requires bearer auth for every endpoint", async () => {
  const f = await startServer({ "ping": async () => "pong" });
  try {
    const health = await request(f.server.port, { method: "GET", path: "/api/v1/health" });
    assert.equal(health.status, 401);
    const rpcResponse = await request(f.server.port, {
      method: "POST",
      path: "/api/v1/rpc",
      headers: { "Content-Type": "application/json" },
    }, rpcPayload("ping"));
    assert.equal(rpcResponse.status, 401);
  } finally {
    await f.cleanup();
  }
});

test("local API handles malformed JSON-RPC and unknown methods", async () => {
  const f = await startServer({ "ping": async () => "pong" });
  try {
    const malformed = await rpc(f.server.port, f.token, "unknown");
    assert.equal(malformed.body.error.code, -32601);
    const invalid = await request(f.server.port, {
      method: "POST",
      path: "/api/v1/rpc",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${f.token}`,
      },
    }, JSON.stringify({ method: "ping" }));
    assert.equal(invalid.status, 400);
    assert.equal(JSON.parse(invalid.text).error.code, -32600);
  } finally {
    await f.cleanup();
  }
});

test("local API exposes health, capabilities and loadable OpenAPI", async () => {
  const f = await startServer({ "status": async () => ({ ok: true }), "upload.workspace": async () => ({ ok: true }) });
  try {
    const health = await request(f.server.port, {
      method: "GET",
      path: "/api/v1/health",
      headers: { Authorization: `Bearer ${f.token}` },
    });
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.text).version, "0.2.0-test");

    const capabilities = await request(f.server.port, {
      method: "GET",
      path: "/api/v1/capabilities",
      headers: { Authorization: `Bearer ${f.token}` },
    });
    assert.equal(JSON.parse(capabilities.text).confirmation.required, true);

    const openapi = await request(f.server.port, {
      method: "GET",
      path: "/api/v1/openapi.json",
      headers: { Authorization: `Bearer ${f.token}` },
    });
    const spec = JSON.parse(openapi.text);
    assert.equal(spec.openapi, "3.0.0");
    assert.ok(spec.paths["/api/v1/rpc"].post);
  } finally {
    await f.cleanup();
  }
});

test("CONFIRM_REQUIRED is returned as a JSON-RPC API error", async () => {
  const f = await startServer({
    "upload.workspace": async () => {
      throw confirmationRequired({ operation: "upload.workspace", requires: ["confirm", "pathConfirmed"] });
    },
  });
  try {
    const response = await rpc(f.server.port, f.token, "upload.workspace", {});
    assert.equal(response.body.error.code, 2001);
    assert.equal(response.body.error.message, "CONFIRM_REQUIRED");
    assert.deepEqual(response.body.error.data.requires, ["confirm", "pathConfirmed"]);
  } finally {
    await f.cleanup();
  }
});

test("SSE stream is bounded and terminates after the event cap", async () => {
  const f = await startServer({}, { maxEvents: 2, sseTimeoutMs: 500 });
  try {
    f.server.publish({ type: "one", data: 1 });
    f.server.publish({ type: "two", data: 2 });
    f.server.publish({ type: "three", data: 3 });
    const response = await new Promise((resolve, reject) => {
      const req = http.get({
        hostname: "127.0.0.1",
        port: f.server.port,
        path: "/api/v1/events",
        headers: { Authorization: `Bearer ${f.token}` },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
    });
    assert.equal(response.status, 200);
    assert.equal((response.text.match(/^id: /gm) || []).length, 2);
  } finally {
    await f.cleanup();
  }
});

test("CLI reads the SimpleSFTP discovery file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-cli-test-"));
  try {
    const discoveryPath = path.join(root, "api.json");
    fs.writeFileSync(discoveryPath, `${JSON.stringify({
      schemaVersion: 1,
      name: "SimpleSFTP",
      baseUrl: "http://127.0.0.1:19766",
      port: 19766,
      token: "test-token",
      pid: 123,
    })}\n`, "utf8");
    process.env.SIMPLE_SFTP_API_FILE = discoveryPath;
    const { readDiscovery } = require("../bin/simple-sftp-api.js");
    const discovery = readDiscovery();
    assert.equal(discovery.port, 19766);
    assert.equal(discovery.token, "test-token");
    delete process.env.SIMPLE_SFTP_API_FILE;
  } finally {
    delete process.env.SIMPLE_SFTP_API_FILE;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SimpleSFTP source has an explicit API confirmation gate and no scp/rsync", () => {
  assert.match(extensionSource, /function requireApiConfirmation/);
  assert.match(extensionSource, /requires\.push\("pathConfirmed"\)/);
  assert.match(extensionSource, /confirmationRequired\(/);
  assert.doesNotMatch(extensionSource, /\bscp\b|\brsync\b/);
});

test("SimpleSFTP exposes the planned public API methods", () => {
  const methods = [
    "status",
    "servers.list",
    "servers.setActive",
    "servers.importSshConfig",
    "remote.listDirs",
    "target.show",
    "project.create",
    "sync.fromRemote",
    "upload.workspace",
    "upload.files",
    "handoff.markReady",
    "ignores.configure",
    "confirmations.reset",
  ];
  for (const method of methods) {
    const pattern = method === "status"
      ? /status: async/
      : new RegExp(`"${method.replace(/\./g, "\\.")}": async`);
    assert.match(extensionSource, pattern, `missing API method ${method}`);
  }
});
