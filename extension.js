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

const IGNORE_PRESETS = [
  {
    label: "缓存和临时文件",
    description: "cache、tmp、temp、__pycache__",
    patterns: [
      ".ipynb_checkpoints",
      "__pycache__",
      ".pytest_cache",
      ".mypy_cache",
      ".ruff_cache",
      ".cache",
      ".tox",
      "tmp",
      "temp",
      "*cache*",
      "*tmp*",
    ],
    fields: ["cache", "tmp", "temp", "__pycache__"],
  },
  {
    label: "环境和构建产物",
    description: "venv、build、dist、node_modules",
    patterns: [".venv", "venv", "env", "build", "dist", "node_modules"],
    fields: ["venv", "env", "build", "dist", "node_modules"],
  },
  {
    label: "数据集目录",
    description: "data、dataset、VOCdevkit",
    patterns: ["data", "dataset", "datasets", "Datasets", "VOCdevkit"],
    fields: ["data", "dataset", "datasets", "vocdevkit"],
  },
  {
    label: "权重和检查点",
    description: "weights、checkpoints、pretrained",
    patterns: [
      "checkpoints",
      "checkpoint",
      "weights",
      "weight",
      "pretrained",
      "pretrained_ckpt",
      "*.pth",
      "*.pt",
      "*.ckpt",
      "*.onnx",
      "*.engine",
    ],
    fields: ["checkpoint", "checkpoints", "weight", "weights", "pretrained", "ckpt"],
  },
  {
    label: "日志和实验输出",
    description: "runs、logs、outputs、wandb",
    patterns: [
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
      "*.log",
      "*.out",
      "*.err",
      "*.csv",
      "*.tsv",
      "*.xlsx",
      "*.xls",
    ],
    fields: ["run", "runs", "log", "logs", "output", "outputs", "result", "results", "wandb", "tensorboard"],
  },
  {
    label: "压缩包",
    description: "zip、tar、rar、7z",
    patterns: ["*.zip", "*.tar", "*.tar.gz", "*.tgz", "*.rar", "*.7z"],
    fields: ["zip", "tar", "tgz", "rar", "7z"],
  },
  {
    label: "医学图像、普通图像和数组文件",
    description: "nii、dcm、image、numpy",
    patterns: [
      "*.h5",
      "*.hdf5",
      "*.pkl",
      "*.pickle",
      "*.joblib",
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
    ],
    fields: ["nii", "dcm", "image", "img", "mask", "npy", "npz"],
  },
];

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
const SAVE_UPLOAD_STATE = "simple-sftp-upload-state.json";
const TARGET_IGNORE_STATE = "sftp-target-ignores.json";
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
  const configureIgnoresCommand = vscode.commands.registerCommand(
    "simpleSftp.configureIgnores",
    (options) => configureIgnores(options)
  );
  context.subscriptions.push(command, syncCommand, uploadWorkspaceCommand, uploadFilesCommand, handoffCommand, configureIgnoresCommand, selectServerCommand, importSshConfigCommand, openSharedServerConfigCommand, showCurrentTargetCommand);
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
      "$(exclude) 忽略",
      "选择不需要同步的文件、文件夹和规则组。",
      "simpleSftp.configureIgnores",
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
        label: "配置忽略规则",
        description: "选择不参与同步的文件和文件夹",
        icon: "exclude",
        command: "simpleSftp.configureIgnores",
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
  const ignore = Array.isArray(patch.ignore) ? patch.ignore : Array.isArray(existing.ignore) ? existing.ignore : DEFAULT_IGNORES;
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
    const sftp = readSftpConfig(localPath);
    if (!sftp) {
      const message = "当前工作区未找到 .vscode/sftp.json。";
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
    await downloadRemoteToLocal({ localPath, sftp });
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
    if (options.apiMode) {
      return {
        ok: true,
        localPath,
        remotePath: sftp.remotePath,
        downloadedAt: syncStartedAt.toISOString(),
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
    const previousState = manifest && options.pruneManagedFiles !== false
      ? await readRemoteCodeManifest(sftp).catch(() => null)
      : null;
    const previousManifest = previousState && typeof previousState === "object" ? previousState.manifest : null;
    const legacyManagedDir = previousState && typeof previousState === "object" ? previousState.legacyManagedDir : "";
    let uploadStats;
    if (manifest) {
      uploadStats = await uploadManifestLocalFilesToRemote({
        localPath,
        sftp,
        manifest,
        uploadOptions: options,
      });
    } else {
      uploadStats = await uploadAllLocalToRemote({ localPath, sftp, writeState: options.stateFileMode !== "virtual", pathConfirmed: true, options });
    }
    const missingManagedFiles = manifest && options.pruneManagedFiles !== false
      ? getMissingManagedFiles(previousManifest, manifest, sftp.ignore)
      : [];
    const prune = await pruneRemoteMissingManagedFiles(sftp, missingManagedFiles);
    await writeRemoteCodeSyncState(sftp, state, options.manifest);
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

async function uploadManifestLocalFilesToRemote({ localPath, sftp, manifest, uploadOptions = {} }) {
  const uploadPlan = createManifestUploadPlan({ localPath, sftp, manifest });
  if (uploadPlan.fileCount > 0) {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `上传受管理代码文件 -> ${sftp.remotePath}`,
        cancellable: uploadProgressCancellable(uploadOptions),
      },
      (_progress, token) => runLocalTarUpload({
        localPath,
        sftp,
        uploadPlan,
        operation: "上传受管理代码文件",
        timeoutMs: transferTimeoutMs(sftp, uploadOptions),
        token,
        transferId: uploadOptions.transferId,
      })
    );
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
  return withHostOperationLease("upload-files", "上传指定文件", localPath, () => uploadFilesCore(options));
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
    await confirmTransferPath({ localPath: localBase, sftp, operation: "上传指定文件", detail: filesSummary(options.files), options });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-files-"));
    const relativePaths = [];
    const uploadPlanFiles = [];
    for (const item of files) {
      const rawLocalPath = typeof item === "string" ? item : String(item && (item.localPath || item.path) || "");
      const localPath = resolveUploadFilePath(rawLocalPath);
      if (!localPath || !fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
        throw new Error(`本地文件不存在：${localPath || "-"}`);
      }
      const remoteName = sanitizeRelativeUploadPath(typeof item === "string" ? path.basename(localPath) : (item.remoteName || item.relativePath || path.basename(localPath)));
      const targetPath = path.join(tempDir, remoteName);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(localPath, targetPath);
      relativePaths.push(toPosixPath(remoteName));
      uploadPlanFiles.push({ relativePath: toPosixPath(remoteName), fullPath: targetPath, size: fs.statSync(targetPath).size });
    }
    if (options.manifest) {
      const manifestPath = path.join(tempDir, "runtime_manifest.json");
      fs.writeFileSync(manifestPath, `${JSON.stringify(options.manifest, null, 2)}\n`, "utf8");
      relativePaths.push("runtime_manifest.json");
      uploadPlanFiles.push({ relativePath: "runtime_manifest.json", fullPath: manifestPath, size: fs.statSync(manifestPath).size });
    }
    const stats = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `上传指定文件 -> ${sftp.remotePath}`,
        cancellable: uploadProgressCancellable(options),
      },
      (_progress, token) => runLocalTarUpload({
        localPath: tempDir,
        sftp,
        uploadPlan: { files: uploadPlanFiles, fileCount: uploadPlanFiles.length, byteCount: uploadPlanFiles.reduce((total, file) => total + file.size, 0), excludedRuleHits: 0, excludedNestedGitRepos: 0, nestedGitRoots: [] },
        operation: "上传指定文件",
        timeoutMs: transferTimeoutMs(sftp, options),
        token,
        transferId: options.transferId,
      })
    );
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
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
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
  const targetIgnores = readTargetIgnorePatterns(localPath, options, { host, remotePath });
  const ignore = mergeIgnorePatterns(existing.ignore, targetIgnores, options.ignore, server.ignore, DEFAULT_IGNORES);
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
      "    if os.path.isfile(target) or os.path.islink(target):",
      "        os.remove(target); deleted += 1",
      "        parent=os.path.dirname(target)",
      "        while parent.startswith(base + os.sep) and parent != base:",
      "            try: os.rmdir(parent)",
      "            except OSError: break",
      "            parent=os.path.dirname(parent)",
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
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function isSafeRemoteManagedPath(relativePath) {
  const normalized = toPosixPath(relativePath).replace(/^\/+/, "");
  if (!normalized || normalized.includes("..") || path.posix.isAbsolute(normalized)) return false;
  const top = normalized.split("/")[0].toLowerCase();
  if ([".git", ".vscode", "zlk_cluster", "data", "dataset", "datasets", "checkpoints", "checkpoint", "weights", "runs", "work_dirs", "outputs", "output", "results", "logs"].includes(top)) return false;
  if (top === "simple_cluster") return true;
  return !/[\\]|\0/.test(normalized);
}

function sanitizeRelativeUploadPath(value) {
  const normalized = toPosixPath(String(value || "").replace(/^\/+/, ""));
  if (!normalized || normalized.includes("..") || path.posix.isAbsolute(normalized)) {
    throw new Error(`非法远端相对路径：${value}`);
  }
  return normalized;
}

function targetIgnoreStatePath(localPath) {
  return path.join(localPath, "simple_cluster", TARGET_IGNORE_STATE);
}

function targetIgnoreKey(options, sftp) {
  const server = options && typeof options.server === "object" ? options.server : {};
  return String(options.targetId || options.id || server.id || server.label || sftp.name || `${sftp.host}:${sftp.remotePath}`).trim();
}

function legacyTargetIgnoreStatePath(localPath) {
  return path.join(localPath, "zlk_cluster", TARGET_IGNORE_STATE);
}

function readTargetIgnoreState(localPath) {
  for (const file of [targetIgnoreStatePath(localPath), legacyTargetIgnoreStatePath(localPath)]) {
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") {
        if (file === legacyTargetIgnoreStatePath(localPath)) {
          atomicWriteJsonIfMissing(targetIgnoreStatePath(localPath), {
            ...parsed,
            migration: {
              source: `zlk_cluster/${TARGET_IGNORE_STATE}`,
              migratedAt: new Date().toISOString(),
              mode: "copy_read_only_source",
            },
          });
        }
        return parsed;
      }
    } catch {
      // Fall through and try the next managed-state location.
    }
  }
  return {};
}

