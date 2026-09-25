const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const { resolveWorkspaceLocation } = require("./workspace-path.js");
const { toTarPath: tarEntryPath, writeTarEntriesToStream } = require("./tar-writer.js");
const { LocalApiServer, confirmationRequired } = require("./api-server.js");
const {
  HostOperationLeaseConflictError,
  HostOperationLeaseManager,
} = require("./host-operation-lease.js");
const PACKAGE_JSON = require("./package.json");
const APPDATA = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const SHARED_SERVER_DIR = path.join(APPDATA, "SimpleSFTP", "server-profiles");
const SHARED_SERVER_FILE = path.join(SHARED_SERVER_DIR, "servers.json");
const LEGACY_SHARED_SERVER_FILE = path.join(APPDATA, "ZLK", "server-profiles", "servers.json");
const API_CONFIG_NAMESPACE = "simpleSftp";
const API_CONFIG_PREFIX = `${API_CONFIG_NAMESPACE}.`;
const SIMPLE_SFTP_CONFIG_KEYS = new Set(Object.keys(PACKAGE_JSON.contributes?.configuration?.properties || {}));

const DEFAULT_HANDOFF_MARKER = ".simple-sftp-handoff.json";
const AGENTS_BLOCK_START = "<!-- SIMPLE_SFTP_START -->";
const AGENTS_BLOCK_END = "<!-- SIMPLE_SFTP_END -->";

const DEFAULT_IGNORES = [
  ".git",
  ".vscode",
  ".idea",
  DEFAULT_HANDOFF_MARKER,
  ".ipynb_checkpoints",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".cache",
  ".tox",
  ".venv",
  "venv",
  "env",
  "build",
  "dist",
  "node_modules",
  "comparison_methods/_repos",
  "data",
  "dataset",
  "datasets",
  "Datasets",
  "VOCdevkit",
  "checkpoints",
  "checkpoint",
  "weights",
  "weight",
  "pretrained",
  "pretrained_ckpt",
  "runs",
  "work_dirs",
  "wandb",
  "tensorboard",
  "logs",
  "log",
  "output",
  "outputs",
  "results",
  "result",
  "backup",
  "tmp",
  "temp",
  "*.log",
  "*.out",
  "*.err",
  "*.csv",
  "*.tsv",
  "*.xlsx",
  "*.xls",
  "*.zip",
  "*.tar",
  "*.tar.gz",
  "*.tgz",
  "*.rar",
  "*.7z",
  "*.h5",
  "*.hdf5",
  "*.pkl",
  "*.pickle",
  "*.joblib",
  "*.pth",
  "*.pt",
  "*.ckpt",
  "*.onnx",
  "*.engine",
  "*.nii",
  "*.nii.gz",
  "*.mha",
  "*.mhd",
  "*.dcm",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.bmp",
  "*.tif",
  "*.tiff",
  "*.npy",
  "*.npz",
];

// These editor and Git internals never belong in a project transfer.
const FIXED_IGNORES = [".git", ".vscode"];

const HIDDEN_TOP_LEVEL = new Set([
  ".codex",
  ".vscode-server",
  "run",
  "tmp",
  "tensorboard",
]);

const promptedWorkspaces = new Set();
const uploadQueues = new Map();
const activeTransfers = new Map();
const activeUploadOperations = new Map();
const SAVE_UPLOAD_STATE = "simple-sftp-upload-state.json";
const TARGET_DOWNLOAD_SCOPE_STATE = "sftp-download-scopes.json";
const DEFAULT_DOWNLOAD_EXTENSIONS = ["*"];
const DEFAULT_DOWNLOAD_MAX_FILE_SIZE_MB = 1024;
const PATH_CONFIRMATIONS_STATE = "simple-sftp-confirmed-transfer-paths.v1";
let transferSequence = 0;
let defaultConnectTimeoutSeconds = 15;
let extensionContext;
let localApiServer;
let serverStatusButton;
let sharedWatcher;
const hostOperationLease = new HostOperationLeaseManager();

function activate(context) {
  extensionContext = context;
  refreshConnectTimeoutFromConfig();
  const command = vscode.commands.registerCommand(
    "simpleSftp.createOrOpen",
    (options) => createOrOpenProject(options)
  );
  const syncCommand = vscode.commands.registerCommand(
    "simpleSftp.syncFromRemote",
    () => syncFromRemote()
  );
  const uploadWorkspaceCommand = vscode.commands.registerCommand(
    "simpleSftp.uploadWorkspace",
    (options) => uploadWorkspace(options)
  );
  const uploadFilesCommand = vscode.commands.registerCommand(
    "simpleSftp.uploadFiles",
    (options) => uploadFiles(options)
  );
  const selectServerCommand = vscode.commands.registerCommand(
    "simpleSftp.selectServer",
    () => selectServer()
  );
  const importSshConfigCommand = vscode.commands.registerCommand(
    "simpleSftp.importSshConfig",
    () => importSharedSshConfig()
  );
  const openSharedServerConfigCommand = vscode.commands.registerCommand(
    "simpleSftp.openSharedServerConfig",
    () => openSharedServerConfig()
  );
  const showCurrentTargetCommand = vscode.commands.registerCommand(
    "simpleSftp.showCurrentTarget",
    () => showCurrentTarget()
  );
  const handoffCommand = vscode.commands.registerCommand(
    "simpleSftp.markHandoffReady",
    () => markHandoffReady()
  );
  const configureDownloadScopeCommand = vscode.commands.registerCommand(
    "simpleSftp.configureDownloadScope",
    (options) => configureDownloadScope(options)
  );
  context.subscriptions.push(command, syncCommand, uploadWorkspaceCommand, uploadFilesCommand, handoffCommand, configureDownloadScopeCommand, selectServerCommand, importSshConfigCommand, openSharedServerConfigCommand, showCurrentTargetCommand);
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      void handleSavedDocument(document);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("simpleSftp.connectTimeoutSeconds")) {
        refreshConnectTimeoutFromConfig();
      }
      if (event.affectsConfiguration("simpleSftp.uploadOnSave")) {
        applyUploadOnSaveSettingToOpenWorkspaces();
      }
    })
  );

  const actionsProvider = new ActionTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("simpleSftp.actions", actionsProvider)
  );

  context.subscriptions.push(
    createServerStatusButton(),
    createStatusButton(
      "$(cloud-download) SimpleSFTP 项目",
      "选择远端项目并创建本地 SFTP 同步工作区。",
      "simpleSftp.createOrOpen",
      102
    ),
    createStatusButton(
      "$(sync) 远端到本地",
      "从远端同步代码到当前本地工作区，适合开始编辑前使用。",
      "simpleSftp.syncFromRemote",
      101
    ),
    createStatusButton(
      "$(cloud-upload) 交接",
      "上传本地代码并写入交接标记，适合切换设备前使用。",
      "simpleSftp.markHandoffReady",
      100
    ),
    createStatusButton(
      "$(cloud-download) 下载范围",
      "选择允许从远端下载到本机的文件和文件夹。",
      "simpleSftp.configureDownloadScope",
      99
    )
  );
  initializeSharedServerProfiles();
  startSharedServerWatcher();
  updateServerStatusButton();

  applyUploadOnSaveSettingToOpenWorkspaces();
  void maybePromptForHandoff().catch((error) => {
    vscode.window.showWarningMessage(`SimpleSFTP 工作区路径检查失败：${formatError(error)}`);
  });
  startLocalApiServer(context);
}

function startLocalApiServer(context) {
  const server = new LocalApiServer({
    name: "SimpleSFTP",
    version: String(PACKAGE_JSON.version || "0.2.0"),
    preferredPort: 19766,
    discoveryPath: path.join(APPDATA, "SimpleSFTP", "api.json"),
    methods: createLocalApiMethods(),
  });
  localApiServer = server;
  context.subscriptions.push({
    dispose: () => {
      void server.dispose().catch(() => undefined);
    },
  });
  void server.start().catch((error) => {
    console.warn(`SimpleSFTP local API failed to start: ${formatError(error)}`);
  });
  return server;
}

function createStatusButton(text, tooltip, command, priority) {
  const button = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    priority
  );
  button.text = text;
  button.tooltip = tooltip;
  button.command = command;
  button.show();
  return button;
}

function createServerStatusButton() {
  serverStatusButton = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    103
  );
  serverStatusButton.command = "simpleSftp.selectServer";
  serverStatusButton.tooltip = "选择共享服务器配置。";
  serverStatusButton.show();
  return serverStatusButton;
}

function emptySharedServers() {
  return { version: 1, updatedAt: new Date().toISOString(), updatedBy: "simple-sftp", activeServerId: "", servers: [] };
}

function readSharedServers() {
  try {
    if (!fs.existsSync(SHARED_SERVER_FILE)) return emptySharedServers();
    const parsed = JSON.parse(fs.readFileSync(SHARED_SERVER_FILE, "utf8"));
    return {
      version: 1,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      updatedBy: parsed.updatedBy || "simple-sftp",
      activeServerId: parsed.activeServerId || "",
      servers: Array.isArray(parsed.servers) ? parsed.servers.filter((item) => item && item.enabled !== false) : [],
    };
  } catch {
    return emptySharedServers();
  }
}

function writeSharedServers(data) {
  fs.mkdirSync(SHARED_SERVER_DIR, { recursive: true });
  const next = { ...data, version: 1, updatedAt: new Date().toISOString(), updatedBy: "simple-sftp" };
  const temp = `${SHARED_SERVER_FILE}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(temp, SHARED_SERVER_FILE);
}

function getActiveSharedServer() {
  const data = readSharedServers();
  return data.servers.find((item) => item.id === data.activeServerId) || data.servers[0];
}

function updateServerStatusButton() {
  if (!serverStatusButton) return;
  const active = getActiveSharedServer();
  serverStatusButton.text = active ? `$(plug) SimpleSFTP：${active.label || active.id}` : "$(plug) SimpleSFTP：未选服务器";
  serverStatusButton.tooltip = active
    ? `${active.user || ""}@${active.host}${active.remotePath ? ":" + active.remotePath : ""}`
    : "尚未配置共享服务器。";
}

function initializeSharedServerProfiles() {
  fs.mkdirSync(SHARED_SERVER_DIR, { recursive: true });
  if (fs.existsSync(SHARED_SERVER_FILE)) return;
  if (fs.existsSync(LEGACY_SHARED_SERVER_FILE)) {
    fs.copyFileSync(LEGACY_SHARED_SERVER_FILE, SHARED_SERVER_FILE);
    return;
  }
  writeSharedServers(emptySharedServers());
}

function startSharedServerWatcher() {
  try {
    if (sharedWatcher) sharedWatcher.close();
    sharedWatcher = fs.watch(SHARED_SERVER_DIR, (_event, filename) => {
      if (filename !== "servers.json") return;
      updateServerStatusButton();
    });
  } catch {}
}

async function selectServer() {
  const data = readSharedServers();
  const items = data.servers.map((item) => ({
    label: item.label || item.id,
    description: `${item.user || ""}@${item.host}${item.remotePath ? ":" + item.remotePath : ""}`,
    id: item.id,
  })).concat([
    { label: "+ 从 VS Code SSH 配置导入", id: "__import" },
    { label: "+ 打开共享服务器配置", id: "__open" },
    { label: "+ 刷新服务器列表", id: "__refresh" },
  ]);
  const picked = await vscode.window.showQuickPick(items, { title: "SimpleSFTP 服务器" });
  if (!picked) return;
  if (picked.id === "__import") return importSharedSshConfig();
  if (picked.id === "__open") return openSharedServerConfig();
  if (picked.id === "__refresh") return updateServerStatusButton();
  writeSharedServers({ ...data, activeServerId: picked.id });
  updateServerStatusButton();
}

async function openSharedServerConfig() {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(SHARED_SERVER_FILE));
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function importSharedSshConfig() {
  const result = importSharedSshConfigCore();
  updateServerStatusButton();
  vscode.window.showInformationMessage(`已导入 ${result.imported} 个 SSH 配置。`);
  return result;
}

function importSharedSshConfigCore() {
  const imported = readProfilesFromSshConfig();
  const data = readSharedServers();
  const byId = new Map(data.servers.map((item) => [item.id, item]));
  for (const item of imported) byId.set(item.id, { ...byId.get(item.id), ...item, enabled: true });
  const next = { ...data, servers: [...byId.values()] };
  if (!next.activeServerId && next.servers[0]) next.activeServerId = next.servers[0].id;
  writeSharedServers(next);
  return { ok: true, imported: imported.length, activeServerId: next.activeServerId };
}

function readProfilesFromSshConfig() {
  const sshConfigPath = path.join(os.homedir(), ".ssh", "config");
  if (!fs.existsSync(sshConfigPath)) return [];
  const text = fs.readFileSync(sshConfigPath, "utf8");
  const lines = text.split(/\r?\n/);
  const profiles = [];
  let current;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === "host") {
      if (current && current.host && current.id !== "*") profiles.push(current);
      current = { id: value, label: value, sshConfigHost: value, source: "vscode-ssh-config", authType: "ssh-config", enabled: true, port: 22 };
      continue;
    }
    if (!current) continue;
    if (key === "hostname") current.host = value;
    if (key === "user") current.user = value;
    if (key === "port") current.port = Number(value) || 22;
  }
  if (current && current.host && current.id !== "*") profiles.push(current);
  return profiles;
}

class ActionTreeProvider {
  getTreeItem(item) {
    return item;
  }

  getChildren() {
    return [
      new ActionTreeItem({
        label: "创建或打开项目",
        description: "选择远端项目目录并创建本地工作区",
        icon: "cloud-download",
        command: "simpleSftp.createOrOpen",
      }),
      new ActionTreeItem({
        label: "远端同步到本地",
        description: "开始编辑前同步远端代码",
        icon: "sync",
        command: "simpleSftp.syncFromRemote",
      }),
      new ActionTreeItem({
        label: "上传并标记交接",
        description: "切换设备前上传并写入交接标记",
        icon: "cloud-upload",
        command: "simpleSftp.markHandoffReady",
      }),
      new ActionTreeItem({
        label: "设置下载文件范围",
        description: "选择允许下载的远端文件和文件夹",
        icon: "cloud-download",
        command: "simpleSftp.configureDownloadScope",
      }),
      new ActionTreeItem({
        label: "查看当前目标",
        description: "查看当前 SFTP 工作区映射",
        icon: "info",
        command: "simpleSftp.showCurrentTarget",
      }),
    ];
  }
}

class ActionTreeItem extends vscode.TreeItem {
  constructor({ label, description, icon, command }) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.tooltip = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = {
      command,
      title: label,
    };
  }
}

async function createOrOpenProject(options = {}) {
  try {
    const cfg = vscode.workspace.getConfiguration("simpleSftp");
    const target = resolveCreateProjectTarget(getActiveSharedServer(), cfg, options);
    const writeAgentsFile = cfg.get("writeAgentsFile");

    const remotePath = options.apiMode
      ? String(options.remotePath || "").trim().replace(/\/+$/, "")
      : await pickRemoteDirectory({ remoteBase: target.remoteBase, sftp: target.sftp });
    if (!remotePath) {
      const message = "缺少远端项目目录 remotePath。";
      if (options.apiMode) throw new Error(message);
      return;
    }

    const projectName = path.posix.basename(remotePath);
    const localPath = String(options.localPath || path.join(target.localBase, projectName)).trim();
    const selectedTarget = { ...target.sftp, remotePath };
    await withHostOperationLease("create-workspace", "创建 SFTP 工作区", localPath, async () => {
      await confirmTransferPath({
        localPath,
        sftp: selectedTarget,
        operation: "创建 SFTP 工作区",
        detail: "从远端目录同步到本地工作区",
        options,
      });
      await writeWorkspace({
        execHost: target.execHost,
        localPath,
        projectName,
        remotePath,
        sftp: target.sftp,
        serverLabel: target.label,
        userName: target.sftp.username,
        writeAgentsFile,
      });
    });

    if (options.apiMode) {
      return {
        ok: true,
        localPath,
        remotePath,
        host: selectedTarget.host,
        username: selectedTarget.username || "",
        port: normalizeSshPort(selectedTarget.port, 22),
      };
    }

    const action = await vscode.window.showInformationMessage(
      `已创建 SFTP 工作区：${localPath}`,
      "打开项目",
      "显示文件夹"
    );
    if (action === "显示文件夹") {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(localPath));
      return;
    }
    if (action === "打开项目" || action == null) {
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(localPath), false);
    }
  } catch (error) {
    if (options.apiMode) throw error;
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

function resolveCreateProjectTarget(server, cfg, options = {}) {
  const item = server && typeof server === "object" ? server : {};
  const fallback = options && typeof options === "object"
    ? { ...(options.server && typeof options.server === "object" ? options.server : {}), ...options }
    : {};
  const host = firstNonEmpty(item.sftpHost, item.sshHost, fallback.sftpHost, fallback.sshHost, item.host, fallback.host, item.sshConfigHost, item.sshConfigAlias, fallback.sshConfigHost, fallback.sshConfigAlias, cfg.get("sshHost"));
  const username = String(item.user || item.username || fallback.user || fallback.username || cfg.get("userName") || "").trim();
  const fallbackPort = normalizeSshPort(fallback.port || fallback.sshPort, normalizeSshPort(cfg.get("sshPort"), 22));
  const port = normalizeSshPort(item.sshPort || item.port, fallbackPort);
  const remoteBase = String(item.remotePath || fallback.remoteBase || fallback.remotePath || cfg.get("remoteBase") || "").replace(/\/+$/, "");
  const localBase = String(item.localBase || fallback.localBase || cfg.get("localBase") || "").trim();
  const execHost = String(item.host || item.sshConfigHost || fallback.execHost || fallback.host || fallback.sshConfigHost || cfg.get("execHost") || host).trim();
  const label = String(item.id || item.label || fallback.id || fallback.label || host || "simple-sftp-target").trim();
  assertCreateProjectTarget({ host, remoteBase, localBase });
  return {
    label,
    remoteBase,
    localBase,
    execHost,
    sftp: {
      name: label,
      host,
      port,
      username,
      remotePath: remoteBase,
    },
  };
}

function assertCreateProjectTarget({ host, remoteBase, localBase }) {
  const missing = [];
  if (!host) missing.push("SSH 主机");
  if (!remoteBase) missing.push("远端根目录");
  if (!localBase) missing.push("本地根目录");
  if (missing.length) throw new Error(`SFTP 项目目标配置缺失：${missing.join("、")}。`);
}

async function showCurrentTarget(options = {}) {
  const hasExplicitTarget = Boolean(
    options &&
    (options.server ||
      options.remotePath ||
      options.host ||
      options.sshHost ||
      options.sshConfigHost ||
      options.sshConfigAlias)
  );
  const workspaceFolder = getPrimaryWorkspaceFolder();
  if (!workspaceFolder && !options.localPath) {
    if (options.apiMode && hasExplicitTarget) {
      const localPath = String(options.localPath || "").trim();
      const sftp = localPath ? resolveUploadSftp(localPath, options) : apiTransferSftp({ ...options, localPath });
      if (sftp && sftp.host && sftp.remotePath) {
        const summary = formatSftpTargetSummary(localPath, sftp);
        return {
          ok: true,
          localPath,
          host: sftp.host,
          username: sftp.username || "",
          port: normalizeSshPort(sftp.port, 22),
          remotePath: sftp.remotePath,
          ignoreCount: 0,
          summary,
        };
      }
    }
    if (!options.apiMode) vscode.window.showInformationMessage("当前未打开工作区。");
    return { ok: false, error: "当前未打开工作区。请传入 localPath。" };
  }
  const localPath = String(options.localPath || getWorkspaceRoot()).trim();
  const sftp = hasExplicitTarget ? resolveUploadSftp(localPath, options) : readSftpConfig(localPath);
  if (!sftp || !sftp.remotePath || !sftp.host) {
    const message = hasExplicitTarget
      ? "未提供可用的 SFTP 目标。"
      : "当前工作区没有可用的 .vscode/sftp.json 目标。";
    if (!options.apiMode) vscode.window.showInformationMessage(message);
    return { ok: false, error: message };
  }
  const location = workspaceLocationForFolder(workspaceFolder);
  const summary = `${formatSftpTargetSummary(localPath, sftp)}${location && location.remote ? ` | 工作区 ${location.editorUri}` : ""}`;
  if (!options.apiMode) {
    const action = await vscode.window.showInformationMessage(summary, "打开 sftp.json");
    if (action === "打开 sftp.json") {
      await openWorkspaceRelativeFile(".vscode/sftp.json");
    }
  }
  return {
    ok: true,
    localPath,
    host: sftp.host,
    username: sftp.username || "",
    port: normalizeSshPort(sftp.port, 22),
    remotePath: sftp.remotePath,
    ignoreCount: Array.isArray(sftp.ignore) ? sftp.ignore.length : 0,
  };
}

function formatSftpTargetSummary(localPath, sftp) {
  const user = sftp.username ? `${sftp.username}@` : "";
  const port = normalizeSshPort(sftp.port, 22);
  return `SimpleSFTP 目标：${user}${sftp.host}:${port} ${sftp.remotePath} -> ${localPath}`;
}

async function updateWorkspaceTarget(options = {}) {
  const localPath = String(options.localPath || getWorkspaceRoot()).trim();
  if (!localPath)
    throw new Error("target.update 缺少本地工作区 localPath。");
  return withHostOperationLease("update-target", "更新 SFTP 工作区目标", localPath, () =>
    updateWorkspaceTargetCore({ ...options, localPath })
  );
}

async function updateWorkspaceTargetCore(options = {}) {
  const localPath = String(options.localPath || "").trim();
  if (!localPath)
    throw new Error("target.update 缺少本地工作区 localPath。");
  const patch = options.patch && typeof options.patch === "object" && !Array.isArray(options.patch)
    ? options.patch
    : {};
  const existing = readSftpConfig(localPath) || {};
  const host = String(patch.host || patch.hostname || existing.host || "").trim();
  const remotePath = String(patch.remotePath || existing.remotePath || "").trim().replace(/\/+$/, "");
  if (!host)
    throw new Error("target.update 缺少目标主机 host。");
  if (!remotePath)
    throw new Error("target.update 缺少远端路径 remotePath。");
  const port = normalizeSshPort(patch.port ?? patch.sshPort ?? existing.port, 22);
  const username = String(patch.username ?? patch.user ?? existing.username ?? existing.user ?? "").trim();
  const ignore = mergeIgnorePatterns(DEFAULT_IGNORES, FIXED_IGNORES);
  const sftp = {
    ...existing,
    ...patch,
    name: String(patch.name || existing.name || `${host}-simple-sftp-target`).trim(),
    host,
    protocol: "sftp",
    port,
    username,
    remotePath,
    uploadOnSave: typeof patch.uploadOnSave === "boolean" ? patch.uploadOnSave : Boolean(existing.uploadOnSave),
    downloadOnOpen: typeof patch.downloadOnOpen === "boolean" ? patch.downloadOnOpen : Boolean(existing.downloadOnOpen),
    useTempFile: typeof patch.useTempFile === "boolean" ? patch.useTempFile : Boolean(existing.useTempFile),
    openSsh: true,
    ignore,
  };
  const configPath = path.join(localPath, ".vscode", "sftp.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(sftp, null, 2)}\n`, "utf8");
  return {
    ok: true,
    localPath,
    host,
    username,
    port,
    remotePath,
    ignoreCount: ignore.length,
  };
}

