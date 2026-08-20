#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const APPDATA = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const discoveryPath =
  process.env.SIMPLE_SFTP_API_FILE ||
  path.join(APPDATA, "SimpleSFTP", "api.json");

async function main(argv) {
  const [method, ...rest] = argv;
  if (!method || method.startsWith("-")) {
    console.error("Usage: simple-sftp-api <method> --json <params.json>");
    return 2;
  }
  const paramsFile = option(rest, "--json") || option(rest, "--params");
  let params = {};
  if (paramsFile) {
    if (!fs.existsSync(paramsFile)) throw new Error(`params file not found: ${paramsFile}`);
    params = JSON.parse(fs.readFileSync(paramsFile, "utf8"));
  }
  const discovery = readDiscovery();
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });
  const result = await request(discovery, payload);
  if (result && result.error) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: {
            code: result.error.code,
            message: result.error.message,
            data: result.error.data || {},
          },
        },
        null,
        2
      )
    );
    return 1;
  }
  console.log(JSON.stringify({ ok: true, result: result && result.result }, null, 2));
  return 0;
}

function readDiscovery() {
  if (!fs.existsSync(discoveryPath)) {
    throw new Error(`SimpleSFTP API discovery not found: ${discoveryPath}. Open VS Code once to start the extension host.`);
  }
  const discovery = JSON.parse(fs.readFileSync(discoveryPath, "utf8"));
  if (!discovery.baseUrl || !discovery.token) {
    throw new Error(`SimpleSFTP API discovery is invalid: ${discoveryPath}`);
  }
  return discovery;
}

function request(discovery, payload) {
  const url = new URL("/api/v1/rpc", discovery.baseUrl);
  const body = Buffer.from(payload, "utf8");
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length,
          Authorization: `Bearer ${discovery.token}`,
        },
        timeout: 15_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(new Error(`invalid API response: ${error.message}`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("SimpleSFTP API request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

module.exports = { main, readDiscovery };