function readTargetIgnorePatterns(localPath, options, sftp) {
  const state = readTargetIgnoreState(localPath);
  const key = targetIgnoreKey(options || {}, sftp || {});
  const item = state[key];
  return item && Array.isArray(item.ignore) ? item.ignore : [];
}

function writeTargetIgnorePatterns(localPath, options, sftp, ignore) {
  const file = targetIgnoreStatePath(localPath);
  const state = readTargetIgnoreState(localPath);
  const key = targetIgnoreKey(options || {}, sftp || {});
  state[key] = {
    targetId: key,
    host: sftp.host,
    username: sftp.username,
    port: sftp.port,
    remotePath: sftp.remotePath,
    ignore: sortIgnorePatterns(ignore),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state[key];
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

async function configureIgnores(options = {}) {
  const localPath = resolveLocalWorkspacePath(options.localPath, "配置忽略规则");
  return withHostOperationLease("configure-ignores", "扫描或更新忽略规则", localPath, () => configureIgnoresCore(options));
}

async function configureIgnoresCore(options = {}) {
  try {
    const workspaceFolder = getPrimaryWorkspaceFolder();
    const hasTargetOptions = Boolean(options && (options.server || options.remotePath || options.host));
    if (!workspaceFolder) {
      if (!options.localPath) throw new Error("请先打开工作区，或由调用方传入 localPath。");
    }

    const localPath = resolveLocalWorkspacePath(options.localPath, "配置忽略规则");
    const sftpPath = path.join(localPath, ".vscode", "sftp.json");
    const sftp = hasTargetOptions ? resolveUploadSftp(localPath, options) : readSftpConfig(localPath);
    if (!sftp || !sftp.remotePath || !sftp.host) {
      const message = hasTargetOptions ? "未提供可用的 SFTP 目标。" : "当前工作区未找到可用的 .vscode/sftp.json。";
      vscode.window.showErrorMessage(message);
      return { ok: false, error: message };
    }

    await confirmTransferPath({ localPath, sftp, operation: "扫描或更新忽略规则", detail: "远端候选扫描及目标级忽略状态", options });

    const nextIgnores = new Set(Array.isArray(sftp.ignore) ? sftp.ignore : []);
    if (options.apiMode) {
      if (Array.isArray(options.ignore)) {
        nextIgnores.clear();
        for (const pattern of options.ignore) {
          const value = String(pattern || "").trim();
          if (value) nextIgnores.add(value.replace(/\\/g, "/"));
        }
      } else {
        for (const group of [options.patterns, options.add]) {
          for (const pattern of Array.isArray(group) ? group : []) {
            const value = String(pattern || "").trim();
            if (value) nextIgnores.add(value.replace(/\\/g, "/"));
          }
        }
        for (const pattern of Array.isArray(options.remove) ? options.remove : []) {
          const value = String(pattern || "").trim();
          if (value) nextIgnores.delete(value.replace(/\\/g, "/"));
        }
      }
    } else {
      const currentIgnores = new Set(nextIgnores);
      const detectedRemoteItems = await getRemoteIgnoreCandidates(sftp).catch((error) => {
        vscode.window.showWarningMessage(
          `无法扫描远端忽略候选项：${formatError(error)}`
        );
        return [];
      });

      const items = buildIgnoreQuickPickItems(currentIgnores, detectedRemoteItems);
      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        ignoreFocusOut: true,
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: "选择不需要同步的远端文件、文件夹或规则组",
        title: `配置忽略规则：${sftp.remotePath}`,
      });
      if (!selected) return { ok: false, cancelled: true };
      nextIgnores.clear();
      for (const item of selected) {
        if (!item.patterns) continue;
        for (const pattern of item.patterns) {
          nextIgnores.add(pattern);
        }
      }

      const custom = await vscode.window.showInputBox({
        title: "可选：自定义忽略规则",
        prompt: "多个规则用英文逗号分隔；留空则不追加。",
        placeHolder: "示例：*.tmp, debug_outputs, experiments/cache",
        ignoreFocusOut: true,
      });
      if (custom) {
        for (const pattern of custom.split(",")) {
          const value = pattern.trim();
          if (value) nextIgnores.add(value.replace(/\\/g, "/"));
        }
      }
    }

    sftp.ignore = sortIgnorePatterns(nextIgnores);
    if (hasTargetOptions) {
      writeTargetIgnorePatterns(localPath, options, sftp, sftp.ignore);
    } else {
      fs.writeFileSync(sftpPath, `${JSON.stringify(sftp, null, 2)}\n`, "utf8");
    }

    if (!options.apiMode) {
      const action = await vscode.window.showInformationMessage(
        `已更新 SFTP 忽略规则：${sftp.ignore.length} 条。`,
        hasTargetOptions ? "打开目标忽略状态" : "打开 sftp.json"
      );
      if (action === "打开 sftp.json") {
        await openWorkspaceRelativeFile(".vscode/sftp.json");
      }
      if (action === "打开目标忽略状态") {
        await openWorkspaceRelativeFile(`simple_cluster/${TARGET_IGNORE_STATE}`);
      }
    }
    const legacyManagedDir = path.join(localPath, "zlk_cluster");
    if (fs.existsSync(legacyManagedDir) && !options.apiMode) {
      void vscode.window.showWarningMessage(`检测到旧版托管目录 ${legacyManagedDir}；新状态已写入 simple_cluster。请人工核对后手动删除。`);
    }
    return { ok: true, targetId: targetIgnoreKey(options, sftp), remotePath: sftp.remotePath, ignore: sftp.ignore };
  } catch (error) {
    if (options.apiMode) throw error;
    const message = `配置忽略规则失败：${formatError(error)}`;
    vscode.window.showErrorMessage(message);
    return { ok: false, error: message };
  }
}