async function maybePromptForHandoff() {
  const cfg = vscode.workspace.getConfiguration("simpleSftp");
  if (!cfg.get("handoffPrompt")) return;

  const workspaceFolder = getPrimaryWorkspaceFolder();
  if (!workspaceFolder) return;

  const localPath = getWorkspaceRoot();
  const workspaceKey = localPath.toLowerCase();
  if (promptedWorkspaces.has(workspaceKey)) return;
  promptedWorkspaces.add(workspaceKey);

  const sftp = readSftpConfig(localPath);
  if (!sftp || !sftp.remotePath || !sftp.host) return;

  const markerName = cfg.get("handoffMarkerName") || DEFAULT_HANDOFF_MARKER;
  let marker = null;
  try {
    marker = await readRemoteHandoffMarker(sftp, markerName);
  } catch (error) {
    const action = await vscode.window.showWarningMessage(
      `无法读取 SimpleSFTP 交接标记。是否在编辑前同步远端代码？${formatError(error)}`,
      "远端同步到本地",
      "跳过"
    );
    if (action === "远端同步到本地") {
      await syncFromRemote({ confirmMarker: false });
    }
    return;
  }

  const currentDevice = getDeviceName();
  const shouldPrompt = !marker || !marker.device || marker.device !== currentDevice;
  if (!shouldPrompt) return;

  const message = marker
    ? `SimpleSFTP 交接：${marker.device} 已在 ${formatTime(marker.markedAt)} 标记 ${sftp.remotePath} 可交接。是否在编辑前同步远端代码？`
    : `SimpleSFTP 交接：未找到 ${sftp.remotePath} 的远端交接标记。是否在编辑前同步远端代码？`;

  const action = await vscode.window.showInformationMessage(
    message,
    "远端同步到本地",
    "跳过"
  );
  if (action === "远端同步到本地") {
    await syncFromRemote({ confirmMarker: false });
  }
}

async function syncFromRemote(options = {}) {
  const localPath = resolveLocalWorkspacePath(options.localPath, "远端同步到本地");
  return withHostOperationLease("sync-from-remote", "远端同步到本地", localPath, () => syncFromRemoteCore({ ...options, localPath }));
}

function directSyncTarget(value, label) {
  const item = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const host = String(item.host || "").trim();
  const username = String(item.user || item.username || "").trim();
  const remotePath = String(item.remotePath || "").trim().replace(/\/+$/, "");
  const port = normalizeSshPort(item.port || item.sshPort, 22);
  if (!/^[A-Za-z0-9._-]+$/.test(host) || !/^[A-Za-z0-9._-]+$/.test(username)) throw new Error(`${label} SSH 主机或用户名无效。`);
  if (!remotePath.startsWith("/") || remotePath === "/" || remotePath.split("/").includes("..")) throw new Error(`${label} 项目根目录不安全。`);
  return { host, username, remotePath, port };
}

function directSyncRelativePath(value) {
  const relative = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!relative || relative.startsWith("/") || relative.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Plan 产物相对路径不安全。");
  return relative;
}

function guardedRemoteDeleteCommand(target, relativePath) {
  if (!projectTreePathAllowed(relativePath) || relativePath === "simple_cluster") throw new Error("删除路径属于机器状态或包含机器状态。");
  const absolute = path.posix.join(target.remotePath, relativePath);
  const parent = path.posix.dirname(absolute);
  const leaf = `./${path.posix.basename(absolute)}`;
  return `root=$(realpath -e -- ${shellQuote(target.remotePath)}) || { echo PARENT_CD_FAILED >&2; exit 75; }; parent=$(realpath -e -- ${shellQuote(parent)}) || { echo PARENT_CD_FAILED >&2; exit 75; }; case "$parent" in "$root"|"$root"/*) ;; *) exit 72;; esac; cd -- "$parent" || { echo PARENT_CD_FAILED >&2; exit 75; }; test "$(pwd -P)" = "$parent" || { echo PARENT_CD_FAILED >&2; exit 75; }; test ! -L ${shellQuote(leaf)} || exit 72; if test -d ${shellQuote(leaf)}; then command -v rsync >/dev/null 2>&1 || { echo RSYNC_UNAVAILABLE >&2; exit 76; }; empty=$(mktemp -d -- './.simple-sftp-empty.XXXXXXXX') || exit 76; trap 'rmdir -- "$empty" >/dev/null 2>&1 || true' EXIT; rsync -r --delete -- "$empty/" ${shellQuote(`${leaf}/`)} && rmdir -- ${shellQuote(leaf)}; else rm -f -- ${shellQuote(leaf)}; fi && test ! -e ${shellQuote(leaf)}`;
}

function removeLocalStagingDirectory(tempDir) {
  const safetyRoot = fs.realpathSync(os.tmpdir());
  const parent = fs.realpathSync(path.dirname(tempDir));
  const leaf = path.basename(tempDir);
  const info = fs.lstatSync(tempDir);
  if (parent !== safetyRoot || !/^simple-sftp-(?:files|code-sync-state)-[A-Za-z0-9]+$/.test(leaf) || !info.isDirectory() || info.isSymbolicLink())
    throw new Error("临时目录不在已验证的暂存根目录内；禁止清理。");
  const psQuote = (value) => `'${value.replace(/'/g, "''")}'`;
  const command = process.platform === "win32" ? "pwsh.exe" : "sh";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; Set-Location -LiteralPath ${psQuote(parent)}; if ((Get-Location).ProviderPath -ne ${psQuote(parent)}) { throw 'PARENT_CD_FAILED' }; Remove-Item -LiteralPath ${psQuote(`./${leaf}`)} -Recurse -Force -ErrorAction Stop`]
    : ["-c", 'cd -- "$1" || exit 75; test "$(pwd -P)" = "$2" || exit 75; rm -rf -- "./$3"', "sh", parent, safetyRoot, leaf];
  return new Promise((resolve, reject) => execFile(command, args, { cwd: parent, windowsHide: true, timeout: 120000 }, (error) => error ? reject(error) : resolve()));
}

async function deleteProjectPath(options = {}) {
  const target = directSyncTarget(options.target, "删除目标");
  const relativePath = directSyncRelativePath(options.relativePath);
  const absolutePath = path.posix.join(target.remotePath, relativePath);
  if (options.confirmedAbsolutePath !== absolutePath || options.confirm !== true || options.pathConfirmed !== true || options.secondConfirmation !== true)
    throw confirmationRequired({ method: "sync.deletePath", operation: "永久删除单台 Worker 的项目路径", target, relativePath, absolutePath,
      requires: ["confirm", "pathConfirmed", "secondConfirmation", "confirmedAbsolutePath"] });
  const command = guardedRemoteDeleteCommand(target, relativePath);
  try {
    await runSsh(target, command, transferTimeoutMs(target, options));
  } catch (error) {
    const message = formatError(error);
    if (message.includes("PARENT_CD_FAILED")) throw new Error(`PARENT_CD_FAILED：无法进入或验证父目录 ${path.posix.dirname(absolutePath)}；禁止删除。`);
    throw error;
  }
  return { ok: true, target: target.host, relativePath, absolutePath };
}

function directSyncCommand(source, destination, relativePath, directory, deleteOnly = false) {
  const sourcePath = path.posix.join(source.remotePath, relativePath);
  const destinationPath = path.posix.join(destination.remotePath, relativePath);
  const destinationHost = `${destination.username}@${destination.host}`;
  const sshOptions = `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -p ${destination.port}`;
  const destinationGuard = `root=$(realpath -e -- ${shellQuote(destination.remotePath)}) && target=$(realpath -m -- ${shellQuote(destinationPath)}) && case "$target" in "$root"/*) ;; *) exit 72;; esac`;
  if (deleteOnly) return `${sshOptions} ${shellQuote(destinationHost)} ${shellQuote(guardedRemoteDeleteCommand(destination, relativePath))}`;
  const destinationParent = directory ? destinationPath : path.posix.dirname(destinationPath);
  const parentGuard = `root=$(realpath -e -- ${shellQuote(destination.remotePath)}) && parent=$(realpath -m -- ${shellQuote(destinationParent)}) && case "$parent" in "$root"|"$root"/*) ;; *) exit 72;; esac`;
  const prepare = `${sshOptions} ${shellQuote(destinationHost)} ${shellQuote(`${parentGuard} && mkdir -p -- ${shellQuote(destinationParent)} && ${destinationGuard}`)}`;
  const sourceArg = directory ? `${sourcePath}/` : sourcePath;
  const destinationParentForRsync = path.posix.dirname(destinationPath);
  const destinationLeaf = `./${path.posix.basename(destinationPath)}`;
  const guardedRsync = `root=$(realpath -e -- ${shellQuote(destination.remotePath)}) || exit 75; parent=$(realpath -e -- ${shellQuote(destinationParentForRsync)}) || exit 75; case "$parent" in "$root"|"$root"/*) ;; *) exit 72;; esac; cd -- "$parent" || exit 75; test "$(pwd -P)" = "$parent" || exit 75; test ! -L ${shellQuote(destinationLeaf)} || exit 72; rsync`;
  const destinationArg = `${destinationHost}:${directory ? `${destinationLeaf}/` : destinationLeaf}`;
  const rsyncArgs = `-a -c -s --delete-missing-args ${directory ? "--delete " : ""}--rsync-path=${shellQuote(guardedRsync)} -e ${shellQuote(sshOptions)} -- ${shellQuote(sourceArg)} ${shellQuote(destinationArg)}`;
  const sync = `rsync ${rsyncArgs}`;
  const verify = `remaining=$(rsync -n -i ${rsyncArgs}) || exit 74; if [ -n "$remaining" ]; then printf '内容校验不一致: %s\\n' "$remaining"; exit 73; fi`;
  const sourceGuard = `root=$(realpath -e -- ${shellQuote(source.remotePath)}) && target=$(realpath -m -- ${shellQuote(sourcePath)}) && case "$target" in "$root"/*) ;; *) exit 72;; esac`;
  return `${sourceGuard} && ${prepare} && ${sync} && ${verify}`;
}

async function syncServerToServer(options = {}) {
  const source = directSyncTarget(options.source, "来源");
  const destination = directSyncTarget(options.destination, "目标");
  const relativePath = directSyncRelativePath(options.relativePath);
  if (options.directory === true && relativePath.split("/").length < 2 && options.manualRetain !== true) throw new Error("目录同步必须限定到 Plan 独立子目录，禁止清理项目顶层目录。");
  if (options.manualRetain === true && (!projectTreePathAllowed(relativePath) || options.directory === true && relativePath === "simple_cluster")) throw new Error("手动保留版本路径属于机器状态或包含机器状态。");
  if (source.host === destination.host && source.port === destination.port && source.remotePath === destination.remotePath) throw new Error("来源与目标相同。" );
  if (options.confirm !== true || options.pathConfirmed !== true) throw confirmationRequired({
    method: "sync.serverToServer", operation: "Worker 间直接同步 Plan 产物",
    requires: ["confirm", "pathConfirmed"],
    source, destination, relativePath, directory: options.directory === true, deleteOnly: options.deleteOnly === true, deleteStale: true,
  });
  if (options.deleteOnly === true) {
    await runSsh(destination, guardedRemoteDeleteCommand(destination, relativePath), transferTimeoutMs(destination, options));
    return { ok: true, source, destination, relativePath, directory: options.directory === true, deletedStale: true };
  }
  const command = directSyncCommand(source, destination, relativePath, options.directory === true, false);
  const timeoutMs = transferTimeoutMs(source, options);
  try {
    return await new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-A", "-o", "BatchMode=yes", ...getSshArgs(source, command)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    const timer = timeoutMs > 0 ? setTimeout(() => { child.kill(); reject(new Error("Worker 间 rsync 超时；同步状态保持待处理。")); }, timeoutMs) : undefined;
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString("utf8")).slice(-16384); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-16384); });
    child.on("error", (error) => { if (timer) clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ ok: true, source, destination, relativePath, directory: options.directory === true, deletedStale: true, output: stdout.trim() });
      else reject(new Error(`Worker 间 rsync 失败（退出码 ${code}）：${stderr.trim() || stdout.trim() || "SSH 或 rsync 不可用"}`));
    });
    });
  } catch (error) {
    if (!/host key verification failed|no .* host key|permission denied|connection timed out|connect to host|network is unreachable|could not resolve hostname|connection refused/i.test(formatError(error))) throw error;
    const relayed = await relayServerToServer(source, destination, relativePath, options.directory === true, timeoutMs);
    return { ...relayed, directFailure: formatError(error).slice(0, 1000) };
  }
}

async function inspectRemoteScope(target, relativePath, directory, timeoutMs, required = false) {
  const script = [
    "import hashlib,json,os,sys",
    "root=os.path.realpath(sys.argv[1]); rel=sys.argv[2]; directory=sys.argv[3]=='1'; required=sys.argv[4]=='1'",
    "parts=rel.split('/'); target=os.path.join(root,*parts)",
    "if any(p in ('','.','..') for p in parts): raise ValueError('unsafe scope')",
    "if any(os.path.islink(os.path.join(root,*parts[:i])) for i in range(1,len(parts)+1)): raise ValueError('symlink scope')",
    "if os.path.commonpath((root,os.path.realpath(target)))!=root: raise ValueError('scope outside project')",
    "if directory and required and not os.path.isdir(target): raise ValueError('Plan directory missing: '+rel)",
    "paths=[]",
    "if directory and os.path.isdir(target):",
    " for current,dirs,files in os.walk(target,followlinks=False):",
    "  if any(os.path.islink(os.path.join(current,d)) for d in dirs): raise ValueError('symlink directory in Plan scope')",
    "  paths.extend(os.path.join(current,name) for name in files)",
    "elif os.path.isfile(target): paths=[target]",
    "found={}",
    "for full in paths:",
    " if os.path.islink(full) or not os.path.isfile(full): raise ValueError('unsafe file in Plan scope')",
    " h=hashlib.sha256()",
    " with open(full,'rb') as stream:",
    "  before=os.fstat(stream.fileno())",
    "  for chunk in iter(lambda:stream.read(1048576),b''): h.update(chunk)",
    "  after=os.fstat(stream.fileno())",
    " if before.st_size!=after.st_size or before.st_mtime_ns!=after.st_mtime_ns: raise ValueError('file changed during Plan sync')",
    " found[os.path.relpath(full,root).replace(os.sep,'/')]={'sha256':h.hexdigest(),'size':after.st_size}",
    "print(json.dumps({'files':found},separators=(',',':')))",
  ].join("\n");
  const stdout = await runSsh(target, `python3 -c ${shellQuote(script)} ${shellQuote(target.remotePath)} ${shellQuote(relativePath)} ${directory ? "1" : "0"} ${required ? "1" : "0"}`, timeoutMs);
  const result = JSON.parse(stdout);
  if (!result.files || typeof result.files !== "object" || Array.isArray(result.files)) throw new Error("Plan 内容清单无效。");
  return result.files;
}

function relayTarFiles(source, destination, paths, timeoutMs) {
  if (!paths.length) return Promise.resolve();
  const sourceCommand = `cd ${shellQuote(source.remotePath)} && tar --null -T - -cf -`;
  const destinationCommand = `cd ${shellQuote(destination.remotePath)} && tar -xf -`;
  return new Promise((resolve, reject) => {
    const reader = spawn("ssh", getSshArgs(source, sourceCommand), { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const writer = spawn("ssh", getSshArgs(destination, destinationCommand), { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let sourceCode;
    let destinationCode;
    let stderr = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { reader.kill(); writer.kill(); reject(error); } else resolve();
    };
    const timer = timeoutMs > 0 ? setTimeout(() => finish(new Error("本机内存转发超过传输时限。")), timeoutMs) : null;
    reader.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-16384); });
    writer.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-16384); });
    reader.on("error", (error) => finish(error));
    writer.on("error", (error) => finish(error));
    reader.on("close", (code) => { sourceCode = code; if (destinationCode !== undefined) finish(sourceCode === 0 && destinationCode === 0 ? null : new Error(`内存转发失败：${stderr || `${sourceCode}/${destinationCode}`}`)); });
    writer.on("close", (code) => { destinationCode = code; if (sourceCode !== undefined) finish(sourceCode === 0 && destinationCode === 0 ? null : new Error(`内存转发失败：${stderr || `${sourceCode}/${destinationCode}`}`)); });
    reader.stdout.pipe(writer.stdin);
    writer.stdin.on("error", () => {});
    reader.stdin.on("error", () => {});
    reader.stdin.end(Buffer.from(paths.map((name) => `${name}\0`).join(""), "utf8"));
  });
}

async function removeStaleRemoteFiles(destination, scope, paths, timeoutMs) {
  for (let offset = 0; offset < paths.length; offset += 100) {
    const encoded = Buffer.from(JSON.stringify(paths.slice(offset, offset + 100)), "utf8").toString("base64");
    const script = [
      "import base64,json,os,sys",
      "root=os.path.realpath(sys.argv[1]); scope=os.path.realpath(os.path.join(root,sys.argv[2]))",
      "for rel in json.loads(base64.b64decode(sys.argv[3])):",
      " target=os.path.join(root,*rel.split('/'))",
      " if os.path.commonpath((scope,os.path.realpath(target)))!=scope or os.path.islink(target) or not os.path.isfile(target): raise ValueError('unsafe stale file')",
      " parent=os.path.realpath(os.path.dirname(target))",
      " if os.path.commonpath((scope,parent))!=scope: raise ValueError('unsafe stale parent')",
      " try: os.chdir(parent)",
      " except OSError as error: raise RuntimeError('PARENT_CD_FAILED: '+str(error))",
      " if os.path.realpath(os.getcwd())!=parent: raise RuntimeError('PARENT_CD_FAILED')",
      " os.unlink('./'+os.path.basename(target))",
    ].join("\n");
    await runSsh(destination, `python3 -c ${shellQuote(script)} ${shellQuote(destination.remotePath)} ${shellQuote(scope)} ${shellQuote(encoded)}`, timeoutMs);
  }
}

async function relayServerToServer(source, destination, relativePath, directory, timeoutMs) {
  const sourceFiles = await inspectRemoteScope(source, relativePath, directory, timeoutMs, directory);
  const destinationFiles = await inspectRemoteScope(destination, relativePath, directory, timeoutMs);
  if (directory) {
    const target = path.posix.join(destination.remotePath, relativePath);
    const guard = `root=$(realpath -e -- ${shellQuote(destination.remotePath)}) && target=$(realpath -m -- ${shellQuote(target)}) && case "$target" in "$root"/*) ;; *) exit 72;; esac`;
    await runSsh(destination, `${guard} && mkdir -p -- ${shellQuote(target)}`, timeoutMs);
  }
  const changed = Object.keys(sourceFiles).filter((name) => sourceFiles[name].sha256 !== destinationFiles[name]?.sha256).sort();
  const stale = Object.keys(destinationFiles).filter((name) => !sourceFiles[name]).sort();
  await relayTarFiles(source, destination, changed, timeoutMs);
  if (stale.length) await removeStaleRemoteFiles(destination, relativePath, stale, timeoutMs);
  const verified = await inspectRemoteScope(destination, relativePath, directory, timeoutMs);
  if (JSON.stringify(Object.entries(sourceFiles).sort()) !== JSON.stringify(Object.entries(verified).sort()))
    throw new Error("本机内存转发后内容 SHA256 不一致；同步保持待处理。");
  return { ok: true, source, destination, relativePath, directory, deletedStale: stale.length > 0, transferredFiles: changed.length, verification: "sha256", transport: "memory-relay" };
}

async function listPlanLogPaths(options = {}) {
  const source = directSyncTarget(options.source, "来源");
  const statePath = directSyncRelativePath(options.statePath);
  if (!statePath.startsWith("simple_cluster/tmp/cluster_scheduler/") || !statePath.endsWith("_state.json"))
    throw new Error("Plan 状态文件路径不受支持。");
  const text = await runSsh(source, `cat -- ${shellQuote(path.posix.join(source.remotePath, statePath))}`, transferTimeoutMs(source, options));
  if (Buffer.byteLength(text, "utf8") > 20 * 1024 * 1024) throw new Error("Plan 状态文件过大。");
  return { ok: true, paths: planLogPathsFromState(JSON.parse(text), options.planFile) };
}

function planLogPathsFromState(state, planFile) {
  const expectedPlan = String(planFile || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const actualPlan = String(state.plan || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  if (!expectedPlan || actualPlan !== expectedPlan) throw new Error("Plan 状态文件与目标 Plan 不匹配。");
  const paths = new Set();
  const add = (raw) => {
    if (!raw) return;
    const relative = directSyncRelativePath(raw);
    if (!relative.startsWith("simple_cluster/tmp/cluster_scheduler/") && !relative.startsWith("simple_cluster/debug_runs/") && !relative.startsWith("tmp/tmux_logs/"))
      throw new Error(`Plan 日志路径超出允许范围：${relative}`);
    paths.add(relative);
  };
  add(state.scheduler_log);
  for (const key of ["completed_experiments", "failed_experiments", "stopped_experiments", "running_experiments", "testing_experiments"])
    for (const row of Array.isArray(state[key]) ? state[key] : []) add(row?.log_path);
  return [...paths].sort();
}

async function projectInventory(options = {}) {
  const source = directSyncTarget(options.source, "来源");
  const relativePath = options.relativePath === undefined ? "." : String(options.relativePath) === "." ? "." : directSyncRelativePath(options.relativePath);
  const recursive = options.recursive !== false;
  if (options.scopePaths !== undefined && !Array.isArray(options.scopePaths)) throw new Error("清单范围必须是路径数组。");
  const scopePaths = options.scopePaths === undefined ? null : options.scopePaths.map((item) => String(item) === "." ? "." : directSyncRelativePath(item));
  if (relativePath !== "." && !projectTreePathAllowed(relativePath)) throw new Error("清单目录属于机器状态。");
  const script = projectInventoryScript();
  const output = await runSsh(source, `python3 -c ${shellQuote(script)} ${shellQuote(source.remotePath)} ${shellQuote(relativePath)} ${recursive ? "1" : "0"} ${shellQuote(JSON.stringify(scopePaths))}`, transferTimeoutMs(source, options));
  const result = JSON.parse(output);
  if (!result.files || typeof result.files !== "object" || Array.isArray(result.files)) throw new Error("远端项目清单无效。");
  return { ok: true, files: result.files, unverifiedFiles: result.unverifiedFiles || {}, hashedFiles: result.hashedFiles, reusedFiles: result.reusedFiles };
}

function projectInventoryScript() {
  return [
    "import hashlib,json,os,sqlite3,stat as statmod,sys",
    "from concurrent.futures import ThreadPoolExecutor",
    "root=os.path.realpath(sys.argv[1]); relroot=sys.argv[2]; recursive=sys.argv[3]=='1'; scopes=json.loads(sys.argv[4]) if len(sys.argv)>4 else None; found={}; unverified={}; updates=[]; hashed=0; reused=0",
    "blocked={'.git','.vscode','.codex','.agents','.coding-tools','.local-gpt','.runtime','clean_dir','zlk_cluster','.venv','venv','env','node_modules','__pycache__','.cache','.pytest_cache','.mypy_cache','.ruff_cache','.tox'}",
    "def allowed(rel,isdir=False):",
    " parts=rel.replace(os.sep,'/').lower().split('/')",
    " if parts[0]=='tmp' or any(p in blocked for p in parts): return False",
    " if len(parts)>2 and parts[:2]==['experiments','results'] and parts[-1].endswith('.csv.lock'): return False",
    " if parts[0]=='work_dirs' and parts[-1]=='.tb_mean.lock': return False",
    " if parts[-1].startswith('.env') or parts[-1] in ('plan_sync_ledger.json','project_mirror_state.json'): return False",
    " if parts[0]!='simple_cluster': return True",
    " if len(parts)<2: return True",
    " if parts[1] in ('results','debug_runs'): return True",
    " if parts[1]=='tmp' and len(parts)==2: return isdir",
    " if parts[1]=='tmp' and len(parts)>2 and parts[2]=='tmux_logs': return True",
    " if parts[1]=='tmp' and len(parts)>2 and parts[2]=='cluster_scheduler': return (len(parts)==3 and isdir) or (len(parts)>3 and parts[3]=='logs') or (len(parts)==4 and parts[-1].endswith('.log'))",
    " return False",
    "def in_scope(rel,isdir=False):",
    " return scopes is None or any(scope=='.' or rel==scope or rel.startswith(scope+'/') or (isdir and scope.startswith(rel+'/')) for scope in scopes)",
    "parts=[] if relroot=='.' else relroot.split('/')",
    "if any(p in ('','.','..') for p in parts): raise ValueError('unsafe inventory path')",
    "if any(os.path.islink(os.path.join(root,*parts[:i])) for i in range(1,len(parts)+1)): raise ValueError('symlink inventory path')",
    "target=os.path.join(root,*parts)",
    "if os.path.commonpath((root,os.path.realpath(target)))!=root: raise ValueError('inventory path outside project')",
    "if not os.path.isdir(target) and not os.path.isfile(target): print(json.dumps({'files':{}})); sys.exit(0)",
    "cache={}; db=None; cache_root=hashlib.sha256(root.encode('utf-8')).hexdigest()",
    "try:",
    " cache_dir=os.path.join(os.path.expanduser('~'),'.cache','simple-sftp')",
    " os.makedirs(cache_dir,mode=0o700,exist_ok=True)",
    " db=sqlite3.connect(os.path.join(cache_dir,'project-inventory.sqlite3'),timeout=5)",
    " db.execute('CREATE TABLE IF NOT EXISTS hashes (root TEXT NOT NULL, path TEXT NOT NULL, dev INTEGER NOT NULL, ino INTEGER NOT NULL, size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, ctime_ns INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(root,path))')",
    " cache={row[0]:row[1:] for row in db.execute('SELECT path,dev,ino,size,mtime_ns,ctime_ns,sha256 FROM hashes WHERE root=?',(cache_root,))}",
    "except (OSError,sqlite3.Error):",
    " if db is not None: db.close()",
    " db=None; cache={}",
    "walk=((os.path.dirname(target),[],[os.path.basename(target)]),) if os.path.isfile(target) else os.walk(target,followlinks=False) if recursive else ((target,[],[name for name in os.listdir(target) if not os.path.isdir(os.path.join(target,name))]),)",
    "names=[]",
    "for current,dirs,files in walk:",
    " if recursive: dirs[:]=[d for d in dirs if not os.path.islink(os.path.join(current,d)) and allowed(os.path.relpath(os.path.join(current,d),root),True) and in_scope(os.path.relpath(os.path.join(current,d),root).replace(os.sep,'/'),True)]",
    " for name in files:",
    "  full=os.path.join(current,name); rel=os.path.relpath(full,root).replace(os.sep,'/')",
    "  if allowed(rel) and in_scope(rel): names.append((rel,full))",
    "def inspect(item):",
    " rel,full=item",
    " try:",
    "  stat=os.stat(full,follow_symlinks=False)",
    "  if statmod.S_ISLNK(stat.st_mode): return (rel,None,None,None)",
    "  if not statmod.S_ISREG(stat.st_mode): return (rel,None,None,'文件读取期间消失或不是普通文件')",
    "  identity=(stat.st_dev,stat.st_ino,stat.st_size,stat.st_mtime_ns,stat.st_ctime_ns)",
    "  cached=cache.get(rel)",
    "  if cached is not None and cached[:5]==identity:",
    "   return (rel,{'sha256':cached[5],'size':stat.st_size,'modifiedAtMs':stat.st_mtime_ns//1000000},None,None)",
    "  with open(full,'rb') as stream:",
    "   before=os.fstat(stream.fileno()); h=hashlib.sha256()",
    "   for chunk in iter(lambda:stream.read(1048576),b''): h.update(chunk)",
    "   after=os.fstat(stream.fileno())",
    "  if identity!=(before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns) or identity!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):",
    "   return (rel,None,None,'文件校验期间发生变化')",
    "  digest=h.hexdigest()",
    "  return (rel,{'sha256':digest,'size':after.st_size,'modifiedAtMs':after.st_mtime_ns//1000000},(cache_root,rel,*identity,digest),None)",
    " except (FileNotFoundError,PermissionError,OSError) as exc:",
    "  return (rel,None,None,type(exc).__name__)",
    "with ThreadPoolExecutor(max_workers=8) as pool:",
    " for rel,entry,update,error in pool.map(inspect,names):",
    "  if error: unverified[rel]=error",
    "  elif entry:",
    "   found[rel]=entry",
    "   if update: hashed+=1; updates.append(update)",
    "   else: reused+=1",
    "if db is not None:",
    " try:",
    "  if updates:",
    "   db.executemany('INSERT INTO hashes (root,path,dev,ino,size,mtime_ns,ctime_ns,sha256) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(root,path) DO UPDATE SET dev=excluded.dev,ino=excluded.ino,size=excluded.size,mtime_ns=excluded.mtime_ns,ctime_ns=excluded.ctime_ns,sha256=excluded.sha256',updates)",
    "   db.commit()",
    " except (OSError,sqlite3.Error): pass",
    " finally: db.close()",
    "print(json.dumps({'files':found,'unverifiedFiles':unverified,'hashedFiles':hashed,'reusedFiles':reused},separators=(',',':')))",
  ].join("\n");
}

function projectTreePathAllowed(relative) {
  const parts = String(relative || "").toLowerCase().split("/");
  if (parts[0] === "tmp" || parts.some((part) => [".git", ".vscode", ".codex", ".agents", ".coding-tools", ".local-gpt", ".runtime", "clean_dir", "zlk_cluster", ".venv", "venv", "env", "node_modules", "__pycache__", ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox"].includes(part))) return false;
  if (parts[0] === "experiments" && parts[1] === "results" && parts.at(-1).endsWith(".csv.lock")) return false;
  if (parts[0] === "work_dirs" && parts.at(-1) === ".tb_mean.lock") return false;
  if (parts.at(-1).startsWith(".env")) return false;
  if (["plan_sync_ledger.json", "project_mirror_state.json"].includes(parts.at(-1))) return false;
  if (parts[0] !== "simple_cluster" || parts.length < 2) return true;
  if (["results", "debug_runs"].includes(parts[1])) return true;
  if (parts[1] !== "tmp") return false;
  if (parts.length === 2 || parts[2] === "tmux_logs") return true;
  if (parts[2] === "cluster_scheduler") return parts.length === 3 || parts[3] === "logs" || parts.length === 4 && parts.at(-1).endsWith(".log");
  return false;
}

async function projectTree(options = {}) {
  const source = directSyncTarget(options.source, "来源");
  const relativePath = String(options.relativePath || ".") === "." ? "." : directSyncRelativePath(options.relativePath);
  if (relativePath !== "." && !projectTreePathAllowed(relativePath)) throw new Error("远端目录属于机器状态，不可纳入同步范围。");
  const script = [
    "import json,os,sys",
    "root=os.path.realpath(sys.argv[1]); rel=sys.argv[2]",
    "parts=[] if rel=='.' else rel.split('/')",
    "if any(p in ('','.','..') for p in parts): raise ValueError('unsafe tree path')",
    "if any(os.path.islink(os.path.join(root,*parts[:i])) for i in range(1,len(parts)+1)): raise ValueError('symlink tree path')",
    "target=os.path.join(root,*parts)",
    "if os.path.commonpath((root,os.path.realpath(target)))!=root: raise ValueError('tree directory outside project')",
    "if not os.path.exists(target): print('[]'); sys.exit(0)",
    "if not os.path.isdir(target): print('[]'); sys.exit(0)",
    "entries=[]",
    "for item in os.scandir(target):",
    " if item.is_symlink(): continue",
    " if not item.is_dir(follow_symlinks=False) and not item.is_file(follow_symlinks=False): continue",
    " name=item.name; child=name if rel=='.' else rel+'/'+name",
    " stat=item.stat(follow_symlinks=False)",
    " entries.append({'name':name,'path':child,'directory':item.is_dir(follow_symlinks=False),'size':stat.st_size if item.is_file(follow_symlinks=False) else None,'modifiedAtMs':stat.st_mtime_ns//1000000})",
    "print(json.dumps(entries,ensure_ascii=False,separators=(',',':')))",
  ].join("\n");
  const output = await runSsh(source, `python3 -c ${shellQuote(script)} ${shellQuote(source.remotePath)} ${shellQuote(relativePath)}`, transferTimeoutMs(source, options));
  const entries = JSON.parse(output);
  if (!Array.isArray(entries)) throw new Error("远端目录清单无效。");
  return { ok: true, relativePath, entries: entries.filter((entry) => projectTreePathAllowed(entry.path)).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) };
}

function runRemoteBatchSsh(source, command, paths, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-A", "-o", "BatchMode=yes", ...getSshArgs(source, command)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = timeoutMs > 0 ? setTimeout(() => { child.kill(); finish(new Error("跨 Worker 批量同步超时。")); }, timeoutMs) : null;
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 4 * 1024 * 1024) { child.kill(); finish(new Error("远端批量清单超过 4 MB。")); }
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-16384); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => code === 0
      ? finish(null, stdout.trim())
      : finish(new Error(`跨 Worker rsync 失败（${code}）：${stderr.trim() || stdout.trim() || "SSH 或 rsync 不可用"}`)));
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.from(paths.map((name) => `${name}\0`).join(""), "utf8"));
  });
}

async function inspectRemoteBatchFiles(target, paths, timeoutMs) {
  const script = [
    "import hashlib,json,os,sys",
    "root=os.path.realpath(sys.argv[1]); found={}",
    "for raw in sys.stdin.buffer.read().split(b'\\0'):",
    " if not raw: continue",
    " rel=raw.decode('utf-8'); parts=rel.split('/')",
    " if any(p in ('','.','..') for p in parts): raise ValueError('unsafe batch path')",
    " if any(os.path.islink(os.path.join(root,*parts[:i])) for i in range(1,len(parts)+1)): raise ValueError('symlink batch path: '+rel)",
    " full=os.path.join(root,*parts)",
    " if os.path.commonpath((root,os.path.realpath(full)))!=root: raise ValueError('batch path outside project')",
    " if not os.path.exists(full): found[rel]=None; continue",
    " if not os.path.isfile(full): raise ValueError('batch path is not a file: '+rel)",
    " with open(full,'rb') as stream:",
    "  before=os.fstat(stream.fileno()); h=hashlib.sha256()",
    "  for chunk in iter(lambda:stream.read(1048576),b''): h.update(chunk)",
    "  after=os.fstat(stream.fileno())",
    " if before.st_size!=after.st_size or before.st_mtime_ns!=after.st_mtime_ns: raise ValueError('file changed during batch sync: '+rel)",
    " found[rel]=h.hexdigest()",
    "print(json.dumps(found,separators=(',',':')))",
  ].join("\n");
  const stdout = await runRemoteBatchSsh(target, `python3 -c ${shellQuote(script)} ${shellQuote(target.remotePath)}`, paths, timeoutMs);
  const found = JSON.parse(stdout);
  if (!found || typeof found !== "object" || Array.isArray(found) || Object.keys(found).length !== paths.length)
    throw new Error("远端批量内容清单不完整。");
  return found;
}

function batchDestinationGuardCommand(destination) {
  const destinationHost = `${destination.username}@${destination.host}`;
  const destinationGuard = `root=$(realpath -e -- ${shellQuote(destination.remotePath)}) && test "$root" = ${shellQuote(destination.remotePath)}`;
  // The guard runs before rsync and must not consume its --files-from stdin.
  return `ssh -n -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p ${destination.port} ${shellQuote(destinationHost)} ${shellQuote(destinationGuard)}`;
}

async function syncServerToServerBatch(options = {}) {
  const source = directSyncTarget(options.source, "来源");
  const destination = directSyncTarget(options.destination, "目标");
  const paths = [...new Set((Array.isArray(options.relativePaths) ? options.relativePaths : []).map(directSyncRelativePath))].sort();
  if (!paths.length || paths.length > 5000) throw new Error("批量同步需要 1–5000 个项目内文件路径。");
  if (source.host === destination.host && source.port === destination.port && source.remotePath === destination.remotePath) throw new Error("来源与目标相同。");
  if (options.confirm !== true || options.pathConfirmed !== true) throw confirmationRequired({
    method: "sync.serverToServerBatch", operation: "Worker 间批量补齐项目文件", requires: ["confirm", "pathConfirmed"],
    source, destination, relativePaths: paths,
  });
  const destinationHost = `${destination.username}@${destination.host}`;
  const sshOptions = `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p ${destination.port}`;
  const sourceGuard = `root=$(realpath -e -- ${shellQuote(source.remotePath)}) && test "$root" = ${shellQuote(source.remotePath)}`;
  const prepare = batchDestinationGuardCommand(destination);
  const args = `-a -c -s --from0 --files-from=- -e ${shellQuote(sshOptions)} -- ${shellQuote(source.remotePath + "/")} ${shellQuote(destinationHost + ":" + destination.remotePath + "/")}`;
  const prefix = `${sourceGuard} && ${prepare} && `;
  const timeout = transferTimeoutMs(source, options);
  try {
    await runRemoteBatchSsh(source, `${prefix}rsync ${args}`, paths, timeout);
    const remaining = await runRemoteBatchSsh(source, `${prefix}rsync -n -i ${args}`, paths, timeout);
    if (remaining) throw new Error(`跨 Worker 批量内容校验不一致：${remaining.slice(0, 2000)}`);
    return { ok: true, paths: paths.length, verification: "rsync-checksum", transport: "direct-rsync" };
  } catch (error) {
    if (!/host key verification failed|no .* host key|permission denied|connection timed out|connect to host|network is unreachable|could not resolve hostname|connection refused/i.test(formatError(error))) throw error;
    const sourceHashes = await inspectRemoteBatchFiles(source, paths, timeout);
    if (paths.some((name) => !sourceHashes[name])) throw new Error("来源 Worker 缺少批量同步文件；同步保持待处理。");
    const destinationHashes = await inspectRemoteBatchFiles(destination, paths, timeout);
    const changed = paths.filter((name) => sourceHashes[name] !== destinationHashes[name]);
    await relayTarFiles(source, destination, changed, timeout);
    const verified = await inspectRemoteBatchFiles(destination, paths, timeout);
    if (paths.some((name) => sourceHashes[name] !== verified[name])) throw new Error("批量内存转发后 SHA256 不一致；同步保持待处理。");
    return { ok: true, paths: paths.length, transferredFiles: changed.length, verification: "sha256", transport: "memory-relay", directFailure: formatError(error).slice(0, 1000) };
  }
}

function partitionTransferPaths(paths, maxFiles = 1000) {
  const groups = [];
  for (let offset = 0; offset < paths.length; offset += maxFiles) {
    groups.push(paths.slice(offset, offset + maxFiles));
  }
  return groups;
}

function directTarBatchCommand(source, destination) {
  const destinationHost = `${destination.username}@${destination.host}`;
  const destinationCommand = `root=$(realpath -e -- ${shellQuote(destination.remotePath)}) && test "$root" = ${shellQuote(destination.remotePath)} && cd -- "$root" && tar -xf -`;
  const sshOptions = `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p ${destination.port}`;
  const sourceCommand = `root=$(realpath -e -- ${shellQuote(source.remotePath)}) && test "$root" = ${shellQuote(source.remotePath)} && cd -- "$root" && tar --null -T - -cf - | ${sshOptions} ${shellQuote(destinationHost)} ${shellQuote(destinationCommand)}`;
  return `bash -o pipefail -c ${shellQuote(sourceCommand)}`;
}

async function transferPartitionedTar(source, destination, paths, timeoutMs) {
  // fpsync-style bounded partitions, with tar as the copy tool. No remote
  // installation or staging directory is needed for an explicit hash delta.
  const groups = partitionTransferPaths(paths);
  let next = 0;
  const directCommand = directTarBatchCommand(source, destination);
  const workers = Array.from({ length: Math.min(4, groups.length) }, async () => {
    while (next < groups.length) {
      const group = groups[next++];
      try {
        await runRemoteBatchSsh(source, directCommand, group, timeoutMs);
      } catch (error) {
        if (!/host key verification failed|no .* host key|permission denied|connection timed out|connect to host|network is unreachable|could not resolve hostname|connection refused/i.test(formatError(error))) throw error;
        await relayTarFiles(source, destination, group, timeoutMs);
      }
    }
  });
  await Promise.all(workers);
  return groups.length;
}

async function syncServerToServerFpsync(options = {}) {
  const source = directSyncTarget(options.source, "来源");
  const destination = directSyncTarget(options.destination, "目标");
  if (source.host === destination.host && source.port === destination.port && source.remotePath === destination.remotePath) throw new Error("来源与目标相同。");
  const directory = options.directory === true;
  const relativePath = directory ? directSyncRelativePath(options.relativePath) : "";
  if (directory && relativePath.split("/").length < 2 && options.manualRetain !== true) throw new Error("目录同步必须限定到 Plan 独立子目录。");
  const requested = directory ? [] : [...new Set((Array.isArray(options.relativePaths) ? options.relativePaths : []).map(directSyncRelativePath))].sort();
  if (!directory && (!requested.length || requested.length > 5000)) throw new Error("批量同步需要 1–5000 个项目内文件路径。");
  if (options.confirm !== true || options.pathConfirmed !== true) throw confirmationRequired({
    method: "sync.serverToServerFpsync", operation: "Worker 间分批打包同步", requires: ["confirm", "pathConfirmed"],
    source, destination, relativePath, relativePaths: requested, directory,
  });
  const timeoutMs = transferTimeoutMs(source, options);
  let sourceHashes;
  let destinationHashes;
  if (directory) {
    [sourceHashes, destinationHashes] = await Promise.all([
      inspectRemoteScope(source, relativePath, true, timeoutMs, true),
      inspectRemoteScope(destination, relativePath, true, timeoutMs),
    ]);
    const stale = Object.keys(destinationHashes).filter((name) => !sourceHashes[name]);
    if (stale.length) throw new Error(`目标目录有 ${stale.length} 个旧文件，需要先通过双重确认清理：${stale.slice(0, 3).join("、")}`);
  } else {
    [sourceHashes, destinationHashes] = await Promise.all([
      inspectRemoteBatchFiles(source, requested, timeoutMs),
      inspectRemoteBatchFiles(destination, requested, timeoutMs),
    ]);
    if (requested.some((name) => !sourceHashes[name])) throw new Error("来源 Worker 缺少批量同步文件；同步保持待处理。");
  }
  const paths = directory ? Object.keys(sourceHashes).sort() : requested;
  const digest = (entry) => typeof entry === "string" ? entry : entry && entry.sha256;
  const changed = paths.filter((name) => digest(sourceHashes[name]) !== digest(destinationHashes[name]));
  const partitions = await transferPartitionedTar(source, destination, changed, timeoutMs);
  const verified = directory
    ? await inspectRemoteScope(destination, relativePath, true, timeoutMs)
    : await inspectRemoteBatchFiles(destination, requested, timeoutMs);
  if (paths.some((name) => digest(sourceHashes[name]) !== digest(verified[name]))) throw new Error("分批打包同步后 SHA256 不一致；同步保持待处理。");
  return { ok: true, paths: paths.length, transferredFiles: changed.length, partitions,
    verification: "sha256", transport: "partitioned-tar", directory, relativePath };
}

async function syncFromRemoteCore(options = {}) {
  try {
    const workspaceFolder = getPrimaryWorkspaceFolder();
    if (!workspaceFolder && !options.localPath) {
      const message = "请先打开 SimpleSFTP 工作区，或传入 localPath。";
      if (options.apiMode) throw new Error(message);
      vscode.window.showErrorMessage(message);
      return { ok: false, error: message };
    }

    const localPath = String(options.localPath || getWorkspaceRoot()).trim();
    const hasTargetOptions = Boolean(options.server || options.remotePath || options.host);
    const sftp = hasTargetOptions ? resolveUploadSftp(localPath, options) : readSftpConfig(localPath);
    if (!sftp) {
      const message = hasTargetOptions ? "未提供可用的远端来源。" : "当前工作区未找到 .vscode/sftp.json。";
      if (options.apiMode) throw new Error(message);
      vscode.window.showErrorMessage(message);
      return { ok: false, error: message };
    }

    await confirmTransferPath({ localPath, sftp, operation: "远端同步到本地", detail: "远端项目文件覆盖到当前工作区", options });

    const cfg = vscode.workspace.getConfiguration("simpleSftp");
    const markerName = cfg.get("handoffMarkerName") || DEFAULT_HANDOFF_MARKER;
    const marker = await readRemoteHandoffMarker(sftp, markerName).catch(() => null);
    if (!options.apiMode && options.confirmMarker !== false && marker) {
      const action = await vscode.window.showInformationMessage(
        `上次交接上传：${marker.device || "未知设备"}，时间 ${formatTime(marker.markedAt)}。是否继续从远端同步到本地？`,
        "继续",
        "取消"
      );
      if (action !== "继续") return;
    }

    const syncStartedAt = new Date();
    const scopedPaths = Array.isArray(options.paths) ? options.paths : null;
    const downloadScope = scopedPaths ? explicitDownloadScope(options) : readTargetDownloadScope(localPath, options, sftp);
    if (scopedPaths) assertSafeScopedLocalPaths(localPath, downloadScope.paths);
    await downloadRemoteToLocal({ localPath, sftp, downloadScope });
    if (!scopedPaths) {
      writeLocalSessionRecord(localPath, {
        action: "remoteToLocal",
        device: getDeviceName(),
        remotePath: sftp.remotePath,
        at: new Date().toISOString(),
      });
      writeUploadState(localPath, {
        lastUploadedAt: syncStartedAt.toISOString(),
        mode: "remoteToLocal",
        remotePath: sftp.remotePath,
      });
    }
    if (options.apiMode) {
      return {
        ok: true,
        localPath,
        remotePath: sftp.remotePath,
        downloadedAt: syncStartedAt.toISOString(),
        ...(scopedPaths ? { paths: downloadScope.paths } : {}),
      };
    }
    vscode.window.showInformationMessage("SimpleSFTP 已完成远端到本地同步。");
  } catch (error) {
    if (options.apiMode) throw error;
    vscode.window.showErrorMessage(`启动远端到本地同步失败：${formatError(error)}`);
  }
}

async function markHandoffReady(options = {}) {
  const localPath = resolveLocalWorkspacePath(options.localPath, "上传并标记交接");
  return withHostOperationLease("mark-handoff-ready", "上传并标记交接", localPath, () => markHandoffReadyCore({ ...options, localPath }));
}

async function markHandoffReadyCore(options = {}) {
  try {
    const workspaceFolder = getPrimaryWorkspaceFolder();
    const localPath = String(options.localPath || getWorkspaceRoot() || "").trim();
    if (!workspaceFolder && !localPath) {
      const message = "请先打开 SimpleSFTP 工作区，或由调用方传入 localPath。";
      if (options.apiMode) throw new Error(message);
      vscode.window.showErrorMessage(message);
      return { ok: false, error: message };
    }
    const sftp = readSftpConfig(localPath);
    if (!sftp || !sftp.remotePath || !sftp.host) {
      const message = "当前工作区没有可用的 .vscode/sftp.json。";
      if (options.apiMode) throw new Error(message);
      vscode.window.showErrorMessage(message);
      return { ok: false, error: message };
    }

    await confirmTransferPath({ localPath, sftp, operation: "写入交接标记", detail: "远端项目交接标记；若选择上传则包含全部本地文件", options });

    let uploadRequested = false;
    if (options.apiMode) {
      uploadRequested = options.upload === true;
    } else {
      const action = await vscode.window.showInformationMessage(
        "是否先上传全部本地代码，再把该项目标记为可交接到下一台设备？",
        "上传全部并标记",
        "仅标记",
        "取消"
      );
      if (!action || action === "取消") return { ok: false, cancelled: true };
      uploadRequested = action === "上传全部并标记";
    }

    if (uploadRequested) {
      await uploadAllLocalToRemote({ localPath, sftp, pathConfirmed: true });
    }

    const marker = {
      version: 1,
      project: path.posix.basename(String(sftp.remotePath).replace(/\/+$/, "")),
      remotePath: sftp.remotePath,
      localPath,
      device: getDeviceName(),
      user: os.userInfo().username,
      markedAt: new Date().toISOString(),
      uploadRequested,
      uploadMode: uploadRequested ? "all" : "none",
    };

    const cfg = vscode.workspace.getConfiguration("simpleSftp");
    const markerName = cfg.get("handoffMarkerName") || DEFAULT_HANDOFF_MARKER;
    await writeRemoteHandoffMarker(sftp, markerName, marker);
    writeLocalSessionRecord(localPath, {
      action: "handoffReady",
      ...marker,
    });

    if (options.apiMode) {
      return {
        ok: true,
        localPath,
        remotePath: sftp.remotePath,
        markedAt: marker.markedAt,
        uploadRequested,
      };
    }
    vscode.window.showInformationMessage(`SimpleSFTP 已由 ${marker.device} 写入交接标记。`);
  } catch (error) {
    if (options.apiMode) throw error;
    vscode.window.showErrorMessage(`写入交接标记失败：${formatError(error)}`);
  }
}

async function uploadWorkspace(options = {}) {
  const localPath = resolveLocalWorkspacePath(options.localPath, "上传工作区");
  return withHostOperationLease("upload-workspace", "上传工作区", localPath, () => uploadWorkspaceCore(options));
}

async function uploadWorkspaceCore(options = {}) {
  try {
    const localPath = resolveLocalWorkspacePath(options.localPath, "上传工作区");
    if (!localPath) throw new Error("请先打开工作区，或传入 localPath。");
    const sftp = resolveUploadSftp(localPath, options);
    if (options.expectedTransferTarget) assertTransferTargetUnchanged(options.expectedTransferTarget, sftp);
    if (!sftp || !sftp.remotePath || !sftp.host) {
      throw new Error("未提供可用的 SFTP 目标。");
    }
    const remoteRoot = String(sftp.remotePath || "").replace(/\/+$/, "");
    await confirmTransferPath({ localPath, sftp, operation: "上传工作区", detail: options.manifest ? "manifest 指定代码文件" : "当前工作区内未被忽略的文件", options });
    migrateLegacyCodeSyncState(localPath);
    const state = createCodeSyncState(sftp, options);
    const manifest = getManagedManifest(options.manifest);
    const previousState = manifest && options.pruneManagedFiles !== false && options.transientManifest !== true
      ? await readRemoteCodeManifest(sftp).catch(() => null)
      : null;
    const previousManifest = previousState && typeof previousState === "object" ? previousState.manifest : null;
    const legacyManagedDir = previousState && typeof previousState === "object" ? previousState.legacyManagedDir : "";
    let uploadStats;
    if (manifest) {
      const before = await inspectRemoteManagedFiles(sftp, manifest, transferTimeoutMs(sftp, options));
      uploadStats = await uploadManifestLocalFilesToRemote({
        localPath,
        sftp,
        manifest,
        changedPaths: before.mismatches,
        uploadOptions: options,
      });
      const after = await inspectRemoteManagedFiles(sftp, manifest, transferTimeoutMs(sftp, options));
      if (after.mismatches.length) throw new Error(`远端代码内容校验失败：${after.mismatches.slice(0, 12).join("、")}`);
      uploadStats.verification = { method: "remote-sha256", checkedFiles: Object.keys(manifest).length, changedFiles: before.mismatches.length };
    } else {
      uploadStats = await uploadAllLocalToRemote({ localPath, sftp, writeState: options.stateFileMode !== "virtual", pathConfirmed: true, options });
    }
    const missingManagedFiles = manifest && options.pruneManagedFiles !== false && options.transientManifest !== true
      ? getMissingManagedFiles(previousManifest, manifest, sftp.ignore)
      : [];
    const prune = await pruneRemoteMissingManagedFiles(sftp, missingManagedFiles);
    if (options.transientManifest !== true) await writeRemoteCodeSyncState(sftp, state, options.manifest);
    if (options.stateFileMode !== "virtual") {
      writeLocalCodeSyncState(localPath, state);
    }
    const legacyLocalManagedDir = path.join(localPath, "zlk_cluster");
    const hasLegacyLocalManagedDir = fs.existsSync(legacyLocalManagedDir);
    if (hasLegacyLocalManagedDir) {
      void vscode.window.showWarningMessage(`检测到本地旧版托管目录 ${legacyLocalManagedDir}。新状态已写入 simple_cluster；请人工核对后手动删除。`);
    }
    if (legacyManagedDir && !options.apiMode) {
      void vscode.window.showWarningMessage(`检测到旧版托管目录 ${remoteRoot}/${legacyManagedDir}。新上传已改用 ${remoteRoot}/simple_cluster；请人工核对其中的自有文件后手动删除该目录。`);
    }
    return {
      ok: true,
      targetId: options.targetId || options.id || sftp.name || sftp.host,
      remotePath: sftp.remotePath,
      fingerprint: state.fingerprint,
      uploadedAt: state.updatedAt,
      deletedRemoteFiles: prune.deleted,
      stats: uploadStats,
      legacyManagedPath: legacyManagedDir ? `${remoteRoot}/${legacyManagedDir}` : "",
      cleanupRequired: Boolean(legacyManagedDir || hasLegacyLocalManagedDir),
    };
  } catch (error) {
    if (options.apiMode) throw error;
    const message = `上传工作区失败：${formatError(error)}`;
    vscode.window.showErrorMessage(message);
    return { ok: false, error: message };
  }
}

async function uploadManifestLocalFilesToRemote({ localPath, sftp, manifest, changedPaths, uploadOptions = {} }) {
  const uploadPlan = createManifestUploadPlan({ localPath, sftp, manifest, changedPaths });
  if (uploadPlan.fileCount > 0) {
    return await runUploadWithProgress(uploadOptions, `上传受管理代码文件 -> ${sftp.remotePath}`, (token) => runLocalTarUpload({
        localPath,
        sftp,
        uploadPlan,
        operation: "上传受管理代码文件",
        timeoutMs: transferTimeoutMs(sftp, uploadOptions),
        token,
        transferId: uploadOptions.transferId,
      }));
  }
  return {
    fileCount: 0,
    byteCount: 0,
    excludedRuleHits: 0,
    excludedNestedGitRepos: 0,
    nestedGitRoots: [],
    durationMs: 0,
    verification: { method: "manifest-empty" },
  };
}

async function uploadFiles(options = {}) {
  const localPath = resolveLocalWorkspacePath(options.localBase || options.localPath, "上传指定文件");
  const operationId = String(options.transferId || nextTransferId("upload-files"));
  activeUploadOperations.set(operationId, { id: operationId, stage: "acquiring-lease", startedAt: new Date().toISOString() });
  try {
    return await withHostOperationLease("upload-files", "上传指定文件", localPath, () => {
      setUploadOperationStage(operationId, "preparing-files");
      return uploadFilesCore({ ...options, transferId: operationId });
    });
  } finally {
    activeUploadOperations.delete(operationId);
  }
}

function setUploadOperationStage(operationId, stage) {
  const operation = activeUploadOperations.get(operationId);
  if (operation) operation.stage = stage;
}

async function uploadFilesCore(options = {}) {
  let tempDir = "";
  try {
    const localBase = resolveLocalWorkspacePath(options.localBase || options.localPath, "上传指定文件");
    if (!localBase) throw new Error("请先打开工作区，或传入 localBase。");
    const sftp = resolveUploadSftp(localBase, options);
    if (options.expectedTransferTarget) assertTransferTargetUnchanged(options.expectedTransferTarget, sftp);
    if (!sftp || !sftp.remotePath || !sftp.host) throw new Error("没有可用的 SFTP 上传目标。");
    const files = Array.isArray(options.files) ? options.files : [];
    if (!files.length && !options.manifest) throw new Error("没有要上传的文件。");
    setUploadOperationStage(options.transferId, "confirming-path");
    await confirmTransferPath({ localPath: localBase, sftp, operation: "上传指定文件", detail: filesSummary(options.files), options });
    setUploadOperationStage(options.transferId, "staging-files");
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-files-"));
    const relativePaths = [];
    const uploadPlanFiles = [];
    for (const item of files) {
      const rawLocalPath = typeof item === "string" ? item : String(item && (item.localPath || item.path) || "");
      const localPath = resolveUploadFilePath(rawLocalPath);
      if (!localPath || !fs.existsSync(localPath) || !fs.lstatSync(localPath).isFile()) {
        throw new Error(`本地文件不存在：${localPath || "-"}`);
      }
      const remoteName = sanitizeRelativeUploadPath(typeof item === "string" ? path.basename(localPath) : (item.remoteName || item.relativePath || path.basename(localPath)));
      const targetPath = path.join(tempDir, remoteName);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      relativePaths.push(toPosixPath(remoteName));
      uploadPlanFiles.push({ relativePath: toPosixPath(remoteName), fullPath: localPath, size: fs.statSync(localPath).size });
    }
    if (options.manifest) {
      const manifestPath = path.join(tempDir, "runtime_manifest.json");
      fs.writeFileSync(manifestPath, `${JSON.stringify(options.manifest, null, 2)}\n`, "utf8");
      relativePaths.push("runtime_manifest.json");
      uploadPlanFiles.push({ relativePath: "runtime_manifest.json", fullPath: manifestPath, size: fs.statSync(manifestPath).size });
    }
    setUploadOperationStage(options.transferId, "transferring");
    const stats = await runUploadWithProgress(options, `上传指定文件 -> ${sftp.remotePath}`, (token) => runLocalTarUpload({
        localPath: tempDir,
        sftp,
        uploadPlan: { files: uploadPlanFiles, fileCount: uploadPlanFiles.length, byteCount: uploadPlanFiles.reduce((total, file) => total + file.size, 0), excludedRuleHits: 0, excludedNestedGitRepos: 0, nestedGitRoots: [] },
        operation: "上传指定文件",
        timeoutMs: transferTimeoutMs(sftp, options),
        token,
        transferId: options.transferId,
      }));
    setUploadOperationStage(options.transferId, "transfer-complete");
    return {
      ok: true,
      targetId: options.targetId || options.id || sftp.name || sftp.host,
      remotePath: sftp.remotePath,
      files: relativePaths,
      stats: stats,
      uploadedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (options.apiMode) throw error;
    const message = `上传指定文件失败：${formatError(error)}`;
    vscode.window.showErrorMessage(message);
    return { ok: false, error: message };
  } finally {
    setUploadOperationStage(options.transferId, "cleaning-staging-files");
    if (tempDir) await removeLocalStagingDirectory(tempDir);
  }
}

function resolveUploadSftp(localPath, options) {
  const incomingServer = options && typeof options.server === "object" ? options.server : {};
  const sharedServer = sharedServerForOptions(options, incomingServer);
  const existing = readSftpConfig(localPath) || {};
  const server = { ...sharedServer, ...incomingServer };
  const host = firstNonEmpty(
    incomingServer.transferHost,
    incomingServer.resolvedHost,
    incomingServer.sftpHost,
    incomingServer.sshHost,
    incomingServer.host,
    incomingServer.sshConfigHost,
    incomingServer.sshConfigAlias,
    options.sftpHost,
    options.sshHost,
    options.host,
    options.sshConfigHost,
    options.sshConfigAlias,
    sharedServer.transferHost,
    sharedServer.resolvedHost,
    sharedServer.sftpHost,
    sharedServer.sshHost,
    sharedServer.host,
    existing.host
  );
  const user = String(server.user || server.username || options.user || options.username || existing.username || "").trim();
  const remotePath = requestedRemotePath(options) || String(sharedServer.remotePath || sharedServer.remoteBase || existing.remotePath || "").replace(/\/+$/, "");
  const port = normalizeSshPort(server.sshPort || server.port || options.sshPort || options.port || existing.port, 22);
  const ignore = mergeIgnorePatterns(DEFAULT_IGNORES, FIXED_IGNORES);
  return {
    ...existing,
    name: String(options.targetId || server.id || server.label || existing.name || host || "simple-sftp-target"),
    host,
    protocol: "sftp",
    port,
    username: user,
    remotePath,
    uploadOnSave: false,
    downloadOnOpen: false,
    useTempFile: false,
    openSsh: true,
    connectTimeoutSeconds: resolvedConnectTimeoutSeconds(server.connectTimeoutSeconds),
    ignore,
  };
}

function requestedRemotePath(options = {}) {
  const server = options.server && typeof options.server === "object" ? options.server : {};
  const top = String(options.remotePath || options.remoteBase || "").trim().replace(/\/+$/, "");
  const nested = String(server.remotePath || server.remoteBase || "").trim().replace(/\/+$/, "");
  if (top && nested && top !== nested) {
    throw new Error(`远端目标冲突：请求 ${top}，服务器对象 ${nested}。已阻止传输。`);
  }
  return top || nested;
}

function assertTransferTargetUnchanged(expected, actual) {
  const fields = ["host", "port", "username", "remotePath"];
  if (fields.some((field) => String(expected?.[field] || "") !== String(actual?.[field] || ""))) {
    throw new Error("上传目标在确认后发生变化，已阻止传输。");
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function sharedServerForOptions(options, server) {
  const candidates = sharedServerCandidateKeys(options, server);
  if (!candidates.length) return {};
  const data = readSharedServers();
  const found = data.servers.find((item) => {
    if (!item) return false;
    const keys = sharedServerCandidateKeys(item, item);
    return keys.some((key) => candidates.some((candidate) => candidate.toLowerCase() === key.toLowerCase()));
  });
  if (!found && typeof options?.server === "string" && options.server.trim()) {
    throw new Error(`未找到指定的 SFTP 服务器：${options.server.trim()}`);
  }
  return found || {};
}

function sharedServerCandidateKeys(options, server) {
  const raw = [
    options && options.targetId,
    options && options.id,
    options && typeof options.server === "string" ? options.server : "",
    server && server.targetId,
    server && server.id,
    server && server.label,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  const out = [];
  for (const key of raw) {
    out.push(key);
    out.push(key.replace(/-(agent-runtime|runtime|code-sync|workspace|files)$/i, ""));
  }
  return [...new Set(out.filter(Boolean))];
}

function createCodeSyncState(sftp, options) {
  return {
    version: 1,
    targetId: options.targetId || options.id || sftp.name || sftp.host,
    targetRole: options.targetRole || "",
    remotePath: sftp.remotePath,
    fingerprint: options.fingerprint || "",
    manifest: options.manifest || null,
    source: "local",
    transport: "simple-sftp",
    updatedAt: new Date().toISOString(),
  };
}

function writeLocalCodeSyncState(localPath, state) {
  const dir = path.join(localPath, "simple_cluster");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "code_sync_state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function atomicWriteJsonIfMissing(targetPath, value) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (fs.existsSync(targetPath)) return false;
  const temp = `${targetPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, targetPath);
  return true;
}

function migrateLegacyCodeSyncState(localPath) {
  const newPath = path.join(localPath, "simple_cluster", "code_sync_state.json");
  const legacyPath = path.join(localPath, "zlk_cluster", "code_sync_state.json");
  if (fs.existsSync(newPath) || !fs.existsSync(legacyPath)) return false;
  try {
    const legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
    if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
      return false;
    }
    return atomicWriteJsonIfMissing(newPath, {
      ...legacy,
      migration: {
        source: "zlk_cluster/code_sync_state.json",
        migratedAt: new Date().toISOString(),
        mode: "copy_read_only_source",
      },
    });
  } catch {
    return false;
  }
}

async function pruneRemoteMissingManagedFiles(sftp, missing) {
  if (!missing.length) return { deleted: 0 };
  let deleted = 0;
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const script = [
      "import json, os",
      `root=${JSON.stringify(String(sftp.remotePath).replace(/\/+$/, ""))}`,
      `paths=json.loads(${JSON.stringify(JSON.stringify(chunk))})`,
      "deleted=0",
      "for rel in paths:",
      "    rel=rel.replace('\\\\','/').lstrip('/')",
      "    if not rel or rel.startswith('../') or '/../' in rel or rel.startswith('simple_cluster/') or rel.startswith('zlk_cluster/'):",
      "        continue",
      "    target=os.path.abspath(os.path.join(root, rel))",
      "    base=os.path.abspath(root)",
      "    if not (target == base or target.startswith(base + os.sep)):",
      "        continue",
      "    parent=os.path.realpath(os.path.dirname(target))",
      "    if os.path.commonpath((os.path.realpath(base),parent))!=os.path.realpath(base): continue",
      "    if os.path.isfile(target) and not os.path.islink(target):",
      "        try: os.chdir(parent)",
      "        except OSError as error: raise RuntimeError('PARENT_CD_FAILED: '+str(error))",
      "        if os.path.realpath(os.getcwd())!=parent: raise RuntimeError('PARENT_CD_FAILED')",
      "        os.remove('./'+os.path.basename(target)); deleted += 1",
      "print(deleted)",
    ].join("\n");
    const stdout = await runSsh(sftp, `python3 - <<'PY'\n${script}\nPY`, 60000);
    deleted += Number(String(stdout).trim() || 0) || 0;
  }
  return { deleted };
}

function getManagedManifest(manifest) {
  return manifest && typeof manifest === "object" && !Array.isArray(manifest) ? manifest : null;
}

function getManifestUploadRelativePaths({ localPath, manifest }) {
  const managedManifest = getManagedManifest(manifest);
  if (!managedManifest) return [];
  const paths = [];
  let legacyManagedPathWarned = false;
  for (const key of Object.keys(managedManifest).sort((a, b) => a.localeCompare(b))) {
    const relativePath = sanitizeRelativeUploadPath(key);
    if (relativePath.replace(/\\/g, "/").toLowerCase().startsWith("zlk_cluster/")) {
      if (!legacyManagedPathWarned) {
        void vscode.window.showWarningMessage(`检测到旧版托管路径 ${relativePath}；新版本不会上传它。请人工核对后删除本地/远端旧版 zlk_cluster 目录。`);
        legacyManagedPathWarned = true;
      }
      continue;
    }
    if (!isSafeRemoteManagedPath(relativePath)) {
      throw new Error(`不安全的受管理代码路径：${relativePath}`);
    }
    const fullPath = path.join(localPath, relativePath);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      throw new Error(`manifest 文件缺失：${relativePath}`);
    }
    paths.push(relativePath);
  }
  return paths;
}

function getMissingManagedFiles(previous, manifest, ignorePatterns) {
  const managedManifest = getManagedManifest(manifest);
  const previousFiles = previous && typeof previous.files === "object" && previous.files && !Array.isArray(previous.files)
    ? Object.keys(previous.files)
    : [];
  if (!managedManifest || !previousFiles.length) return [];
  const nextFiles = new Set(Object.keys(managedManifest));
  return previousFiles
    .filter((relativePath) => !nextFiles.has(relativePath))
    .filter(isSafeRemoteManagedPath)
    .filter((relativePath) => !isIgnoredLocalPath(relativePath, ignorePatterns))
    .sort((a, b) => a.localeCompare(b));
}

async function readRemoteCodeManifest(sftp) {
  const remoteRoot = `${String(sftp.remotePath).replace(/\/+$/, "")}`;
  const managedDirs = [
    { dir: "simple_cluster", legacy: false },
    { dir: "zlk_cluster", legacy: true },
  ];
  for (const managedDir of managedDirs) {
    const manifestPath = `${remoteRoot}/${managedDir.dir}/code_sync_manifest.json`;
    const stdout = await runSsh(sftp, `if [ -f ${shellQuote(manifestPath)} ]; then cat ${shellQuote(manifestPath)}; fi`, 20000);
    const text = String(stdout || "").trim();
    if (text) {
      return {
        manifest: JSON.parse(text),
        legacyManagedDir: managedDir.legacy ? managedDir.dir : "",
      };
    }
  }
  return null;
}

function inspectRemoteManagedFiles(sftp, manifest, timeoutMs) {
  const files = getManagedManifest(manifest);
  if (!files) throw new Error("代码 manifest 格式无效。");
  for (const [relativePath, item] of Object.entries(files)) {
    if (!isSafeRemoteManagedPath(relativePath) || !/^[a-f0-9]{64}$/i.test(String(item?.sha256 || "")))
      throw new Error(`代码 manifest 路径或 SHA256 无效：${relativePath}`);
  }
  const script = [
    "import hashlib,json,os,sys",
    "root=os.path.realpath(sys.argv[1]); files=json.load(sys.stdin); bad=[]",
    "for rel,item in files.items():",
    " parts=rel.split('/')",
    " if not rel or any(p in ('','.','..') for p in parts): raise ValueError('unsafe path')",
    " target=os.path.join(root,*parts)",
    " if any(os.path.islink(os.path.join(root,*parts[:i])) for i in range(1,len(parts)+1)): raise ValueError('symlink path: '+rel)",
    " if os.path.commonpath((root,os.path.realpath(target)))!=root: raise ValueError('path outside project')",
    " if not os.path.isfile(target): bad.append(rel); continue",
    " h=hashlib.sha256()",
    " with open(target,'rb') as stream:",
    "  for chunk in iter(lambda:stream.read(1048576),b''): h.update(chunk)",
    " if h.hexdigest()!=str(item.get('sha256','')).lower(): bad.append(rel)",
    "print(json.dumps({'mismatches':bad}))",
  ].join("\n");
  const command = `python3 -c ${shellQuote(script)} ${shellQuote(String(sftp.remotePath).replace(/\/+$/, ""))}`;
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", getSshArgs(sftp, command), { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error("远端代码 SHA256 校验超时。")); }, Math.max(1000, Number(timeoutMs) || 120000));
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString("utf8")).slice(-20 * 1024 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-16384); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) return finish(new Error(`远端代码 SHA256 校验失败：${stderr.trim() || `SSH 退出码 ${code}`}`));
      try {
        const result = JSON.parse(stdout);
        if (!Array.isArray(result.mismatches) || result.mismatches.some((name) => !Object.hasOwn(files, name))) throw new Error("校验结果无效");
        finish(null, result);
      } catch (error) { finish(new Error(`远端代码 SHA256 校验响应无效：${formatError(error)}`)); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(files));
  });
}

async function writeRemoteCodeSyncState(sftp, state, manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-code-sync-state-"));
  try {
    const stateDir = path.join(tempDir, "simple_cluster");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "code_sync_state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(stateDir, "code_sync_manifest.json"), `${JSON.stringify({
      version: 1,
      files: manifest,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, "utf8");
    await runLocalTarUpload({
      localPath: tempDir,
      sftp,
      uploadPlan: {
        files: [
          { relativePath: "simple_cluster/code_sync_state.json", fullPath: path.join(stateDir, "code_sync_state.json"), size: fs.statSync(path.join(stateDir, "code_sync_state.json")).size },
          { relativePath: "simple_cluster/code_sync_manifest.json", fullPath: path.join(stateDir, "code_sync_manifest.json"), size: fs.statSync(path.join(stateDir, "code_sync_manifest.json")).size },
        ],
        fileCount: 2,
        excludedRuleHits: 0,
        excludedNestedGitRepos: 0,
        nestedGitRoots: [],
      },
      operation: "上传代码同步 manifest",
    });
  } finally {
    await removeLocalStagingDirectory(tempDir);
  }
}

function isSafeRemoteManagedPath(relativePath) {
  const normalized = toPosixPath(relativePath).replace(/^\/+/, "");
  if (!normalized || normalized.includes("..") || path.posix.isAbsolute(normalized)) return false;
  if (/[\\]|\0/.test(normalized)) return false;
  const segments = normalized.toLowerCase().split("/");
  const top = segments[0];
  // The manifest producer owns file-type and size policy. Reapplying a
  // directory/name allowlist here rejects files the user explicitly selected.
  // Keep only transport-level confinement and plugin-state protections.
  if ([".git", ".vscode", ".codex", "zlk_cluster"].includes(top)) return false;
  if (top === "simple_cluster") return true;
  return true;
}

function sanitizeRelativeUploadPath(value) {
  const normalized = toPosixPath(String(value || "").replace(/^\/+/, ""));
  if (!normalized || normalized.includes("..") || path.posix.isAbsolute(normalized)) {
    throw new Error(`非法远端相对路径：${value}`);
  }
  return normalized;
}

function targetScopeKey(options, sftp) {
  const server = options && typeof options.server === "object" ? options.server : {};
  return String(options.targetId || options.id || server.id || server.label || sftp.name || `${sftp.host}:${sftp.remotePath}`).trim();
}

function targetDownloadScopeStatePath(localPath) {
  return path.join(localPath, "simple_cluster", TARGET_DOWNLOAD_SCOPE_STATE);
}

function normalizeDownloadExtensions(values) {
  const extensions = [...new Set((Array.isArray(values) ? values : DEFAULT_DOWNLOAD_EXTENSIONS)
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .map((value) => value === "*" ? value : value.startsWith(".") ? value : `.${value}`))];
  if (!extensions.length) throw new Error("至少保留一种下载文件类型，或填写 *。");
  if (extensions.some((value) => value !== "*" && !/^\.[a-z0-9][a-z0-9._+-]*$/.test(value))) {
    throw new Error("文件类型格式无效；请使用 .py、.yaml 这类扩展名，或填写 *。");
  }
  return extensions.sort((a, b) => a.localeCompare(b));
}

function normalizeDownloadMaxFileSizeMB(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0.1 || size > 1048576) {
    throw new Error("单文件大小上限必须在 0.1–1048576 MB 之间。");
  }
  return Math.round(size * 100) / 100;
}

function normalizeDownloadScopePath(value) {
  const normalized = toPosixPath(String(value || "").trim()).replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized === ".") return ".";
  if (path.posix.isAbsolute(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`下载范围必须是远端项目内相对路径：${value}`);
  }
  if (downloadScopeBlockedPath(normalized)) {
    throw new Error(`下载范围包含插件或版本控制状态目录：${value}`);
  }
  return normalized;
}

function downloadScopeBlockedPath(relative) {
  const parts = String(relative || "").toLowerCase().split("/");
  if (parts.some((part) => [".git", ".vscode", ".codex", "zlk_cluster"].includes(part))) return true;
  if (parts[0] !== "simple_cluster") return false;
  if (parts.length === 1) return false;
  if (parts[1] === "results" || parts[1] === "debug_runs") return false;
  if (parts[1] === "tmp" && parts.length === 2) return false;
  if (parts[1] === "tmp" && parts[2] === "cluster_scheduler")
    return parts.length > 3 && parts[3] !== "logs" && !parts.at(-1).endsWith(".log");
  if (parts[1] === "tmp" && parts[2] === "tmux_logs") return false;
  return true;
}

function normalizeDownloadScope(value = {}) {
  return {
    paths: [...new Set((Array.isArray(value.paths) ? value.paths : []).map(normalizeDownloadScopePath))].sort((a, b) => a.localeCompare(b)),
    extensions: normalizeDownloadExtensions(value.extensions),
    maxFileSizeMB: value.noSizeLimit === true ? null : normalizeDownloadMaxFileSizeMB(value.maxFileSizeMB ?? DEFAULT_DOWNLOAD_MAX_FILE_SIZE_MB),
    ...(value.noSizeLimit === true ? { noSizeLimit: true } : {}),
  };
}

function explicitDownloadScope(options = {}) {
  if (!Array.isArray(options.paths) || !options.paths.length || options.paths.some((item) => item === "."))
    throw new Error("显式下载路径必须是一个或多个项目内文件或目录，禁止选择整个项目根目录。");
  return normalizeDownloadScope({ paths: options.paths, extensions: ["*"], noSizeLimit: true });
}

function assertSafeScopedLocalPaths(localPath, paths) {
  const root = path.resolve(localPath);
  try { if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`本机项目目录是符号链接：${root}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const relative of paths) {
    const full = path.resolve(root, ...relative.split("/"));
    const within = path.relative(root, full);
    if (!within || within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within))
      throw new Error(`本机下载路径超出项目根目录：${relative}`);
    let cursor = root;
    const parts = relative.split("/");
    for (const [index, part] of parts.entries()) {
      cursor = path.join(cursor, part);
      let stat;
      try { stat = fs.lstatSync(cursor); }
      catch (error) { if (error.code === "ENOENT") break; throw error; }
      if (stat.isSymbolicLink() || index < parts.length - 1 && !stat.isDirectory())
        throw new Error(`本机下载路径包含符号链接或非目录：${cursor}`);
    }
  }
}

function readTargetDownloadScope(localPath, options, sftp) {
  const file = targetDownloadScopeStatePath(localPath);
  if (!fs.existsSync(file)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    const item = state && typeof state === "object" ? state[targetScopeKey(options || {}, sftp || {})] : null;
    if (!item || !Array.isArray(item.paths) || !item.paths.length) return null;
    return normalizeDownloadScope(item);
  } catch {
    return null;
  }
}

function writeTargetDownloadScope(localPath, options, sftp, scope) {
  const file = targetDownloadScopeStatePath(localPath);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) state = {};
  } catch {
    state = {};
  }
  const normalized = normalizeDownloadScope(scope);
  const key = targetScopeKey(options || {}, sftp || {});
  state[key] = {
    targetId: key,
    host: sftp.host,
    username: sftp.username,
    port: sftp.port,
    remotePath: sftp.remotePath,
    ...normalized,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state[key];
}

function relativeRemoteScopePath(remoteRoot, selectedPath) {
  const base = path.posix.normalize(String(remoteRoot || "").replace(/\/+$/, ""));
  const selected = path.posix.normalize(String(selectedPath || "").replace(/\/+$/, ""));
  if (!base || !selected || (selected !== base && !selected.startsWith(`${base}/`))) {
    throw new Error(`所选远端路径超出项目根目录：${selectedPath}`);
  }
  return normalizeDownloadScopePath(selected === base ? "." : selected.slice(base.length + 1));
}

async function configureDownloadScope(options = {}) {
  const localPath = resolveLocalWorkspacePath(options.localPath, "设置下载文件范围");
  return withHostOperationLease("configure-download-scope", "设置下载文件范围", localPath, () => configureDownloadScopeCore({ ...options, localPath }));
}

async function configureDownloadScopeCore(options = {}) {
  try {
    const localPath = resolveLocalWorkspacePath(options.localPath, "设置下载文件范围");
    const hasTargetOptions = Boolean(options && (options.server || options.remotePath || options.host));
    const sftp = hasTargetOptions ? resolveUploadSftp(localPath, options) : readSftpConfig(localPath);
    if (!sftp || !sftp.remotePath || !sftp.host) throw new Error("未提供可用的 SFTP 目标。");
    await confirmTransferPath({ localPath, sftp, operation: "设置下载文件范围", detail: "浏览远端项目目录并保存允许下载的范围", options });

    const current = readTargetDownloadScope(localPath, options, sftp) || normalizeDownloadScope({ paths: [] });
    if (options.apiMode) {
      const saved = writeTargetDownloadScope(localPath, options, sftp, {
        paths: Array.isArray(options.paths) ? options.paths : current.paths,
        extensions: Array.isArray(options.extensions) ? options.extensions : current.extensions,
        maxFileSizeMB: options.maxFileSizeMB ?? current.maxFileSizeMB,
      });
      return { ok: true, targetId: targetScopeKey(options, sftp), remotePath: sftp.remotePath, scope: saved };
    }

    const action = await vscode.window.showQuickPick([
      { label: "$(folder-opened) 添加远端文件夹", description: "浏览远端项目；选中后立即保存", id: "folder" },
      { label: "$(file-add) 添加远端文件", description: "先进入所在目录，再多选文件", id: "file" },
      { label: "$(symbol-file) 设置允许的文件类型", description: current.extensions.join("、"), id: "extensions" },
      { label: "$(file-binary) 设置单文件大小上限", description: `${current.maxFileSizeMB} MB`, id: "max-size" },
      { label: "$(list-selection) 查看已选远端路径", description: `${current.paths.length} 条`, id: "preview" },
      { label: "$(trash) 移除已选远端路径", description: current.paths.join("、") || "暂无", id: "remove" },
    ], { title: "设置下载文件范围", placeHolder: "只下载明确选择的远端文件或文件夹", ignoreFocusOut: true });
    if (!action) return { ok: false, cancelled: true };

    let next = { ...current, paths: [...current.paths] };
    if (action.id === "extensions") {
      const value = await vscode.window.showInputBox({
        title: "允许下载的文件类型",
        prompt: "用英文逗号分隔，例如 .py,.yaml,.json；填写 * 表示任意类型。",
        value: current.extensions.join(","),
        ignoreFocusOut: true,
        validateInput: (input) => { try { normalizeDownloadExtensions(input.split(",")); return undefined; } catch (error) { return formatError(error); } },
      });
      if (value === undefined) return { ok: false, cancelled: true };
      next.extensions = normalizeDownloadExtensions(value.split(","));
    } else if (action.id === "max-size") {
      const value = await vscode.window.showInputBox({
        title: "下载单文件大小上限",
        prompt: "单位 MB，允许 0.1–1048576。",
        value: String(current.maxFileSizeMB),
        ignoreFocusOut: true,
        validateInput: (input) => { try { normalizeDownloadMaxFileSizeMB(Number(input)); return undefined; } catch (error) { return formatError(error); } },
      });
      if (value === undefined) return { ok: false, cancelled: true };
      next.maxFileSizeMB = normalizeDownloadMaxFileSizeMB(Number(value));
    } else if (action.id === "preview") {
      if (!current.paths.length) {
        void vscode.window.showInformationMessage("尚未设置下载文件范围；远端到本地同步会沿用原有整项目规则。");
        return { ok: true, scope: current };
      }
      await vscode.window.showQuickPick(current.paths.map((relative) => ({ label: relative, description: `${sftp.remotePath.replace(/\/+$/, "")}/${relative === "." ? "" : relative}` })), { title: "已选远端下载路径", placeHolder: "只读预览", ignoreFocusOut: true });
      return { ok: true, scope: current };
    } else if (action.id === "remove") {
      if (!current.paths.length) return { ok: true, scope: current };
      const picked = await vscode.window.showQuickPick(current.paths.map((relative) => ({ label: relative, picked: true })), { title: "移除远端下载路径", canPickMany: true, ignoreFocusOut: true });
      if (!picked?.length) return { ok: false, cancelled: true };
      const removed = new Set(picked.map((item) => item.label));
      next.paths = current.paths.filter((relative) => !removed.has(relative));
    } else if (action.id === "folder") {
      const selected = await pickRemoteDirectory({ remoteBase: sftp.remotePath, sftp, title: "选择允许下载的远端文件夹", showHiddenTopLevel: true });
      if (!selected) return { ok: false, cancelled: true };
      next.paths = [...new Set([...current.paths, relativeRemoteScopePath(sftp.remotePath, selected)])].sort((a, b) => a.localeCompare(b));
    } else if (action.id === "file") {
      const selectedDir = await pickRemoteDirectory({ remoteBase: sftp.remotePath, sftp, title: "进入远端文件所在目录", showHiddenTopLevel: true });
      if (!selectedDir) return { ok: false, cancelled: true };
      const files = await listRemoteFiles(sftp, selectedDir);
      const picked = await vscode.window.showQuickPick(files.map((file) => ({ label: file.name, description: formatBytes(file.sizeBytes), file })), { title: `选择远端文件：${selectedDir}`, canPickMany: true, ignoreFocusOut: true });
      if (!picked?.length) return { ok: false, cancelled: true };
      const selectedPaths = picked.map((item) => relativeRemoteScopePath(sftp.remotePath, `${selectedDir}/${item.file.name}`));
      next.paths = [...new Set([...current.paths, ...selectedPaths])].sort((a, b) => a.localeCompare(b));
    }

    const saved = writeTargetDownloadScope(localPath, options, sftp, next);
    void vscode.window.showInformationMessage(`下载范围已保存：${saved.paths.length} 条路径，${saved.extensions.join("、")}，单文件不超过 ${saved.maxFileSizeMB} MB。`);
    return { ok: true, targetId: targetScopeKey(options, sftp), remotePath: sftp.remotePath, scope: saved };
  } catch (error) {
    if (options.apiMode) throw error;
    const message = `设置下载文件范围失败：${formatError(error)}`;
    vscode.window.showErrorMessage(message);
    return { ok: false, error: message };
  }
}

function mergeIgnorePatterns(...groups) {
  const out = new Set();
  for (const group of groups) {
    for (const item of Array.isArray(group) ? group : []) {
      const value = String(item || "").trim();
      if (value) out.add(value);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

async function pickRemoteDirectory({ remoteBase, sftp, title = "选择远端项目根目录", showHiddenTopLevel = false }) {
  let current = remoteBase.replace(/\/+$/, "");
  for (;;) {
    const dirs = await listRemoteDirs(sftp, current);
    const items = [
      {
        label: "$(check) 使用当前目录",
        description: current,
        kind: "use",
      },
      {
        label: "$(edit) 手动输入路径",
        description: "粘贴远端项目根目录",
        kind: "manual",
      },
    ];

    if (current !== remoteBase.replace(/\/+$/, "")) {
      items.push({
        label: "$(arrow-up) 返回上一级",
        description: path.posix.dirname(current),
        kind: "up",
      });
    }

    for (const dir of dirs) {
      if (!showHiddenTopLevel && current === remoteBase.replace(/\/+$/, "") && HIDDEN_TOP_LEVEL.has(dir)) {
        continue;
      }
      items.push({
        label: `$(folder) ${dir}`,
        description: `${current}/${dir}`,
        kind: "dir",
        name: dir,
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: current,
      matchOnDescription: true,
    });
    if (!picked) return null;
    if (picked.kind === "use") return current;
    if (picked.kind === "up") {
      current = path.posix.dirname(current);
      continue;
    }
    if (picked.kind === "manual") {
      const manual = await vscode.window.showInputBox({
        title: "远端项目根目录",
        prompt: "输入远端项目根目录路径。",
        value: current,
      });
      return manual ? manual.trim().replace(/\/+$/, "") : null;
    }
    if (picked.kind === "dir") {
      current = `${current}/${picked.name}`;
    }
  }
}

function listRemoteFiles(sftp, remotePath) {
  const command = `find ${shellQuote(remotePath)} -mindepth 1 -maxdepth 1 -type f -printf '%f\\t%s\\n' 2>/dev/null | sort`;
  return new Promise((resolve, reject) => {
    execFile("ssh", getSshArgs(sftp, command), { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`列出远端文件失败：${stderr || error.message}`));
        return;
      }
      resolve(stdout.split(/\r?\n/).map((line) => {
        const [name, sizeText] = line.split("\t");
        return { name: String(name || "").trim(), sizeBytes: Number(sizeText) || 0 };
      }).filter((item) => item.name));
    });
  });
}

function listRemoteDirs(sftp, remotePath) {
  const args = createListRemoteDirsSshArgs(sftp, remotePath);
  return new Promise((resolve, reject) => {
    execFile("ssh", args, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`列出远端目录失败：${stderr || error.message}`));
        return;
      }
      resolve(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    });
  });
}

function createListRemoteDirsSshArgs(sftp, remotePath) {
  const command = `find ${shellQuote(remotePath)} -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' 2>/dev/null | sort`;
  return getSshArgs(sftp, command);
}

async function writeWorkspace({
  execHost,
  localPath,
  projectName,
  remotePath,
  sftp: remoteSftp,
  serverLabel,
  userName,
  writeAgentsFile,
}) {
  const vscodeDir = path.join(localPath, ".vscode");
  fs.mkdirSync(vscodeDir, { recursive: true });

  const workspaceSftp = {
    name: createWorkspaceTargetName(serverLabel || remoteSftp.name || remoteSftp.host, projectName),
    host: remoteSftp.host,
    protocol: "sftp",
    port: normalizeSshPort(remoteSftp.port, 22),
    username: remoteSftp.username || userName || "",
    remotePath,
    uploadOnSave: false,
    downloadOnOpen: false,
    useTempFile: false,
    openSsh: true,
    ignore: DEFAULT_IGNORES,
  };

  fs.writeFileSync(
    path.join(vscodeDir, "sftp.json"),
    `${JSON.stringify(workspaceSftp, null, 2)}\n`,
    "utf8"
  );

  if (writeAgentsFile !== false) {
    upsertAgentsFile({ execHost, localPath, remotePath, userName: workspaceSftp.username, port: workspaceSftp.port });
    addGitInfoExclude(localPath, "AGENTS.md");
  }
}

function createWorkspaceTargetName(serverLabel, projectName) {
  const base = String(serverLabel || "simple-sftp-target").trim() || "simple-sftp-target";
  const project = String(projectName || "project").trim() || "project";
  return `${base}-${project}`.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function getPrimaryWorkspaceFolder() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0] : null;
}

function workspaceMappingConfig() {
  const cfg = vscode.workspace.getConfiguration("simpleSftp");
  return {
    hostRoot: cfg.get("workspaceHostRoot") || "",
    containerRoot: cfg.get("workspaceContainerRoot") || "",
    remoteScheme: "vscode-remote",
  };
}

function workspaceLocationForFolder(folder) {
  if (!folder || !folder.uri) return null;
  const uri = folder.uri;
  const location = resolveWorkspaceLocation({
    scheme: uri.scheme,
    path: uri.path,
    fsPath: uri.fsPath,
    external: typeof uri.toString === "function" ? uri.toString(true) : "",
  }, workspaceMappingConfig());
  if (location.remote && process.platform !== "win32") {
    throw new Error("远程工作区必须由 Windows UI Extension Host 执行。请确认 SimpleSFTP 未运行于 Linux workspace host。");
  }
  return location;
}

function getWorkspaceRoot(folder = getPrimaryWorkspaceFolder()) {
  const location = workspaceLocationForFolder(folder);
  return location ? location.hostPath : "";
}

async function withHostOperationLease(actionType, actionLabel, localPath, operation) {
  if (process.platform !== "win32") {
    throw new Error("SimpleSFTP 文件副作用必须由 Windows UI Extension Host 执行。");
  }
  const folders = Array.isArray(vscode.workspace.workspaceFolders) ? vscode.workspace.workspaceFolders : [];
  if (folders.length > 1) {
    throw new Error("检测到多个工作区文件夹，已阻止 SimpleSFTP 宿主副作用操作。请在独立窗口中只打开一个目标项目。");
  }
  const folder = folders[0];
  const location = folder ? workspaceLocationForFolder(folder) : null;
  const hostProjectPath = String(location && location.hostPath || localPath || "(未打开工作区)");
  const workspaceUri = String(location && location.editorUri || folder && folder.uri && folder.uri.toString?.(true) || "untitled://simple-sftp/no-workspace");
  try {
    return await hostOperationLease.run({
      pluginId: "simple-local.simple-sftp",
      workspaceUri,
      hostProjectPath,
      actionType,
      actionLabel,
    }, operation);
  } catch (error) {
    if (error instanceof HostOperationLeaseConflictError) {
      await vscode.window.showErrorMessage(error.message, { modal: true }, "知道了");
    }
    throw error;
  }
}

function workspaceHostPathForUri(uri) {
  if (!uri) throw new Error("缺少工作区文件 URI。");
  const location = resolveWorkspaceLocation({
    scheme: uri.scheme,
    path: uri.path,
    fsPath: uri.fsPath,
    external: typeof uri.toString === "function" ? uri.toString(true) : "",
  }, workspaceMappingConfig());
  if (location.remote && process.platform !== "win32") {
    throw new Error("远程工作区文件必须由 Windows UI Extension Host 处理。");
  }
  return location.hostPath;
}

function resolveLocalWorkspacePath(value, operation) {
  const input = String(value || "").trim();
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) return input;
  const location = workspaceLocationForFolder(folder);
  if (!input) return location.hostPath;
  if (!location.remote) return input;

  let resolved = input;
  if (input.startsWith("/") && !input.startsWith("//")) {
    resolved = resolveWorkspaceLocation({
      scheme: "vscode-remote",
      path: input,
      fsPath: input,
      external: input,
    }, workspaceMappingConfig()).hostPath;
  } else {
    resolved = path.win32.normalize(input);
  }
  const relative = path.win32.relative(location.hostPath, resolved);
  if (relative === ".." || relative.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(relative)) {
    throw new Error(`${operation || "当前操作"}的本地路径不在当前宿主工作区内：${input}`);
  }
  return resolved;
}

function resolveUploadFilePath(value) {
  const input = String(value || "").trim();
  const folder = getPrimaryWorkspaceFolder();
  if (!input || !folder) return input;
  const location = workspaceLocationForFolder(folder);
  if (!location.remote || !input.startsWith("/") || input.startsWith("//")) return input;
  return resolveWorkspaceLocation({
    scheme: "vscode-remote",
    path: input,
    fsPath: input,
    external: input,
  }, workspaceMappingConfig()).hostPath;
}

function workspaceEditorUriForRelative(relativePath) {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) throw new Error("请先打开工作区。");
  const normalized = path.posix.normalize(String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, ""));
  if (!normalized || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`只能打开当前工作区内文件：${relativePath}`);
  }
  const location = workspaceLocationForFolder(folder);
  if (location.remote) return vscode.Uri.joinPath(folder.uri, ...normalized.split("/"));
  return vscode.Uri.file(path.join(location.hostPath, ...normalized.split("/")));
}

async function openWorkspaceRelativeFile(relativePath) {
  const document = await vscode.workspace.openTextDocument(workspaceEditorUriForRelative(relativePath));
  await vscode.window.showTextDocument(document, { preview: false });
}

function transferPathConfirmationKey(localPath, sftp) {
  const local = path.win32.normalize(String(localPath || "")).toLowerCase();
  const remote = String(sftp && sftp.remotePath || "").replace(/\/+$/, "");
  const host = String(sftp && sftp.host || "").trim().toLowerCase();
  const port = normalizeSshPort(sftp && sftp.port, 22);
  return `${local}|${host}:${port}|${remote}`;
}

function refreshConnectTimeoutFromConfig() {
  const value = Number(vscode.workspace.getConfiguration("simpleSftp").get("connectTimeoutSeconds", 15));
  defaultConnectTimeoutSeconds = Number.isFinite(value) && value >= 0
    ? Math.min(Math.max(0, Math.floor(value)), 3600)
    : 15;
}

function resolvedConnectTimeoutSeconds(value) {
  const own = Number(value);
  if (!Number.isFinite(own) || own < 0) return defaultConnectTimeoutSeconds;
  return Math.min(Math.max(0, Math.floor(own)), 3600);
}

function nextTransferId(operation) {
  transferSequence += 1;
  return `transfer-${Date.now()}-${transferSequence}-${String(operation || "").replace(/[^\w.-]+/g, "-")}`;
}

function createTransferController({ id, operation, localPath, remotePath, host }) {
  const listeners = new Set();
  let cancelled = false;
  let cancelReason = "";
  let disposed = false;
  const controller = {
    id,
    operation,
    localPath,
    remotePath,
    host,
    startedAt: new Date().toISOString(),
    status: "running",
    onCancel(listener) {
      if (disposed) return;
      if (cancelled) {
        queueMicrotask(() => listener(cancelReason));
        return;
      }
      listeners.add(listener);
    },
    cancel(reason) {
      if (disposed || cancelled) return false;
      cancelled = true;
      cancelReason = String(reason || "传输已取消");
      controller.status = "cancelled";
      for (const listener of [...listeners]) {
        try { listener(cancelReason); } catch {}
      }
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      activeTransfers.delete(controller.id);
    },
  };
  activeTransfers.set(controller.id, controller);
  return controller;
}

function listActiveTransfers() {
  return [...activeTransfers.values()].map(({ id, operation, localPath, remotePath, host, startedAt, status }) => ({
    id,
    operation,
    localPath,
    remotePath,
    host,
    startedAt,
    status,
  }));
}

function transferTimeoutMs(sftp, options = {}) {
  const explicit = Number(options && options.timeoutMs);
  if (Number.isFinite(explicit) && explicit >= 1000) return Math.round(explicit);
  const seconds = Number(vscode.workspace.getConfiguration("simpleSftp").get("uploadTimeoutSeconds", 600));
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.max(1000, Math.round(seconds * 1000));
}

function uploadProgressCancellable(options = {}) {
  if (options && typeof options.cancellable === "boolean") return options.cancellable;
  return vscode.workspace.getConfiguration("simpleSftp").get("uploadCancellable", true) !== false;
}

function runUploadWithProgress(options, title, operation) {
  // JSON-RPC callers can track and cancel transfers through transfers.list/cancel.
  // Do not couple their response to the VS Code notification lifecycle.
  if (options && options.apiMode === true) return operation(undefined);
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title,
    cancellable: uploadProgressCancellable(options),
  }, (_progress, token) => operation(token));
}

async function confirmTransferPath({ localPath, sftp, operation, detail, options = {} }) {
  const key = transferPathConfirmationKey(localPath, sftp);
  const remembered = extensionContext && extensionContext.globalState
    ? extensionContext.globalState.get(PATH_CONFIRMATIONS_STATE, [])
    : [];
  if (Array.isArray(remembered) && remembered.includes(key)) return true;
  const preview = createTransferPreview({ localPath, sftp, operation, detail });

  if (options && options.apiMode) {
    const requires = [];
    if (options.confirm !== true) requires.push("confirm");
    if (options.pathConfirmed !== true) requires.push("pathConfirmed");
    if (requires.length) throw confirmationRequired({ ...preview, requires });
    return true;
  }

  const currentLocation = (() => {
    try { return workspaceLocationForFolder(getPrimaryWorkspaceFolder()); } catch { return null; }
  })();
  const currentUriMatches = currentLocation && currentLocation.remote && (() => {
    const relative = path.win32.relative(currentLocation.hostPath, path.win32.normalize(String(localPath || "")));
    return relative === "" || (!relative.startsWith(`..${path.win32.sep}`) && relative !== ".." && !path.win32.isAbsolute(relative));
  })();
  const answer = await vscode.window.showWarningMessage(
    [
      "【SimpleSFTP 文件位置确认】",
      "",
      `操作：${preview.operation}`,
      `本地宿主位置：${preview.localPath}`,
      `远端预期位置：${preview.remotePath}`,
      `服务器：${preview.username}${preview.username ? "@" : ""}${preview.host}:${preview.port}`,
      currentUriMatches ? `远程工作区 URI：${currentLocation.editorUri}` : "",
      preview.detail ? `文件范围：${preview.detail}` : "",
      "",
      "请确认本地宿主位置和远端预期位置均正确后再继续。",
    ].filter(Boolean).join("\n"), { modal: true }, "仅本次继续", "此后该路径不再提醒", "取消");
  if (answer === "此后该路径不再提醒") {
    if (extensionContext && extensionContext.globalState) {
      const next = [...new Set([...(Array.isArray(remembered) ? remembered : []), key])].slice(-100);
      await extensionContext.globalState.update(PATH_CONFIRMATIONS_STATE, next);
    }
    return true;
  }
  if (answer === "仅本次继续") return true;
  throw new Error("用户取消了 SimpleSFTP 文件位置确认。");
}

function createTransferPreview({ localPath, sftp, operation, detail }) {
  return {
    operation: operation || "文件传输",
    detail: detail || "",
    localPath: String(localPath || ""),
    remotePath: String(sftp && sftp.remotePath || ""),
    host: String(sftp && sftp.host || ""),
    port: normalizeSshPort(sftp && sftp.port, 22),
    username: String(sftp && sftp.username || ""),
  };
}

function createLocalApiMethods() {
  return {
    status: async () => {
      const active = getActiveSharedServer();
      return {
        ok: true,
        plugin: "SimpleSFTP",
        version: String(PACKAGE_JSON.version || "0.2.0"),
        activeServer: active ? publicServerRecord(active) : null,
        api: localApiServer
          ? { port: localApiServer.port, pid: localApiServer.startedAt ? process.pid : 0, startedAt: localApiServer.startedAt }
          : null,
      };
    },
    "config.list": async () => {
      const config = vscode.workspace.getConfiguration(API_CONFIG_NAMESPACE);
      const schema = simpleSftpConfigSchema();
      return {
        namespace: API_CONFIG_NAMESPACE,
        keys: Object.entries(schema)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => ({
            key,
            type: item.type || "",
            scope: item.scope || "",
            default: item.default,
            value: simpleSftpConfigValue(config, key),
          })),
      };
    },
    "config.get": async (params = {}) => {
      const key = String(params.key || "").trim();
      const schema = simpleSftpConfigSchema()[key];
      if (!schema)
        throw new Error(`未知 SimpleSFTP 配置：${key}`);
      const config = vscode.workspace.getConfiguration(API_CONFIG_NAMESPACE);
      return {
        key,
        type: schema.type || "",
        scope: schema.scope || "",
        default: schema.default,
        value: simpleSftpConfigValue(config, key),
      };
    },
    "config.set": async (params = {}) => {
      const key = String(params.key || "").trim();
      if (!SIMPLE_SFTP_CONFIG_KEYS.has(key))
        throw new Error(`未知 SimpleSFTP 配置：${key}`);
      requireApiConfirmation(params, {
        method: "config.set",
        operation: `修改 SimpleSFTP 配置 ${key}`,
        sftp: null,
        localPath: "",
        pathRequired: false,
      });
      validateSimpleSftpConfigValue(key, params.value);
      const config = vscode.workspace.getConfiguration(API_CONFIG_NAMESPACE);
      await config.update(simpleSftpConfigSuffix(key), params.value, vscode.ConfigurationTarget.Global);
      publishLocalApiEvent("config.set", { key, value: simpleSftpConfigValue(config, key) });
      return { ok: true, key, value: simpleSftpConfigValue(config, key) };
    },
    "config.reset": async (params = {}) => {
      const key = String(params.key || "").trim();
      if (!SIMPLE_SFTP_CONFIG_KEYS.has(key))
        throw new Error(`未知 SimpleSFTP 配置：${key}`);
      requireApiConfirmation(params, {
        method: "config.reset",
        operation: `重置 SimpleSFTP 配置 ${key}`,
        sftp: null,
        localPath: "",
        pathRequired: false,
      });
      const config = vscode.workspace.getConfiguration(API_CONFIG_NAMESPACE);
      await config.update(simpleSftpConfigSuffix(key), undefined, vscode.ConfigurationTarget.Global);
      publishLocalApiEvent("config.reset", { key });
      return { ok: true, key, reset: true };
    },
    "servers.list": async () => {
      const data = readSharedServers();
      return {
        ok: true,
        activeServerId: data.activeServerId,
        servers: data.servers.map(publicServerRecord),
      };
    },
    "servers.save": async (params = {}) => {
      const incoming = params.server && typeof params.server === "object" && !Array.isArray(params.server)
        ? params.server
        : params;
      const data = readSharedServers();
      const incomingId = String(incoming.id || "").trim();
      const existing = data.servers.find((item) =>
        incomingId ? item.id === incomingId : Boolean(incoming.label && item.label === incoming.label)
      );
      const server = sanitizeServerProfile(
        incomingId || !existing ? incoming : { ...incoming, id: existing.id },
        existing || {}
      );
      requireApiConfirmation(params, {
        method: "servers.save",
        operation: existing ? "更新 SimpleSFTP 服务器配置" : "新增 SimpleSFTP 服务器配置",
        sftp: server,
        localPath: "",
        pathRequired: false,
      });
      const servers = existing
        ? data.servers.map((item) => item.id === server.id ? server : item)
        : [...data.servers, server];
      const activeServerId = params.setActive === true || (data.activeServerId === server.id) || (!data.activeServerId && !existing)
        ? server.id
        : data.activeServerId;
      writeSharedServers({ ...data, servers, activeServerId });
      updateServerStatusButton();
      publishLocalApiEvent("servers.save", { id: server.id, activeServerId });
      return { ok: true, server: publicServerRecord(server), activeServerId };
    },
    "servers.delete": async (params = {}) => {
      const id = String(params.id || params.serverId || "").trim();
      const data = readSharedServers();
      const server = data.servers.find((item) => item.id === id);
      if (!server)
        throw new Error("未找到指定服务器：" + (id || "-"));
      requireApiConfirmation(params, {
        method: "servers.delete",
        operation: "删除 SimpleSFTP 服务器配置",
        sftp: server,
        localPath: "",
        pathRequired: false,
      });
      const servers = data.servers.filter((item) => item.id !== id);
      const activeServerId = data.activeServerId === id ? (servers[0]?.id || "") : data.activeServerId;
      writeSharedServers({ ...data, servers, activeServerId });
      updateServerStatusButton();
      publishLocalApiEvent("servers.delete", { id, activeServerId });
      return { ok: true, deletedId: id, activeServerId };
    },
    "servers.setActive": async (params = {}) => {
      const id = String(params.id || params.serverId || "").trim();
      const data = readSharedServers();
      const server = data.servers.find((item) => item && item.id === id);
      if (!server) throw new Error("未找到指定服务器：" + (id || "-"));
      requireApiConfirmation(params, {
        method: "servers.setActive",
        operation: "切换 SimpleSFTP 活动服务器",
        sftp: server,
        localPath: "",
        pathRequired: false,
      });
      writeSharedServers({ ...data, activeServerId: id });
      updateServerStatusButton();
      publishLocalApiEvent("servers.setActive", { activeServerId: id });
      return { ok: true, activeServerId: id, server: publicServerRecord(server) };
    },
    "servers.importSshConfig": async (params = {}) => {
      requireApiConfirmation(params, {
        method: "servers.importSshConfig",
        operation: "导入并行 SSH 配置",
        sftp: null,
        localPath: "",
        pathRequired: false,
      });
      const result = importSharedSshConfigCore();
      updateServerStatusButton();
      publishLocalApiEvent("servers.importSshConfig", result);
      return result;
    },
    "remote.listDirs": async (params = {}) => {
      const remotePath = String(params.remotePath || "").trim();
      if (!remotePath) throw new Error("缺少远端目录 remotePath。");
      const sftp = apiTransferSftp(params);
      sftp.remotePath = remotePath;
      requireApiConfirmation(params, {
        method: "remote.listDirs",
        operation: "列出远端目录",
        sftp,
        localPath: String(params.localPath || ""),
        pathRequired: true,
      });
      const dirs = await listRemoteDirs(sftp, remotePath);
      publishLocalApiEvent("remote.listDirs", { remotePath, count: dirs.length });
      return { ok: true, remotePath, dirs };
    },
    "target.show": async (params = {}) => {
      return showCurrentTarget({ ...params, apiMode: true });
    },
    "target.update": async (params = {}) => {
      const localPath = String(params.localPath || getWorkspaceRoot() || "").trim();
      if (!localPath)
        throw new Error("target.update 缺少本地工作区 localPath。");
      const patch = params.patch && typeof params.patch === "object" && !Array.isArray(params.patch)
        ? params.patch
        : {};
      const sftp = apiTransferSftp({ ...params, localPath });
      const preview = {
        ...sftp,
        host: String(patch.host || sftp.host || "").trim(),
        port: normalizeSshPort(patch.port ?? patch.sshPort ?? sftp.port, 22),
        username: String(patch.username ?? patch.user ?? sftp.username ?? "").trim(),
        remotePath: String(patch.remotePath || sftp.remotePath || "").trim().replace(/\/+$/, ""),
      };
      requireApiConfirmation(params, {
        method: "target.update",
        operation: "更新 SFTP 工作区目标",
        sftp: preview,
        localPath,
        pathRequired: true,
      });
      const result = await updateWorkspaceTarget({ ...params, apiMode: true, localPath });
      publishLocalApiEvent("target.update", {
        localPath,
        remotePath: result.remotePath,
        updatedAt: new Date().toISOString(),
      });
      return result;
    },
    "project.create": async (params = {}) => {
      const remotePath = String(params.remotePath || "").trim();
      if (!remotePath) throw new Error("缺少远端项目目录 remotePath。");
      const sftp = apiTransferSftp(params);
      sftp.remotePath = remotePath;
      requireApiConfirmation(params, {
        method: "project.create",
        operation: "创建 SFTP 工作区",
        sftp,
        localPath: String(params.localPath || ""),
        pathRequired: true,
      });
      const result = await createOrOpenProject({ ...params, apiMode: true });
      publishLocalApiEvent("project.create", {
        localPath: result && result.localPath,
        remotePath: result && result.remotePath,
      });
      return result;
    },
    "sync.fromRemote": async (params = {}) => {
      const localPath = String(params.localPath || "").trim();
      if (!localPath) throw new Error("缺少本地工作区 localPath。");
      const sftp = apiTransferSftp({ ...params, localPath });
      requireApiConfirmation(params, {
        method: "sync.fromRemote",
        operation: "远端同步到本地",
        sftp: { ...sftp, remotePath: sftp.remotePath || params.remotePath || "" },
        localPath,
        pathRequired: true,
      });
      const result = await syncFromRemote({ ...params, apiMode: true, localPath });
      publishLocalApiEvent("sync.fromRemote", {
        localPath,
        remotePath: result && result.remotePath,
      });
      return result;
    },
    "sync.downloadPaths": async (params = {}) => {
      const localPath = String(params.localPath || "").trim();
      if (!localPath) throw new Error("缺少本地项目目录 localPath。");
      if (!params.server || typeof params.server !== "object") throw new Error("必须明确指定来源 Worker。");
      const scope = explicitDownloadScope(params);
      const sftp = apiTransferSftp({ ...params, localPath });
      requireApiConfirmation(params, {
        method: "sync.downloadPaths",
        operation: `仅下载 ${scope.paths.length} 条指定路径到本机`,
        sftp,
        localPath,
        pathRequired: true,
      });
      const result = await syncFromRemote({ ...params, apiMode: true, localPath, paths: scope.paths });
      publishLocalApiEvent("sync.downloadPaths", { localPath, remotePath: result.remotePath, paths: scope.paths });
      return result;
    },
    "sync.planLogPaths": async (params = {}) => listPlanLogPaths(params),
    "sync.projectInventory": async (params = {}) => projectInventory(params),
    "sync.projectTree": async (params = {}) => projectTree(params),
    "sync.deletePath": async (params = {}) => deleteProjectPath(params),
    "sync.serverToServerBatch": async (params = {}) => syncServerToServerBatch(params),
    "sync.serverToServerFpsync": async (params = {}) => syncServerToServerFpsync(params),
    "sync.serverToServer": async (params = {}) => {
      const result = await syncServerToServer(params);
      publishLocalApiEvent("sync.serverToServer", {
        sourceId: params.source && params.source.id,
        destinationId: params.destination && params.destination.id,
        relativePath: result.relativePath,
      });
      return result;
    },
    "transfers.list": async () => {
      return { ok: true, transfers: listActiveTransfers(), operations: [...activeUploadOperations.values()] };
    },
    "transfers.cancel": async (params = {}) => {
      const id = String(params.transferId || params.id || "").trim();
      if (!id) throw new Error("缺少传输 transferId。");
      const transfer = activeTransfers.get(id);
      if (!transfer) throw new Error("未找到活动传输：" + (id || "-"));
      transfer.cancel(String(params.reason || "用户通过 API 取消"));
      return { ok: true, transferId: id, cancelled: true };
    },
    "upload.workspace": async (params = {}) => {
      const localPath = String(params.localPath || "").trim();
      const sftp = resolveUploadSftp(localPath, params);
      requireApiConfirmation(params, {
        method: "upload.workspace",
        operation: "上传工作区",
        sftp,
        localPath,
        pathRequired: true,
      });
      const result = await uploadWorkspace({ ...params, apiMode: true, expectedTransferTarget: sftp });
      publishLocalApiEvent("upload.workspace", {
        targetId: result && result.targetId,
        remotePath: result && result.remotePath,
        uploadedAt: result && result.uploadedAt,
      });
      return result;
    },
    "upload.files": async (params = {}) => {
      if (!Array.isArray(params.files) && !params.manifest) {
        throw new Error("缺少上传文件列表 files 或 manifest。");
      }
      const localBase = String(params.localBase || params.localPath || "").trim();
      const sftp = resolveUploadSftp(localBase, params);
      requireApiConfirmation(params, {
        method: "upload.files",
        operation: "上传指定文件",
        sftp,
        localPath: localBase,
        pathRequired: true,
      });
      const result = await uploadFiles({ ...params, apiMode: true, expectedTransferTarget: sftp });
      publishLocalApiEvent("upload.files", {
        remotePath: result && result.remotePath,
        files: result && result.files,
        uploadedAt: result && result.uploadedAt,
      });
      return result;
    },
    "handoff.markReady": async (params = {}) => {
      const localPath = String(params.localPath || "").trim();
      if (!localPath) throw new Error("缺少本地工作区 localPath。");
      const sftp = readSftpConfig(localPath) || apiTransferSftp(params);
      requireApiConfirmation(params, {
        method: "handoff.markReady",
        operation: "上传并标记交接",
        sftp,
        localPath,
        pathRequired: true,
      });
      const result = await markHandoffReady({ ...params, apiMode: true, localPath });
      publishLocalApiEvent("handoff.markReady", {
        localPath,
        remotePath: result && result.remotePath,
        markedAt: result && result.markedAt,
      });
      return result;
    },
    "downloadScope.configure": async (params = {}) => {
      const localPath = String(params.localPath || "").trim();
      const sftp = apiTransferSftp(params);
      requireApiConfirmation(params, {
        method: "downloadScope.configure",
        operation: "设置下载文件范围",
        sftp,
        localPath,
        pathRequired: true,
      });
      const result = await configureDownloadScope({ ...params, apiMode: true });
      publishLocalApiEvent("downloadScope.configure", {
        targetId: result && result.targetId,
        remotePath: result && result.remotePath,
        scope: result && result.scope,
      });
      return result;
    },
    "confirmations.reset": async (params = {}) => {
      requireApiConfirmation(params, {
        method: "confirmations.reset",
        operation: "重置 SimpleSFTP 路径免提醒记录",
        sftp: null,
        localPath: "",
        pathRequired: false,
      });
      const previous = extensionContext && extensionContext.globalState
        ? extensionContext.globalState.get(PATH_CONFIRMATIONS_STATE, [])
        : [];
      if (extensionContext && extensionContext.globalState) {
        await extensionContext.globalState.update(PATH_CONFIRMATIONS_STATE, []);
      }
      publishLocalApiEvent("confirmations.reset", { resetCount: previous.length });
      return { ok: true, resetCount: previous.length };
    },
  };
}

function requireApiConfirmation(params, { method, operation, sftp, localPath, pathRequired }) {
  const preview = buildApiConfirmationPreview({ method, operation, sftp, localPath, pathRequired });
  const requires = [];
  if (params.confirm !== true) requires.push("confirm");
  if (pathRequired && params.pathConfirmed !== true && !isRememberedTransferPath(localPath, sftp)) {
    requires.push("pathConfirmed");
  }
  if (requires.length) throw confirmationRequired({ ...preview, requires });
  return true;
}

function buildApiConfirmationPreview({ method, operation, sftp, localPath, pathRequired }) {
  return {
    method,
    operation,
    requires: [
      "confirm",
      ...(pathRequired ? ["pathConfirmed"] : []),
    ],
    target: createTransferPreview({
      localPath,
      sftp,
      operation,
      detail: "",
    }),
  };
}

function isRememberedTransferPath(localPath, sftp) {
  if (!localPath || !sftp || !sftp.host || !sftp.remotePath) return false;
  const key = transferPathConfirmationKey(localPath, sftp);
  const remembered = extensionContext && extensionContext.globalState
    ? extensionContext.globalState.get(PATH_CONFIRMATIONS_STATE, [])
    : [];
  return Array.isArray(remembered) && remembered.includes(key);
}

function apiTransferSftp(params = {}) {
  const active = getActiveSharedServer() || {};
  const incoming = params.server && typeof params.server === "object" ? params.server : {};
  const shared = sharedServerForOptions(params, incoming);
  const merged = { ...active, ...shared, ...incoming, ...params };
  const host = firstNonEmpty(
    incoming.transferHost,
    incoming.resolvedHost,
    incoming.sftpHost,
    incoming.sshHost,
    incoming.host,
    incoming.sshConfigHost,
    incoming.sshConfigAlias,
    params.sftpHost,
    params.sshHost,
    params.host,
    params.sshConfigHost,
    params.sshConfigAlias,
    shared.transferHost,
    shared.resolvedHost,
    merged.sftpHost,
    merged.sshHost,
    merged.host,
    merged.sshConfigHost,
    merged.sshConfigAlias,
    active.host,
    active.sshConfigHost
  );
  const username = String(
    incoming.user ||
    incoming.username ||
    shared.user ||
    shared.username ||
    merged.user ||
    merged.username ||
    ""
  ).trim();
  const port = normalizeSshPort(
    incoming.sshPort || incoming.port || shared.sshPort || shared.port || merged.sshPort || merged.port,
    22
  );
  const remotePath = String(
    requestedRemotePath(params) ||
    shared.remotePath ||
    shared.remoteBase ||
    merged.remotePath ||
    merged.remoteBase ||
    active.remotePath ||
    ""
  ).replace(/\/+$/, "");
  return {
    name: String(incoming.id || incoming.label || shared.id || shared.label || merged.id || merged.label || host || "simple-sftp-target"),
    host,
    port,
    username,
    remotePath,
    connectTimeoutSeconds: resolvedConnectTimeoutSeconds(merged.connectTimeoutSeconds),
  };
}

function publicServerRecord(item) {
  if (!item) return null;
  return {
    id: item.id || "",
    label: item.label || item.id || "",
    host: firstNonEmpty(item.sftpHost, item.sshHost, item.host, item.sshConfigHost, item.sshConfigAlias),
    user: item.user || item.username || "",
    port: normalizeSshPort(item.sshPort || item.port, 22),
    remotePath: String(item.remotePath || item.remoteBase || "").replace(/\/+$/, ""),
    sshConfigHost: item.sshConfigHost || item.sshConfigAlias || "",
    source: item.source || "",
    enabled: item.enabled !== false,
  };
}

function simpleSftpConfigSchema() {
  return PACKAGE_JSON.contributes?.configuration?.properties || {};
}

function simpleSftpConfigSuffix(key) {
  return key.startsWith(API_CONFIG_PREFIX) ? key.slice(API_CONFIG_PREFIX.length) : key;
}

function simpleSftpConfigValue(config, key) {
  const schema = simpleSftpConfigSchema()[key] || {};
  return config.get(simpleSftpConfigSuffix(key), schema.default);
}

function validateSimpleSftpConfigValue(key, value) {
  const schema = simpleSftpConfigSchema()[key] || {};
  const type = schema.type;
  if (type === "string" && typeof value !== "string")
    throw new Error(`SimpleSFTP 配置 ${key} 需要 string：${typeof value}`);
  if (type === "number" && (typeof value !== "number" || !Number.isFinite(value)))
    throw new Error(`SimpleSFTP 配置 ${key} 需要 number：${typeof value}`);
  if (type === "integer" && !Number.isInteger(value))
    throw new Error(`SimpleSFTP 配置 ${key} 需要 integer：${typeof value}`);
  if (type === "boolean" && typeof value !== "boolean")
    throw new Error(`SimpleSFTP 配置 ${key} 需要 boolean：${typeof value}`);
  if (type === "array" && !Array.isArray(value))
    throw new Error(`SimpleSFTP 配置 ${key} 需要 array：${typeof value}`);
  if (type === "object" && (!value || typeof value !== "object" || Array.isArray(value)))
    throw new Error(`SimpleSFTP 配置 ${key} 需要 object：${typeof value}`);
  if (Number.isFinite(schema.minimum) && typeof value === "number" && value < schema.minimum)
    throw new Error(`SimpleSFTP 配置 ${key} 不能小于 ${schema.minimum}`);
  if (Number.isFinite(schema.maximum) && typeof value === "number" && value > schema.maximum)
    throw new Error(`SimpleSFTP 配置 ${key} 不能大于 ${schema.maximum}`);
  return value;
}

function serverIdFromLabel(label) {
  return String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "") || `server-${Date.now()}`;
}

function sanitizeServerProfile(input, existing = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("servers.save 的 server 参数必须是对象。");
  const label = String(input.label || existing.label || "").trim();
  const id = String(input.id || label || "").trim() || serverIdFromLabel(label);
  if (!id)
    throw new Error("servers.save 缺少服务器 id 或 label。");
  const host = firstNonEmpty(
    input.host,
    input.sftpHost,
    input.sshHost,
    input.sshConfigHost,
    input.sshConfigAlias,
    existing.host,
    existing.sftpHost,
    existing.sshHost,
    existing.sshConfigHost,
    existing.sshConfigAlias
  );
  if (!host)
    throw new Error("servers.save 至少需要一个 host、sftpHost、sshHost 或 sshConfigHost。");
  const sshPort = normalizeSshPort(input.sshPort ?? input.port ?? existing.sshPort ?? existing.port, 22);
  return {
    ...existing,
    ...input,
    id,
    label: String(input.label || existing.label || id).trim() || id,
    enabled: input.enabled !== false,
    source: String(input.source || existing.source || "api").trim() || "api",
    sshPort,
    port: sshPort,
    remotePath: String(input.remotePath ?? input.remoteBase ?? existing.remotePath ?? existing.remoteBase ?? "")
      .trim()
      .replace(/\/+$/, ""),
    localBase: String(input.localBase ?? existing.localBase ?? "").trim(),
    sshConfigHost: String(input.sshConfigHost ?? input.sshConfigAlias ?? existing.sshConfigHost ?? existing.sshConfigAlias ?? "").trim(),
    sshConfigAlias: String(input.sshConfigAlias ?? input.sshConfigHost ?? existing.sshConfigAlias ?? existing.sshConfigHost ?? "").trim(),
    sftpHost: String(input.sftpHost ?? existing.sftpHost ?? "").trim(),
    sshHost: String(input.sshHost ?? existing.sshHost ?? "").trim(),
    host: String(input.host ?? existing.host ?? host).trim(),
    user: String(input.user ?? input.username ?? existing.user ?? existing.username ?? "").trim(),
    username: String(input.username ?? input.user ?? existing.username ?? existing.user ?? "").trim(),
    maxConcurrentGpus: Number.isInteger(input.maxConcurrentGpus ?? existing.maxConcurrentGpus ?? 1)
      ? Math.max(1, Number(input.maxConcurrentGpus ?? existing.maxConcurrentGpus ?? 1))
      : 1,
    allowedGpuIds: Array.isArray(input.allowedGpuIds ?? existing.allowedGpuIds)
      ? [...(input.allowedGpuIds ?? existing.allowedGpuIds)].map(String)
      : [],
  };
}

function publishLocalApiEvent(type, data) {
  if (!localApiServer) return null;
  return localApiServer.publish({
    type,
    data: {
      ...(data || {}),
      publishedAt: new Date().toISOString(),
    },
  });
}

function filesSummary(files) {
  const items = Array.isArray(files) ? files : [];
  if (!items.length) return "调用方提供的 runtime manifest";
  const names = items.slice(0, 8).map((item) => {
    const value = typeof item === "string" ? item : String(item && (item.localPath || item.path || item.remoteName) || "");
    if (!value) return "-";
    try { return resolveUploadFilePath(value); } catch { return value; }
  });
  return `${names.join("、")}${items.length > names.length ? ` 等 ${items.length} 个文件` : ""}`;
}

function readSftpConfig(localPath) {
  const configPath = path.join(localPath, ".vscode", "sftp.json");
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function patternMatchesPath(lowerPath, pattern) {
  const lowerPattern = String(pattern).toLowerCase();
  if (lowerPattern.startsWith("*.")) {
    return lowerPath.endsWith(lowerPattern.slice(1));
  }
  if (lowerPattern.includes("*")) {
    return wildcardToRegExp(lowerPattern).test(lowerPath);
  }
  return lowerPath === lowerPattern || lowerPath.endsWith(`/${lowerPattern}`);
}

function wildcardToRegExp(pattern) {
  return new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, ".*")}$`, "i");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function writeLocalSessionRecord(localPath, record) {
  const vscodeDir = path.join(localPath, ".vscode");
  fs.mkdirSync(vscodeDir, { recursive: true });
  fs.writeFileSync(
    path.join(vscodeDir, "simple-sftp-session.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8"
  );
}

async function readRemoteHandoffMarker(sftp, markerName) {
  const markerPath = getRemoteMarkerPath(sftp.remotePath, markerName);
  const command = `if [ -f ${shellQuote(markerPath)} ]; then cat ${shellQuote(markerPath)}; fi`;
  const stdout = await runSsh(sftp, command, 15000);
  const text = stdout.trim();
  return text ? JSON.parse(text) : null;
}

async function writeRemoteHandoffMarker(sftp, markerName, marker) {
  const markerPath = getRemoteMarkerPath(sftp.remotePath, markerName);
  const json = `${JSON.stringify(marker, null, 2)}\n`;
  const command = `printf %s ${shellQuote(json)} > ${shellQuote(markerPath)}`;
  await runSsh(sftp, command, 15000);
}

function getRemoteMarkerPath(remotePath, markerName) {
  const safeMarkerName = path.posix.basename(markerName || DEFAULT_HANDOFF_MARKER);
  return `${String(remotePath).replace(/\/+$/, "")}/${safeMarkerName}`;
}

function runSsh(sftp, command, timeout) {
  return new Promise((resolve, reject) => {
    execFile("ssh", getSshArgs(sftp, command), { timeout, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error(stderr || error.message);
        failure.stderr = stderr;
        reject(classifySftpFailure(failure, sftp, {
          command,
          sshStderr: stderr,
          sshCode: error.code,
        }));
        return;
      }
      resolve(stdout);
    });
  });
}

async function handleSavedDocument(document) {
  if (!document || !["file", "vscode-remote"].includes(document.uri.scheme)) return;

  const cfg = vscode.workspace.getConfiguration("simpleSftp");
  if (!cfg.get("uploadOnSave")) return;

  let documentHostPath;
  try {
    documentHostPath = workspaceHostPathForUri(document.uri);
  } catch (error) {
    vscode.window.showWarningMessage(`SimpleSFTP 保存时上传已阻止：${formatError(error)}`);
    return;
  }
  const workspaceFolder = getWorkspaceFolderForFile(documentHostPath);
  if (!workspaceFolder) return;

  const localPath = getWorkspaceRoot(workspaceFolder);
  const sftp = readSftpConfig(localPath);
  if (!sftp || !sftp.remotePath || !sftp.host) return;

  disableExternalUploadOnSave(localPath);
  enqueueWorkspaceUpload(localPath, () => uploadChangedLocalFiles({ localPath, sftp }));
}

function enqueueWorkspaceUpload(localPath, task) {
  const key = localPath.toLowerCase();
  const previous = uploadQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task)
    .catch((error) => {
      vscode.window.showWarningMessage(`SimpleSFTP 保存时上传失败：${formatError(error)}`);
    })
    .finally(() => {
      if (uploadQueues.get(key) === next) {
        uploadQueues.delete(key);
      }
    });
  uploadQueues.set(key, next);
}

async function uploadChangedLocalFiles({ localPath, sftp }) {
  return withHostOperationLease("upload-on-save", "保存时上传", localPath, () => uploadChangedLocalFilesCore({ localPath, sftp }));
}

async function uploadChangedLocalFilesCore({ localPath, sftp }) {
  await confirmTransferPath({ localPath, sftp, operation: "保存时上传", detail: "当前工作区内自上次同步后变更的文件" });
  const scanStartedAt = new Date();
  const changedFiles = findChangedLocalFiles({ localPath, sftp });
  if (changedFiles.length === 0) {
    vscode.window.setStatusBarMessage("SimpleSFTP：没有需要上传的变更文件", 2500);
    return;
  }
  const uploadPlan = {
    mode: "changed",
    files: changedFiles.map((relativePath) => {
      const fullPath = path.join(localPath, relativePath);
      return { relativePath, fullPath, size: fs.statSync(fullPath).size };
    }),
    excludedRuleHits: 0,
    excludedNestedGitRepos: 0,
    nestedGitRoots: [],
  };
  uploadPlan.fileCount = uploadPlan.files.length;
  uploadPlan.byteCount = uploadPlan.files.reduce((total, file) => total + file.size, 0);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `SimpleSFTP 正在上传 ${changedFiles.length} 个变更文件`,
      cancellable: uploadProgressCancellable(),
    },
    (_progress, token) => runLocalTarUpload({
      localPath,
      sftp,
      uploadPlan,
      operation: "上传变更文件",
      timeoutMs: transferTimeoutMs(sftp),
      token,
    })
  );

  writeUploadState(localPath, {
    lastUploadedAt: scanStartedAt.toISOString(),
    mode: "changed",
    fileCount: changedFiles.length,
    remotePath: sftp.remotePath,
  });
  writeLocalSessionRecord(localPath, {
    action: "uploadChanged",
    device: getDeviceName(),
    remotePath: sftp.remotePath,
    fileCount: changedFiles.length,
    at: new Date().toISOString(),
  });
  vscode.window.setStatusBarMessage(`SimpleSFTP：已上传 ${changedFiles.length} 个变更文件`, 3500);
}

async function uploadAllLocalToRemote({ localPath, sftp, writeState = true, pathConfirmed = false, options = {} }) {
  return withHostOperationLease("upload-all-files", "上传全部本地文件", localPath, () => uploadAllLocalToRemoteCore({ localPath, sftp, writeState, pathConfirmed, options }));
}

async function uploadAllLocalToRemoteCore({ localPath, sftp, writeState = true, pathConfirmed = false, options = {} }) {
  if (!sftp || !sftp.remotePath || !sftp.host) {
    throw new Error("未配置可用的 SFTP 远端路径。");
  }
  if (!pathConfirmed) {
    await confirmTransferPath({ localPath, sftp, operation: "上传全部本地文件", detail: "当前工作区内未被忽略的文件" });
  }

  const uploadStartedAt = new Date();
  const uploadPlan = createWorkspaceUploadPlan(localPath, sftp);
  if (!uploadPlan.fileCount) {
    throw new Error("没有要上传的文件；所有文件都被忽略规则排除。");
  }
  const stats = await runUploadWithProgress(options, `上传全部本地文件 -> ${sftp.remotePath}`, (token) => runLocalTarUpload({
      localPath,
      sftp,
      uploadPlan,
      operation: "上传全部文件",
      timeoutMs: transferTimeoutMs(sftp, options),
      token,
      transferId: options.transferId,
    }));
  if (writeState) {
    writeUploadState(localPath, {
      lastUploadedAt: uploadStartedAt.toISOString(),
      mode: "all",
      remotePath: sftp.remotePath,
    });
  }
  return stats;
}

function findChangedLocalFiles({ localPath, sftp }) {
  const baselineMs = getUploadBaselineMs(localPath);
  const changed = [];
  walkLocalFiles(localPath, "", sftp.ignore, (relativePath, fullPath) => {
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs > baselineMs + 1) {
      changed.push(relativePath);
    }
  });
  return changed.sort((a, b) => a.localeCompare(b));
}

function walkLocalFiles(rootPath, relativeDir, ignorePatterns, visitFile, planStats = null, nestedGitRoots = null) {
  const currentDir = relativeDir ? path.join(rootPath, relativeDir) : rootPath;
  if (relativeDir && fs.existsSync(path.join(currentDir, ".git"))) {
    if (planStats) {
      planStats.excludedNestedGitRepos += 1;
      (nestedGitRoots || []).push(relativeDir);
    }
    return;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const relativePath = toPosixPath(relativeDir ? path.join(relativeDir, entry.name) : entry.name);
    const ignored = isIgnoredLocalPath(relativePath, ignorePatterns);
    if (ignored && planStats) planStats.excludedRuleHits += 1;
    if (ignored) continue;

    const fullPath = path.join(rootPath, relativePath);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walkLocalFiles(rootPath, relativePath, ignorePatterns, visitFile, planStats, nestedGitRoots);
      continue;
    }
    if (entry.isFile()) {
      visitFile(relativePath, fullPath);
    }
  }
}

function createWorkspaceUploadPlan(localPath, sftp) {
  const files = [];
  const nestedGitRoots = [];
  const stats = { excludedRuleHits: 0, excludedNestedGitRepos: 0 };
  walkLocalFiles(localPath, "", sftp.ignore, (relativePath, fullPath) => {
    const size = fs.statSync(fullPath).size;
    files.push({ relativePath, fullPath, size });
    stats.byteCount = (stats.byteCount || 0) + Number(size) || 0;
  }, stats, nestedGitRoots);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    mode: "workspace",
    files,
    fileCount: files.length,
    byteCount: files.reduce((total, file) => total + file.size, 0),
    excludedRuleHits: stats.excludedRuleHits,
    excludedNestedGitRepos: stats.excludedNestedGitRepos,
    nestedGitRoots: nestedGitRoots.sort(),
  };
}

function createManifestUploadPlan({ localPath, sftp, manifest, changedPaths }) {
  const changed = Array.isArray(changedPaths) ? new Set(changedPaths) : null;
  const relativePaths = getManifestUploadRelativePaths({ localPath, sftp, manifest })
    .filter((relativePath) => !changed || changed.has(relativePath));
  const files = relativePaths.map((relativePath) => {
    const fullPath = path.join(localPath, relativePath);
    const size = fs.statSync(fullPath).size;
    return { relativePath, fullPath, size };
  });
  return {
    mode: "manifest",
    files,
    fileCount: files.length,
    byteCount: files.reduce((total, file) => total + file.size, 0),
    excludedRuleHits: 0,
    excludedNestedGitRepos: 0,
    nestedGitRoots: [],
  };
}

function hashUploadPlanChunks(files, chunkSize = 500) {
  const hash = crypto.createHash("sha256");
  const chunks = [];
  for (let start = 0; start < files.length; start += chunkSize) {
    const entries = files.slice(start, start + chunkSize).map((file) => [
      toTarPath(file.relativePath),
      Number(file.size) || 0,
    ]);
    const payload = `${start}:${entries.length}:${JSON.stringify(entries)}`;
    const checksum = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
    hash.update(checksum);
    chunks.push({ start, count: entries.length, checksum });
  }
  return { algorithm: "sha256", chunkSize, chunks, combinedChecksum: hash.digest("hex") };
}

function getUploadBaselineMs(localPath) {
  const state = readUploadState(localPath);
  const stateTime = parseTimeMs(state && state.lastUploadedAt);
  if (stateTime !== null) return stateTime;

  const session = readLocalSessionRecord(localPath);
  const sessionTime = parseTimeMs(session && (session.at || session.markedAt));
  if (sessionTime !== null) return sessionTime;

  const now = new Date();
  writeUploadState(localPath, {
    lastUploadedAt: now.toISOString(),
    mode: "initial",
  });
  return now.getTime();
}

function readUploadState(localPath) {
  const statePath = path.join(localPath, ".vscode", SAVE_UPLOAD_STATE);
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function writeUploadState(localPath, state) {
  const vscodeDir = path.join(localPath, ".vscode");
  fs.mkdirSync(vscodeDir, { recursive: true });
  fs.writeFileSync(
    path.join(vscodeDir, SAVE_UPLOAD_STATE),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8"
  );
}

function readLocalSessionRecord(localPath) {
  const sessionPath = path.join(localPath, ".vscode", "simple-sftp-session.json");
  if (!fs.existsSync(sessionPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  } catch {
    return null;
  }
}

function parseTimeMs(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function isIgnoredLocalPath(relativePath, ignorePatterns) {
  const normalized = toPosixPath(relativePath).replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized) return false;
  const lowerPath = normalized.toLowerCase();
  const patterns = Array.isArray(ignorePatterns) ? ignorePatterns : [];
  return patterns.some((pattern) => patternMatchesPath(lowerPath, String(pattern).toLowerCase()));
}

function applyUploadOnSaveSettingToOpenWorkspaces() {
  const folders = vscode.workspace.workspaceFolders || [];
  for (const folder of folders) {
    let localPath;
    try {
      localPath = getWorkspaceRoot(folder);
    } catch {
      continue;
    }
    if (!readSftpConfig(localPath)) continue;
    disableExternalUploadOnSave(localPath);
    getUploadBaselineMs(localPath);
  }
}

function disableExternalUploadOnSave(localPath) {
  const sftpPath = path.join(localPath, ".vscode", "sftp.json");
  if (!fs.existsSync(sftpPath)) return;

  let sftp;
  try {
    sftp = JSON.parse(fs.readFileSync(sftpPath, "utf8"));
  } catch {
    return;
  }
  if (!sftp || sftp.uploadOnSave === false) return;

  sftp.uploadOnSave = false;
  fs.writeFileSync(sftpPath, `${JSON.stringify(sftp, null, 2)}\n`, "utf8");
}

function getWorkspaceFolderForFile(filePath) {
  const folders = vscode.workspace.workspaceFolders || [];
  const normalizedFile = path.win32.normalize(filePath).toLowerCase();
  return folders
    .map((folder) => {
      try {
        return { folder, normalizedPath: path.win32.normalize(getWorkspaceRoot(folder)).toLowerCase() };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(({ normalizedPath }) => (
      normalizedFile === normalizedPath ||
      normalizedFile.startsWith(`${normalizedPath}${path.win32.sep}`)
    ))
    .sort((a, b) => b.normalizedPath.length - a.normalizedPath.length)
    .map(({ folder }) => folder)[0] || null;
}

function runLocalTarUpload({ localPath, sftp, uploadPlan, operation, timeoutMs, token, transferId }) {
  const remoteCommand = createRemoteExtractCommand(sftp.remotePath);
  const plan = uploadPlan || createWorkspaceUploadPlan(localPath, sftp);
  const manifestContent = `${plan.files.map((file) => tarEntryPath(file.relativePath)).join("\n")}\n`;
  const chunkedChecksum = hashUploadPlanChunks(plan.files);
  const startedAt = Date.now();
  const upload = new Promise((resolve, reject) => {
    const controller = createTransferController({
      id: transferId || nextTransferId(operation),
      operation,
      localPath,
      remotePath: String(sftp && sftp.remotePath || ""),
      host: String(sftp && sftp.host || ""),
    });
    const sshProc = spawn("ssh", getSshArgs(sftp, remoteCommand), {
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
    });

    let settled = false;
    let sshCode;
    let sshStderr = "";
    let cancelListener;
    let tokenDisposable;
    let timer;

    const stopController = () => {
      clearTimeout(timer);
      if (tokenDisposable && typeof tokenDisposable.dispose === "function") {
        tokenDisposable.dispose();
      }
      controller.dispose();
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      stopController();
      // A failed spawn can make kill() throw. Always settle the upload Promise
      // so the API request and shared host lease can finish with the cause.
      try { sshProc.kill(); } catch {}
      try {
        reject(classifySftpFailure(error, sftp, {
          command: remoteCommand,
          sshStderr,
        }));
      } catch {
        reject(error);
      }
    };

    const finish = () => {
      if (settled || sshCode === undefined) return;
      settled = true;
      stopController();
      if (sshCode !== 0) {
        const failure = new Error(formatProcessFailure({
          operation,
          sshCode,
          sshStderr,
        }));
        reject(classifySftpFailure(failure, sftp, {
          command: remoteCommand,
          sshCode,
          sshStderr,
        }));
        return;
      }
      resolve({
        fileCount: plan.fileCount,
        byteCount: plan.byteCount,
        excludedRuleHits: plan.excludedRuleHits,
        excludedNestedGitRepos: plan.excludedNestedGitRepos,
        nestedGitRoots: plan.nestedGitRoots,
        durationMs: Date.now() - startedAt,
        verification: {
          method: "chunked-sha256",
          ...chunkedChecksum,
          manifestSha256: crypto.createHash("sha256").update(manifestContent, "utf8").digest("hex"),
        },
      });
    };

    cancelListener = (reason) => fail(new Error(reason || "传输已取消"));
    controller.onCancel(cancelListener);
    if (token) {
      if (token.isCancellationRequested) {
        fail(new Error("传输已取消"));
      } else if (typeof token.onCancellationRequested === "function") {
        tokenDisposable = token.onCancellationRequested(() => fail(new Error("传输已取消")));
      }
    }
    const timeout = Number(timeoutMs) || transferTimeoutMs(sftp);
    if (timeout > 0) {
      timer = setTimeout(() => fail(new Error(`SimpleSFTP 传输超过 ${Math.round(timeout / 1000)} 秒未完成，已停止。`)), timeout);
    }

    sshProc.on("error", fail);
    sshProc.stderr.on("data", (chunk) => {
      sshStderr = appendProcessOutput(sshStderr, chunk);
    });
    sshProc.stdin.on("error", () => {});

    writeTarEntriesToStream({ localPath, files: plan.files, stream: sshProc.stdin })
      .then(() => sshProc.stdin.end())
      .catch(fail);
    sshProc.on("close", (code, signal) => {
      sshCode = code === null ? `signal ${signal || "unknown"}` : code;
      finish();
      });
    });

  return upload.finally(() => {
  });
}

function createRemoteExtractCommand(remotePath) {
  const safeRemotePath = String(remotePath).replace(/\/+$/, "");
  return `mkdir -p ${shellQuote(safeRemotePath)} && tar -xf - -C ${shellQuote(safeRemotePath)}`;
}

async function downloadRemoteToLocal({ localPath, sftp, downloadScope }) {
  return withHostOperationLease("download-workspace", "下载远端工作区", localPath, () => downloadRemoteToLocalCore({ localPath, sftp, downloadScope }));
}

async function downloadRemoteToLocalCore({ localPath, sftp, downloadScope }) {
  if (!sftp || !sftp.remotePath || !sftp.host) {
    throw new Error("未配置可用的 SFTP 远端路径。");
  }

  fs.mkdirSync(localPath, { recursive: true });
  const title = `正在同步远端到本地：${sftp.remotePath} -> ${localPath}`;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: uploadProgressCancellable(),
    },
    (_progress, token) => runRemoteTarExtract({
      localPath,
      sftp,
      downloadScope,
      timeoutMs: transferTimeoutMs(sftp),
      token,
    })
  );
}

function runRemoteTarExtract({ localPath, sftp, downloadScope, timeoutMs, token, transferId }) {
  const remoteCommand = createRemoteTarCommand(sftp, downloadScope);
  return new Promise((resolve, reject) => {
    const controller = createTransferController({
      id: transferId || nextTransferId("远端到本地同步"),
      operation: "远端到本地同步",
      localPath,
      remotePath: String(sftp && sftp.remotePath || ""),
      host: String(sftp && sftp.host || ""),
    });
    const sshProc = spawn("ssh", getSshArgs(sftp, remoteCommand), {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tarProc = spawn("tar", ["-xf", "-", "-C", localPath], {
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
    });

    let settled = false;
    let sshCode;
    let tarCode;
    let sshStderr = "";
    let tarStderr = "";
    let cancelListener;
    let tokenDisposable;
    let timer;

    const stopController = () => {
      clearTimeout(timer);
      if (tokenDisposable && typeof tokenDisposable.dispose === "function") {
        tokenDisposable.dispose();
      }
      controller.dispose();
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      stopController();
      try { sshProc.kill(); } catch {}
      try { tarProc.kill(); } catch {}
      reject(classifySftpFailure(error, sftp, {
        command: remoteCommand,
        sshStderr,
        tarStderr,
      }));
    };

    const finish = () => {
      if (settled || sshCode === undefined || tarCode === undefined) return;
      settled = true;
      stopController();
      if (sshCode !== 0 || tarCode !== 0) {
        const failure = new Error(formatProcessFailure({
          operation: "远端到本地同步",
          sshCode,
          tarCode,
          sshStderr,
          tarStderr,
        }));
        reject(classifySftpFailure(failure, sftp, {
          command: remoteCommand,
          sshCode,
          tarCode,
          sshStderr,
          tarStderr,
        }));
        return;
      }
      resolve();
    };

    cancelListener = (reason) => fail(new Error(reason || "传输已取消"));
    controller.onCancel(cancelListener);
    if (token) {
      if (token.isCancellationRequested) {
        fail(new Error("传输已取消"));
      } else if (typeof token.onCancellationRequested === "function") {
        tokenDisposable = token.onCancellationRequested(() => fail(new Error("传输已取消")));
      }
    }
    const timeout = Number(timeoutMs) || transferTimeoutMs(sftp);
    if (timeout > 0) {
      timer = setTimeout(() => fail(new Error(`SimpleSFTP 传输超过 ${Math.round(timeout / 1000)} 秒未完成，已停止。`)), timeout);
    }

    sshProc.on("error", fail);
    tarProc.on("error", fail);
    sshProc.stderr.on("data", (chunk) => {
      sshStderr = appendProcessOutput(sshStderr, chunk);
    });
    tarProc.stderr.on("data", (chunk) => {
      tarStderr = appendProcessOutput(tarStderr, chunk);
    });
    tarProc.stdin.on("error", () => {});

    sshProc.stdout.pipe(tarProc.stdin);
    sshProc.on("close", (code, signal) => {
      sshCode = code === null ? `signal ${signal || "unknown"}` : code;
      finish();
    });
    tarProc.on("close", (code, signal) => {
      tarCode = code === null ? `signal ${signal || "unknown"}` : code;
      finish();
    });
  });
}

function createRemoteTarCommand(sftp, downloadScope) {
  const remotePath = String(sftp.remotePath).replace(/\/+$/, "");
  const scope = downloadScope && Array.isArray(downloadScope.paths) && downloadScope.paths.length
    ? normalizeDownloadScope(downloadScope)
    : null;
  if (scope) {
    return `python3 -c ${shellQuote(createRemoteDownloadScript(remotePath, scope))}`;
  }
  const args = [
    "tar",
    "-cf",
    "-",
    ...getTarExcludeArgs(sftp.ignore),
    ".",
  ];
  return `cd ${shellQuote(remotePath)} && ${args.map(shellQuote).join(" ")}`;
}

function createRemoteDownloadScript(remotePath, downloadScope) {
    const scope = normalizeDownloadScope(downloadScope);
    const payload = Buffer.from(JSON.stringify(scope), "utf8").toString("base64");
    return [
      "import base64,json,os,sys,tarfile",
      `root=os.path.realpath(${JSON.stringify(remotePath)})`,
      `scope=json.loads(base64.b64decode(${JSON.stringify(payload)}).decode('utf-8'))`,
      "paths=scope.get('paths') or []",
      "extensions=[str(v).lower() for v in (scope.get('extensions') or ['*'])]",
      "allow_any='*' in extensions",
      "max_bytes=None if scope.get('noSizeLimit') else int(float(scope.get('maxFileSizeMB') or 1024)*1024*1024)",
      "blocked={'.git','.vscode','.codex','zlk_cluster'}",
      "def blocked_path(rel):",
      "    parts=rel.replace('\\\\','/').lower().split('/')",
      "    if any(p in blocked for p in parts): return True",
      "    if parts[0]!='simple_cluster': return False",
      "    if len(parts)==1: return False",
      "    if len(parts)>1 and parts[1] in ('results','debug_runs'): return False",
      "    if len(parts)==2 and parts[1]=='tmp': return False",
      "    if len(parts)>2 and parts[1]=='tmp' and parts[2]=='tmux_logs': return False",
      "    if len(parts)>2 and parts[1]=='tmp' and parts[2]=='cluster_scheduler': return len(parts)>3 and parts[3]!='logs' and not parts[-1].endswith('.log')",
      "    return True",
      "selected=[]",
      "seen=set()",
      "def inside(value):",
      "    try: return os.path.commonpath([root, value]) == root",
      "    except ValueError: return False",
      "def allowed(rel, full):",
      "    if not rel or rel in seen or os.path.islink(full) or not os.path.isfile(full): return False",
      "    if blocked_path(rel): return False",
      "    if max_bytes is not None and os.path.getsize(full) > max_bytes: return False",
      "    lower=rel.lower()",
      "    return allow_any or any(lower.endswith(ext) for ext in extensions)",
      "for rel_root in paths:",
      "    rel_root=str(rel_root or '.').replace('\\\\','/').strip('/') or '.'",
      "    target=os.path.realpath(os.path.join(root, rel_root))",
      "    if not inside(target) or os.path.islink(target): continue",
      "    if os.path.isfile(target):",
      "        rel=os.path.relpath(target,root).replace(os.sep,'/')",
      "        if allowed(rel,target): seen.add(rel); selected.append((rel,target))",
      "        continue",
      "    if not os.path.isdir(target): continue",
      "    for current,dirs,files in os.walk(target,followlinks=False):",
      "        dirs[:]=[d for d in dirs if not os.path.islink(os.path.join(current,d)) and not blocked_path(os.path.relpath(os.path.join(current,d),root).replace(os.sep,'/'))]",
      "        for name in files:",
      "            full=os.path.join(current,name)",
      "            rel=os.path.relpath(full,root).replace(os.sep,'/')",
      "            if allowed(rel,full): seen.add(rel); selected.append((rel,full))",
      "with tarfile.open(fileobj=sys.stdout.buffer,mode='w|') as archive:",
      "    for rel,full in sorted(selected): archive.add(full,arcname=rel,recursive=False)",
    ].join("\n");
}

function getTarExcludeArgs(ignorePatterns) {
  const excludes = new Set();
  for (const pattern of Array.isArray(ignorePatterns) ? ignorePatterns : []) {
    addTarExcludePattern(excludes, pattern);
  }
  addTarExcludePattern(excludes, ".vscode");
  addTarExcludePattern(excludes, DEFAULT_HANDOFF_MARKER);
  return Array.from(excludes).map((pattern) => `--exclude=${pattern}`);
}

function addTarExcludePattern(excludes, pattern) {
  const normalized = String(pattern || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized === ".") return;

  excludes.add(normalized);
  if (!normalized.startsWith("./")) {
    excludes.add(`./${normalized}`);
  }
  if (!normalized.includes("/") && !normalized.includes("*")) {
    excludes.add(`*/${normalized}`);
  }
}

function appendProcessOutput(existing, chunk) {
  return `${existing}${chunk.toString("utf8")}`.slice(-4000);
}

function toPosixPath(value) {
  return String(value).replace(/\\/g, "/");
}

function toTarPath(value) {
  const normalized = toPosixPath(value).replace(/^\/+/, "");
  return normalized.startsWith("-") ? `./${normalized}` : normalized;
}

function formatProcessFailure({ operation, sshCode, tarCode, sshStderr, tarStderr }) {
  const sshText = String(sshStderr || "").trim();
  const tarText = String(tarStderr || "").trim();
  const details = [
    `ssh 退出码：${sshCode}`,
    tarCode === undefined ? "" : `tar 退出码：${tarCode}`,
    sshText ? `ssh: ${sshText}` : "",
    tarText ? `tar: ${tarText}` : "",
  ].filter(Boolean);
  return `${operation || "SFTP 传输"}失败。${details.join(" | ")}`;
}

function classifySftpFailure(error, sftp, context = {}) {
  const classified = classifyTransportFailure(error, context);
  const host = String(sftp && sftp.host || "").trim();
  const port = normalizeSshPort(sftp && sftp.port, 22);
  if (classified.category !== "user_cancelled") {
    classified.message = `SimpleSFTP 到 ${host || "未知主机"}:${port} 的传输失败：${classified.message} ${classified.diagnosis}`;
  }
  classified.apiData = {
    category: classified.category,
    retryable: classified.retryable,
    diagnosis: classified.diagnosis,
    host,
    port,
    remotePath: String(sftp && sftp.remotePath || ""),
    sshStderr: classified.details.sshStderr,
  };
  return classified;
}

function classifyTransportFailure(error, context = {}) {
  const source = error instanceof Error ? error : new Error(String(error || "传输失败"));
  const combined = [
    source.message,
    source.stderr || "",
    String(context.sshStderr || ""),
    String(context.tarStderr || ""),
  ].join("\n").toLowerCase();
  const classified = new Error(source.message || "SimpleSFTP 传输失败。");
  classified.cause = source;
  classified.details = {
    sshExitCode: context.sshCode,
    tarExitCode: context.tarCode,
    sshStderr: String(context.sshStderr || "").slice(-4000),
    tarStderr: String(context.tarStderr || "").slice(-4000),
  };
  if (source.name === "Cancel" || /传输已取消|用户通过 api 取消/.test(combined)) {
    classified.category = "user_cancelled";
    classified.retryable = false;
    classified.diagnosis = "用户或调用方取消了传输。";
    return classified;
  }
  if (/connection timed out|no route to host|network is unreachable/.test(combined)) {
    classified.category = "dns_tcp_unreachable";
    classified.retryable = true;
    classified.diagnosis = "SSH 地址或端口不可达；核对服务器配置、网络和防火墙。";
    return classified;
  }
  if (/传输超过|simple-sftp timeout|timeout|timed out/.test(combined)) {
    classified.category = "transfer_timeout";
    classified.retryable = true;
    classified.diagnosis = "传输超时；先核对 SSH IP、端口和网络，再检查目标负载或增大超时。";
    return classified;
  }
  if (/permission denied \(publickey|authentication failed|host key verification failed|invalid format\)/.test(combined)) {
    classified.category = "ssh_auth_failed";
    classified.retryable = false;
    classified.diagnosis = "SSH 认证、密钥或 host key 验证失败；先用同一 alias 手动连接验证。";
    return classified;
  }
  if (/local forward|forwarding failed|channel .* not opened/.test(combined)) {
    classified.category = "local_forward_unavailable";
    classified.retryable = true;
    classified.diagnosis = "本机转发端口未建立或目标 Agent/SSH 服务不可达。";
    return classified;
  }
  if (/enotfound|no such host|name or service not known|temporary failure in name resolution|econnrefused|connection refused/.test(combined)) {
    classified.category = "dns_tcp_unreachable";
    classified.retryable = true;
    classified.diagnosis = "DNS 或 TCP 链路不可达；核对网络、防火墙和服务器地址。";
    return classified;
  }
  if (/subsystem request failed|unknown subsystem/.test(combined)) {
    classified.category = "sftp_subsystem_unavailable";
    classified.retryable = false;
    classified.diagnosis = "远端 SSH 子系统不可用；确认服务器允许当前账号使用所需子系统。";
    return classified;
  }
  if (/mkdir |permission denied|read-only file system|disk quota exceeded|no space left on device/.test(combined)) {
    classified.category = "remote_permission_denied";
    classified.retryable = false;
    classified.diagnosis = "远端目录权限、只读文件系统或磁盘配额导致写入失败。";
    return classified;
  }
  if (/remote root|outside .*root|路径越界|不安全的受管理代码路径/.test(combined)) {
    classified.category = "remote_root_validation_failed";
    classified.retryable = false;
    classified.diagnosis = "目标路径未通过远端根目录或托管路径安全校验。";
    return classified;
  }
  classified.category = "transport_failed";
  classified.retryable = true;
  classified.diagnosis = "传输失败；请查看 SSH/tar 的退出码和错误输出。";
  return classified;
}

function getSshTarget(sftp) {
  const host = String(sftp.host || "").trim();
  const username = String(sftp.username || "").trim();
  if (!host) throw new Error("缺少 SFTP host。");
  if (!username || host.includes("@")) return host;
  return `${username}@${host}`;
}

function getSshArgs(sftp, command) {
  const args = [];
  const port = normalizeSshPort(sftp && sftp.port, 22);
  if (port !== 22) {
    args.push("-p", String(port));
  }
  const rawConnectTimeout = Number((sftp && sftp.connectTimeoutSeconds) || defaultConnectTimeoutSeconds);
  const connectTimeout = Number.isFinite(rawConnectTimeout)
    ? Math.min(Math.max(0, Math.floor(rawConnectTimeout)), 3600)
    : defaultConnectTimeoutSeconds;
  if (connectTimeout > 0) {
    args.push("-o", `ConnectTimeout=${connectTimeout}`);
  }
  args.push(getSshTarget(sftp), command);
  return args;
}

function normalizeSshPort(value, fallback = 22) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function upsertAgentsFile({ execHost, localPath, remotePath, userName, port }) {
  const agentsPath = path.join(localPath, "AGENTS.md");
  const existing = fs.existsSync(agentsPath)
    ? fs.readFileSync(agentsPath, "utf8")
    : "# Agent Instructions\n";
  const block = createAgentsManagedBlock({ execHost, localPath, remotePath, userName, port });

  let next;
  if (existing.includes(AGENTS_BLOCK_START) && existing.includes(AGENTS_BLOCK_END)) {
    const pattern = new RegExp(
      `${escapeRegExp(AGENTS_BLOCK_START)}[\\s\\S]*?${escapeRegExp(AGENTS_BLOCK_END)}`,
      "m"
    );
    next = existing.replace(pattern, block.trimEnd());
  } else {
    next = `${existing.trimEnd()}\n\n${block}`;
  }

  fs.writeFileSync(agentsPath, `${next.trimEnd()}\n`, "utf8");
}

function createAgentsManagedBlock({ execHost, localPath, remotePath, userName, port }) {
  const sshCommand = createSshCommandTemplate({ execHost, remotePath, userName, port });
  return `${AGENTS_BLOCK_START}
## SimpleSFTP

此工作区在本地 VS Code 中编辑，并通过 SimpleSFTP 与远端 Linux 项目目录同步。

路径映射：

- 远端：${remotePath}
- 本地：${localPath}

工作流：

- 切换设备后开始编辑前，先运行 \`SimpleSFTP：远端同步到本地\`。
- 编辑时保存本地文件，SimpleSFTP 会上传自上次成功同步或上传后发生变化的文件。
- 关闭本设备前，运行 \`SimpleSFTP：上传并标记交接\`，选择 \`上传全部并标记\`。
- 命令、测试、训练、Git 操作和依赖服务器环境的脚本仍应在服务器上执行。

远端命令模板：

\`\`\`bash
${sshCommand}
\`\`\`

除非用户明确要求，不要直接在 Windows 本地运行项目测试或训练。
${AGENTS_BLOCK_END}
`;
}