async function pickRemoteDirectory({ remoteBase, sftp }) {
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
      if (current === remoteBase.replace(/\/+$/, "") && HIDDEN_TOP_LEVEL.has(dir)) {
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
      title: "选择远端项目根目录",
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
    "transfers.list": async () => {
      return { ok: true, transfers: listActiveTransfers() };
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
    "ignores.configure": async (params = {}) => {
      const localPath = String(params.localPath || "").trim();
      const sftp = apiTransferSftp(params);
      requireApiConfirmation(params, {
        method: "ignores.configure",
        operation: "配置 SFTP 忽略规则",
        sftp,
        localPath,
        pathRequired: true,
      });
      const result = await configureIgnores({ ...params, apiMode: true });
      publishLocalApiEvent("ignores.configure", {
        targetId: result && result.targetId,
        remotePath: result && result.remotePath,
        ignore: result && result.ignore,
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

async function getRemoteIgnoreCandidates(sftp) {
  const cfg = vscode.workspace.getConfiguration("simpleSftp");
  const thresholdMB = Number(cfg.get("largeFileThresholdMB") || 50);
  const thresholdBytes = Math.max(1, thresholdMB) * 1024 * 1024;
  const remotePath = String(sftp.remotePath).replace(/\/+$/, "");
  const command = [
    "find",
    shellQuote(remotePath),
    "-mindepth 1 -maxdepth 2",
    "\\( -name .git -o -name .vscode \\) -prune -o",
    "\\( -type d -o -type f \\)",
    "-printf '%P\\t%y\\t%s\\n'",
    "2>/dev/null | head -n 1200",
  ].join(" ");
  const stdout = await runSsh(sftp, command, 30000);
  const seen = new Map();

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [relativePath, type, sizeText] = line.split("\t");
    if (!relativePath || !type) continue;

    const normalizedPath = relativePath.replace(/\\/g, "/").replace(/\/+$/, "");
    const sizeBytes = Number(sizeText) || 0;
    const reason = getRemoteIgnoreReason(normalizedPath, type, sizeBytes, thresholdBytes);
    if (!reason) continue;

    seen.set(normalizedPath, {
      pattern: normalizedPath,
      relativePath: normalizedPath,
      reason,
      sizeBytes,
      type,
    });
  }

  return Array.from(seen.values()).sort((a, b) => {
    const reasonCompare = a.reason.localeCompare(b.reason);
    if (reasonCompare !== 0) return reasonCompare;
    return a.relativePath.localeCompare(b.relativePath);
  });
}

function getRemoteIgnoreReason(relativePath, type, sizeBytes, thresholdBytes) {
  if (type === "f" && sizeBytes >= thresholdBytes) {
    return `大文件 ${formatBytes(sizeBytes)}`;
  }

  const lowerPath = relativePath.toLowerCase();
  for (const preset of IGNORE_PRESETS) {
    if (preset.fields.some((field) => fieldMatchesPath(lowerPath, field))) {
      return preset.label;
    }
    if (preset.patterns.some((pattern) => patternMatchesPath(lowerPath, pattern))) {
      return preset.label;
    }
  }

  return null;
}

function fieldMatchesPath(lowerPath, field) {
  const normalizedField = String(field).toLowerCase();
  const tokens = lowerPath.split(/[\/._\-\s]+/).filter(Boolean);
  const exactOnly = new Set(["data", "dataset", "datasets", "env", "log", "logs", "run", "runs"]);
  if (exactOnly.has(normalizedField)) {
    return tokens.includes(normalizedField);
  }
  return tokens.some((token) => token.includes(normalizedField));
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

function buildIgnoreQuickPickItems(currentIgnores, detectedRemoteItems) {
  const knownPatterns = new Set();
  const items = [
    {
      label: "推荐规则组",
      kind: vscode.QuickPickItemKind.Separator,
    },
  ];

  for (const preset of IGNORE_PRESETS) {
    for (const pattern of preset.patterns) knownPatterns.add(pattern);
    items.push({
      label: preset.label,
      description: preset.description,
      detail: preset.patterns.join(", "),
      picked:
        currentIgnores.size === 0 ||
        preset.patterns.some((pattern) => currentIgnores.has(pattern)),
      patterns: preset.patterns,
    });
  }

  if (detectedRemoteItems.length > 0) {
    items.push({
      label: "已识别的远端候选项",
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const candidate of detectedRemoteItems) {
      knownPatterns.add(candidate.pattern);
      items.push({
        label: candidate.relativePath,
        description: candidate.reason,
        detail: candidate.type === "f" ? `远端文件，${formatBytes(candidate.sizeBytes)}` : "远端文件夹",
        picked: true,
        patterns: [candidate.pattern],
      });
    }
  }

  const customPatterns = Array.from(currentIgnores)
    .filter((pattern) => !knownPatterns.has(pattern))
    .sort((a, b) => a.localeCompare(b));
  if (customPatterns.length > 0) {
    items.push({
      label: "已有自定义规则",
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const pattern of customPatterns) {
      items.push({
        label: pattern,
        description: "已有忽略规则",
        picked: true,
        patterns: [pattern],
      });
    }
  }

  return items;
}

function sortIgnorePatterns(patterns) {
  const ordered = new Map();
  for (const pattern of DEFAULT_IGNORES) {
    if (!ordered.has(pattern)) ordered.set(pattern, ordered.size);
  }
  for (const preset of IGNORE_PRESETS) {
    for (const pattern of preset.patterns) {
      if (!ordered.has(pattern)) ordered.set(pattern, ordered.size);
    }
  }

  return Array.from(patterns).sort((a, b) => {
    const aOrder = ordered.has(a) ? ordered.get(a) : Number.MAX_SAFE_INTEGER;
    const bOrder = ordered.has(b) ? ordered.get(b) : Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.localeCompare(b);
  });
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
        reject(classifyTransportFailure(failure, {
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
  const stats = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `上传全部本地文件 -> ${sftp.remotePath}`,
      cancellable: uploadProgressCancellable(options),
    },
    (_progress, token) => runLocalTarUpload({
      localPath,
      sftp,
      uploadPlan,
      operation: "上传全部文件",
      timeoutMs: transferTimeoutMs(sftp, options),
      token,
      transferId: options.transferId,
    })
  );
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

function createManifestUploadPlan({ localPath, sftp, manifest }) {
  const relativePaths = getManifestUploadRelativePaths({ localPath, sftp, manifest });
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
      sshProc.kill();
      reject(classifyTransportFailure(error, {
        command: remoteCommand,
        sshStderr,
        tarStderr,
      }));
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
        reject(classifyTransportFailure(failure, {
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

async function downloadRemoteToLocal({ localPath, sftp }) {
  return withHostOperationLease("download-workspace", "下载远端工作区", localPath, () => downloadRemoteToLocalCore({ localPath, sftp }));
}

async function downloadRemoteToLocalCore({ localPath, sftp }) {
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
      timeoutMs: transferTimeoutMs(sftp),
      token,
    })
  );
}

function runRemoteTarExtract({ localPath, sftp, timeoutMs, token, transferId }) {
  const remoteCommand = createRemoteTarCommand(sftp);
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
      sshProc.kill();
      tarProc.kill();
      reject(classifyTransportFailure(error, {
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
        reject(classifyTransportFailure(failure, {
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

function createRemoteTarCommand(sftp) {
  const remotePath = String(sftp.remotePath).replace(/\/+$/, "");
  const args = [
    "tar",
    "-cf",
    "-",
    ...getTarExcludeArgs(sftp.ignore),
    ".",
  ];
  return `cd ${shellQuote(remotePath)} && ${args.map(shellQuote).join(" ")}`;
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
  const details = [
    `ssh 退出码：${sshCode}`,
    `tar 退出码：${tarCode}`,
    sshStderr.trim() ? `ssh: ${sshStderr.trim()}` : "",
    tarStderr.trim() ? `tar: ${tarStderr.trim()}` : "",
  ].filter(Boolean);
  return `${operation || "SFTP 传输"}失败。${details.join(" | ")}`;
}

function classifyTransportFailure(error, context = {}) {
  const source = error instanceof Error ? error : new Error(String(error || "传输失败"));
  const combined = [
    source.message,
    source.stderr || "",
    String(context.sshStderr || ""),
    String(context.tarStderr || ""),
    String(context.command || ""),
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
  if (/传输超过|simple-sftp timeout|timeout|timed out/.test(combined)) {
    classified.category = "transfer_timeout";
    classified.retryable = true;
    classified.diagnosis = "传输超过配置的超时时间；检查网络、目标负载或增大超时。";
    return classified;
  }
  if (/permission denied \(publickey|authentication failed|host key verification failed|invalid format\)/.test(combined)) {
    classified.category = "ssh_auth_failed";
    classified.retryable = false;
    classified.diagnosis = "SSH 认证、密钥或 host key 验证失败；先用同一 alias 手动连接验证。";
    return classified;
  }
  if (/econnrefused|connection refused|local forward|forwarding failed|channel .* not opened/.test(combined)) {
    classified.category = "local_forward_unavailable";
    classified.retryable = true;
    classified.diagnosis = "本机转发端口未建立或目标 Agent/SSH 服务不可达。";
    return classified;
  }
  if (/enotfound|no such host|name or service not known|temporary failure in name resolution|network is unreachable|connection timed out|no route to host/.test(combined)) {
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
    legacyTargetIgnoreStatePath,
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
    sortIgnorePatterns,
    toTarPath,
    writeWorkspace,
  },
};