function createSshCommandTemplate({ execHost, remotePath, userName, port }) {
  const sshPort = normalizeSshPort(port, 22);
  const target = userName ? `${userName}@${execHost}` : execHost;
  const portArgs = sshPort === 22 ? "" : ` -p ${sshPort}`;
  return `ssh${portArgs} ${target} 'cd ${remotePath} && <command>'`;
}

function addGitInfoExclude(localPath, entry) {
  const excludePath = path.join(localPath, ".git", "info", "exclude");
  if (!fs.existsSync(path.dirname(excludePath))) return;

  const existing = fs.existsSync(excludePath)
    ? fs.readFileSync(excludePath, "utf8")
    : "";
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(entry)) return;

  const prefix = existing.trimEnd();
  const next = `${prefix}${prefix ? "\n" : ""}${entry}\n`;
  fs.writeFileSync(excludePath, next, "utf8");
}

function getDeviceName() {
  return os.hostname();
}

function formatTime(value) {
  if (!value) return "未知时间";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function deactivate() {
  if (localApiServer) {
    await localApiServer.dispose().catch(() => undefined);
    localApiServer = undefined;
  }
}

module.exports = {
  activate,
  deactivate,
  __test: {
    addTarExcludePattern,
    apiTransferSftp,
    createListRemoteDirsSshArgs,
    createRemoteExtractCommand,
    createRemoteTarCommand,
    createRemoteDownloadScript,
    directSyncTarget,
    directSyncRelativePath,
    directSyncCommand,
    guardedRemoteDeleteCommand,
    removeLocalStagingDirectory,
    batchDestinationGuardCommand,
    directTarBatchCommand,
    partitionTransferPaths,
    planLogPathsFromState,
    projectInventoryScript,
    projectTreePathAllowed,
    normalizeDownloadScope,
    normalizeDownloadScopePath,
    relativeRemoteScopePath,
    readTargetDownloadScope,
    writeTargetDownloadScope,
    createAgentsManagedBlock,
    createSshCommandTemplate,
    createWorkspaceTargetName,
    createTransferPreview,
    createTransferController,
    createLocalApiMethods,
    atomicWriteJsonIfMissing,
    migrateLegacyCodeSyncState,
    createManifestUploadPlan,
    createWorkspaceUploadPlan,
    hashUploadPlanChunks,
    classifyTransportFailure,
    isRememberedTransferPath,
    listActiveTransfers,
    refreshConnectTimeoutFromConfig,
    resolveCreateProjectTarget,
    updateWorkspaceTargetCore,
    getSshArgs,
    getSshTarget,
    getManifestUploadRelativePaths,
    getMissingManagedFiles,
    formatSftpTargetSummary,
    getTarExcludeArgs,
    isIgnoredLocalPath,
    isSafeRemoteManagedPath,
    mergeIgnorePatterns,
    patternMatchesPath,
    resolveUploadSftp,
    sanitizeRelativeUploadPath,
    sharedServerCandidateKeys,
    simpleSftpConfigSchema,
    simpleSftpConfigSuffix,
    transferTimeoutMs,
    uploadProgressCancellable,
    validateSimpleSftpConfigValue,
    sanitizeServerProfile,
    toTarPath,
    writeWorkspace,
  },
};
