const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");
const APPDATA = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const SHARED_SERVER_DIR = path.join(APPDATA, "SimpleSFTP", "server-profiles");
const SHARED_SERVER_FILE = path.join(SHARED_SERVER_DIR, "servers.json");
const LEGACY_SHARED_SERVER_FILE = path.join(APPDATA, "ZLK", "server-profiles", "servers.json");

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
const SAVE_UPLOAD_STATE = "simple-sftp-upload-state.json";
const TARGET_IGNORE_STATE = "sftp-target-ignores.json";
let serverStatusButton;
let sharedWatcher;

function activate(context) {
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
  void maybePromptForHandoff();
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
  const imported = readProfilesFromSshConfig();
  const data = readSharedServers();
  const byId = new Map(data.servers.map((item) => [item.id, item]));
  for (const item of imported) byId.set(item.id, { ...byId.get(item.id), ...item, enabled: true });
  const next = { ...data, servers: [...byId.values()] };
  if (!next.activeServerId && next.servers[0]) next.activeServerId = next.servers[0].id;
  writeSharedServers(next);
  updateServerStatusButton();
  vscode.window.showInformationMessage(`已导入 ${imported.length} 个 SSH 配置。`);
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

    const remotePath = await pickRemoteDirectory({ remoteBase: target.remoteBase, sftp: target.sftp });
    if (!remotePath) return;

    const projectName = path.posix.basename(remotePath);
    const localPath = path.join(target.localBase, projectName);
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

async function showCurrentTarget() {
  const workspaceFolder = getPrimaryWorkspaceFolder();
  if (!workspaceFolder) {
    vscode.window.showInformationMessage("当前未打开工作区。");
    return null;
  }
  const localPath = workspaceFolder.uri.fsPath;
  const sftp = readSftpConfig(localPath);
  if (!sftp || !sftp.remotePath || !sftp.host) {
    vscode.window.showInformationMessage("当前工作区没有可用的 .vscode/sftp.json 目标。");
    return null;
  }
  const summary = formatSftpTargetSummary(localPath, sftp);
  const action = await vscode.window.showInformationMessage(summary, "打开 sftp.json");
  if (action === "打开 sftp.json") {
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(localPath, ".vscode", "sftp.json")));
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

async function maybePromptForHandoff() {
  const cfg = vscode.workspace.getConfiguration("simpleSftp");
  if (!cfg.get("handoffPrompt")) return;

  const workspaceFolder = getPrimaryWorkspaceFolder();
  if (!workspaceFolder) return;

  const localPath = workspaceFolder.uri.fsPath;
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
  try {
    const workspaceFolder = getPrimaryWorkspaceFolder();
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("请先打开 SimpleSFTP 工作区。");
      return;
    }

    const localPath = workspaceFolder.uri.fsPath;
    const sftp = readSftpConfig(localPath);
    if (!sftp) {
      vscode.window.showErrorMessage("当前工作区未找到 .vscode/sftp.json。");
      return;
    }

    const cfg = vscode.workspace.getConfiguration("simpleSftp");
    const markerName = cfg.get("handoffMarkerName") || DEFAULT_HANDOFF_MARKER;
    const marker = await readRemoteHandoffMarker(sftp, markerName).catch(() => null);
    if (options.confirmMarker !== false && marker) {
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
    vscode.window.showInformationMessage("SimpleSFTP 已完成远端到本地同步。");
  } catch (error) {
    vscode.window.showErrorMessage(`启动远端到本地同步失败：${formatError(error)}`);
  }
}

async function markHandoffReady() {
  try {
    const workspaceFolder = getPrimaryWorkspaceFolder();
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("请先打开 SimpleSFTP 工作区。");
      return;
    }

    const localPath = workspaceFolder.uri.fsPath;
    const sftp = readSftpConfig(localPath);
    if (!sftp || !sftp.remotePath || !sftp.host) {
      vscode.window.showErrorMessage("当前工作区没有可用的 .vscode/sftp.json。");
      return;
    }

    const action = await vscode.window.showInformationMessage(
      "是否先上传全部本地代码，再把该项目标记为可交接到下一台设备？",
      "上传全部并标记",
      "仅标记",
      "取消"
    );
    if (!action || action === "取消") return;

    if (action === "上传全部并标记") {
      await uploadAllLocalToRemote({ localPath, sftp });
    }

    const marker = {
      version: 1,
      project: path.posix.basename(String(sftp.remotePath).replace(/\/+$/, "")),
      remotePath: sftp.remotePath,
      localPath,
      device: getDeviceName(),
      user: os.userInfo().username,
      markedAt: new Date().toISOString(),
      uploadRequested: action === "上传全部并标记",
      uploadMode: action === "上传全部并标记" ? "all" : "none",
    };

    const cfg = vscode.workspace.getConfiguration("simpleSftp");
    const markerName = cfg.get("handoffMarkerName") || DEFAULT_HANDOFF_MARKER;
    await writeRemoteHandoffMarker(sftp, markerName, marker);
    writeLocalSessionRecord(localPath, {
      action: "handoffReady",
      ...marker,
    });

    vscode.window.showInformationMessage(
      `SimpleSFTP 已由 ${marker.device} 写入交接标记。`
    );
  } catch (error) {
    vscode.window.showErrorMessage(`写入交接标记失败：${formatError(error)}`);
  }
}

async function uploadWorkspace(options = {}) {
  try {
    const workspaceFolder = getPrimaryWorkspaceFolder();
    const localPath = String(options.localPath || (workspaceFolder && workspaceFolder.uri.fsPath) || "");
    if (!localPath) throw new Error("请先打开工作区，或传入 localPath。");
    const sftp = resolveUploadSftp(localPath, options);
    if (!sftp || !sftp.remotePath || !sftp.host) {
      throw new Error("未提供可用的 SFTP 目标。");
    }
    const state = createCodeSyncState(sftp, options);
    const manifest = getManagedManifest(options.manifest);
    const previousManifest = manifest && options.pruneManagedFiles !== false
      ? await readRemoteCodeManifest(sftp).catch(() => null)
      : null;
    if (manifest) {
      await uploadManifestLocalFilesToRemote({
        localPath,
        sftp,
        manifest,
      });
    } else {
      await uploadAllLocalToRemote({ localPath, sftp, writeState: options.stateFileMode !== "virtual" });
    }
    const missingManagedFiles = manifest && options.pruneManagedFiles !== false
      ? getMissingManagedFiles(previousManifest, manifest, sftp.ignore)
      : [];
    const prune = await pruneRemoteMissingManagedFiles(sftp, missingManagedFiles);
    await writeRemoteCodeSyncState(sftp, state, options.manifest);
    if (options.stateFileMode !== "virtual") {
      writeLocalCodeSyncState(localPath, state);
    }
    return {
      ok: true,
      targetId: options.targetId || options.id || sftp.name || sftp.host,
      remotePath: sftp.remotePath,
      fingerprint: state.fingerprint,
      uploadedAt: state.updatedAt,
      deletedRemoteFiles: prune.deleted,
    };
  } catch (error) {
    const message = `上传工作区失败：${formatError(error)}`;
    vscode.window.showErrorMessage(message);
    return { ok: false, error: message };
  }
}

async function uploadManifestLocalFilesToRemote({ localPath, sftp, manifest }) {
  const relativePaths = getManifestUploadRelativePaths({ localPath, sftp, manifest });
  if (relativePaths.length > 0) {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `上传受管理代码文件 -> ${sftp.remotePath}`,
        cancellable: false,
      },
      () => runLocalTarUpload({
        localPath,
        sftp,
        relativePaths,
        operation: "上传受管理代码文件",
      })
    );
  }
}

async function uploadFiles(options = {}) {
  let tempDir = "";
  try {
    const workspaceFolder = getPrimaryWorkspaceFolder();
    const localBase = String(options.localBase || options.localPath || (workspaceFolder && workspaceFolder.uri.fsPath) || "");
    if (!localBase) throw new Error("请先打开工作区，或传入 localBase。");
    const sftp = resolveUploadSftp(localBase, options);
    if (!sftp || !sftp.remotePath || !sftp.host) throw new Error("没有可用的 SFTP 上传目标。");
    const files = Array.isArray(options.files) ? options.files : [];
    if (!files.length && !options.manifest) throw new Error("没有要上传的文件。");
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-files-"));
    const relativePaths = [];
    for (const item of files) {
      const localPath = typeof item === "string" ? item : String(item && (item.localPath || item.path) || "");
      if (!localPath || !fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
        throw new Error(`本地文件不存在：${localPath || "-"}`);
      }
      const remoteName = sanitizeRelativeUploadPath(typeof item === "string" ? path.basename(localPath) : (item.remoteName || item.relativePath || path.basename(localPath)));
      const targetPath = path.join(tempDir, remoteName);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(localPath, targetPath);
      relativePaths.push(toPosixPath(remoteName));
    }
    if (options.manifest) {
      const manifestPath = path.join(tempDir, "runtime_manifest.json");
      fs.writeFileSync(manifestPath, `${JSON.stringify(options.manifest, null, 2)}\n`, "utf8");
      relativePaths.push("runtime_manifest.json");
    }
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `上传指定文件 -> ${sftp.remotePath}`,
        cancellable: false,
      },
      () => runLocalTarUpload({
        localPath: tempDir,
        sftp,
        relativePaths,
        operation: "上传指定文件",
      })
    );
    return {
      ok: true,
      targetId: options.targetId || options.id || sftp.name || sftp.host,
      remotePath: sftp.remotePath,
      files: relativePaths,
      uploadedAt: new Date().toISOString(),
    };
  } catch (error) {
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
    sharedServer.transferHost,
    sharedServer.resolvedHost,
    sharedServer.sftpHost,
    sharedServer.sshHost,
    sharedServer.host,
    incomingServer.sftpHost,
    incomingServer.sshHost,
    options.sftpHost,
    options.sshHost,
    incomingServer.host,
    options.host,
    incomingServer.sshConfigHost,
    incomingServer.sshConfigAlias,
    options.sshConfigHost,
    options.sshConfigAlias,
    existing.host
  );
  const user = String(server.user || server.username || options.user || options.username || existing.username || "").trim();
  const remotePath = String(server.remotePath || options.remotePath || existing.remotePath || "").replace(/\/+$/, "");
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
    ignore,
  };
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
  return data.servers.find((item) => {
    if (!item) return false;
    const keys = sharedServerCandidateKeys(item, item);
    return keys.some((key) => candidates.includes(key));
  }) || {};
}

function sharedServerCandidateKeys(options, server) {
  const raw = [
    options && options.targetId,
    options && options.id,
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
  const dir = path.join(localPath, "zlk_cluster");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "code_sync_state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
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
      "    if not rel or rel.startswith('../') or '/../' in rel or rel.startswith('zlk_cluster/'):",
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
  for (const key of Object.keys(managedManifest).sort((a, b) => a.localeCompare(b))) {
    const relativePath = sanitizeRelativeUploadPath(key);
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
  const manifestPath = `${String(sftp.remotePath).replace(/\/+$/, "")}/zlk_cluster/code_sync_manifest.json`;
  const stdout = await runSsh(sftp, `if [ -f ${shellQuote(manifestPath)} ]; then cat ${shellQuote(manifestPath)}; fi`, 20000);
  const text = String(stdout || "").trim();
  return text ? JSON.parse(text) : null;
}

async function writeRemoteCodeSyncState(sftp, state, manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zlk-code-sync-state-"));
  try {
    const stateDir = path.join(tempDir, "zlk_cluster");
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
      relativePaths: ["zlk_cluster/code_sync_state.json", "zlk_cluster/code_sync_manifest.json"],
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
  return path.join(localPath, "zlk_cluster", TARGET_IGNORE_STATE);
}

function targetIgnoreKey(options, sftp) {
  const server = options && typeof options.server === "object" ? options.server : {};
  return String(options.targetId || options.id || server.id || server.label || sftp.name || `${sftp.host}:${sftp.remotePath}`).trim();
}

function readTargetIgnoreState(localPath) {
  const file = targetIgnoreStatePath(localPath);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
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
  try {
    const workspaceFolder = getPrimaryWorkspaceFolder();
    const hasTargetOptions = Boolean(options && (options.server || options.remotePath || options.host));
    if (!workspaceFolder) {
      if (!options.localPath) throw new Error("请先打开工作区，或由调用方传入 localPath。");
    }

    const localPath = String(options.localPath || (workspaceFolder && workspaceFolder.uri.fsPath) || "");
    const sftpPath = path.join(localPath, ".vscode", "sftp.json");
    const sftp = hasTargetOptions ? resolveUploadSftp(localPath, options) : readSftpConfig(localPath);
    if (!sftp || !sftp.remotePath || !sftp.host) {
      const message = hasTargetOptions ? "未提供可用的 SFTP 目标。" : "当前工作区未找到可用的 .vscode/sftp.json。";
      vscode.window.showErrorMessage(message);
      return { ok: false, error: message };
    }

    const currentIgnores = new Set(Array.isArray(sftp.ignore) ? sftp.ignore : []);
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

    const nextIgnores = new Set();
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

    sftp.ignore = sortIgnorePatterns(nextIgnores);
    if (hasTargetOptions) {
      writeTargetIgnorePatterns(localPath, options, sftp, sftp.ignore);
    } else {
      fs.writeFileSync(sftpPath, `${JSON.stringify(sftp, null, 2)}\n`, "utf8");
    }

    const action = await vscode.window.showInformationMessage(
      `已更新 SFTP 忽略规则：${sftp.ignore.length} 条。`,
      hasTargetOptions ? "打开目标忽略状态" : "打开 sftp.json"
    );
    if (action === "打开 sftp.json") {
      await vscode.window.showTextDocument(vscode.Uri.file(sftpPath));
    }
    if (action === "打开目标忽略状态") {
      await vscode.window.showTextDocument(vscode.Uri.file(targetIgnoreStatePath(localPath)));
    }
    return { ok: true, targetId: targetIgnoreKey(options, sftp), remotePath: sftp.remotePath, ignore: sftp.ignore };
  } catch (error) {
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
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function handleSavedDocument(document) {
  if (!document || document.uri.scheme !== "file") return;

  const cfg = vscode.workspace.getConfiguration("simpleSftp");
  if (!cfg.get("uploadOnSave")) return;

  const workspaceFolder = getWorkspaceFolderForFile(document.uri.fsPath);
  if (!workspaceFolder) return;

  const localPath = workspaceFolder.uri.fsPath;
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
  const scanStartedAt = new Date();
  const changedFiles = findChangedLocalFiles({ localPath, sftp });
  if (changedFiles.length === 0) {
    vscode.window.setStatusBarMessage("SimpleSFTP：没有需要上传的变更文件", 2500);
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `SimpleSFTP 正在上传 ${changedFiles.length} 个变更文件`,
      cancellable: false,
    },
    () => runLocalTarUpload({
      localPath,
      sftp,
      relativePaths: changedFiles,
      operation: "上传变更文件",
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

async function uploadAllLocalToRemote({ localPath, sftp, writeState = true }) {
  if (!sftp || !sftp.remotePath || !sftp.host) {
    throw new Error("未配置可用的 SFTP 远端路径。");
  }

  const uploadStartedAt = new Date();
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `上传全部本地文件 -> ${sftp.remotePath}`,
      cancellable: false,
    },
    () => runLocalTarUpload({
      localPath,
      sftp,
      relativePaths: null,
      operation: "上传全部文件",
    })
  );
  if (writeState) {
    writeUploadState(localPath, {
      lastUploadedAt: uploadStartedAt.toISOString(),
      mode: "all",
      remotePath: sftp.remotePath,
    });
  }
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

function walkLocalFiles(rootPath, relativeDir, ignorePatterns, visitFile) {
  const currentDir = relativeDir ? path.join(rootPath, relativeDir) : rootPath;
  let entries = [];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const relativePath = toPosixPath(relativeDir ? path.join(relativeDir, entry.name) : entry.name);
    if (isIgnoredLocalPath(relativePath, ignorePatterns)) continue;

    const fullPath = path.join(rootPath, relativePath);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walkLocalFiles(rootPath, relativePath, ignorePatterns, visitFile);
      continue;
    }
    if (entry.isFile()) {
      visitFile(relativePath, fullPath);
    }
  }
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
    const localPath = folder.uri.fsPath;
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
  const normalizedFile = path.resolve(filePath).toLowerCase();
  return folders
    .map((folder) => ({
      folder,
      normalizedPath: path.resolve(folder.uri.fsPath).toLowerCase(),
    }))
    .filter(({ normalizedPath }) => (
      normalizedFile === normalizedPath ||
      normalizedFile.startsWith(`${normalizedPath}${path.sep}`)
    ))
    .sort((a, b) => b.normalizedPath.length - a.normalizedPath.length)
    .map(({ folder }) => folder)[0] || null;
}

function runLocalTarUpload({ localPath, sftp, relativePaths, operation }) {
  const remoteCommand = createRemoteExtractCommand(sftp.remotePath);
  const tarArgs = createLocalTarArgs(sftp, relativePaths);
  return new Promise((resolve, reject) => {
    const tarProc = spawn("tar", tarArgs, {
      cwd: localPath,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const sshProc = spawn("ssh", getSshArgs(sftp, remoteCommand), {
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
    });

    let settled = false;
    let tarCode;
    let sshCode;
    let tarStderr = "";
    let sshStderr = "";

    const fail = (error) => {
      if (settled) return;
      settled = true;
      tarProc.kill();
      sshProc.kill();
      reject(error);
    };

    const finish = () => {
      if (settled || tarCode === undefined || sshCode === undefined) return;
      settled = true;
      if (tarCode !== 0 || sshCode !== 0) {
        reject(new Error(formatProcessFailure({
          operation,
          tarCode,
          sshCode,
          tarStderr,
          sshStderr,
        })));
        return;
      }
      resolve();
    };

    tarProc.on("error", fail);
    sshProc.on("error", fail);
    tarProc.stderr.on("data", (chunk) => {
      tarStderr = appendProcessOutput(tarStderr, chunk);
    });
    sshProc.stderr.on("data", (chunk) => {
      sshStderr = appendProcessOutput(sshStderr, chunk);
    });
    sshProc.stdin.on("error", () => {});

    tarProc.stdout.pipe(sshProc.stdin);
    tarProc.on("close", (code, signal) => {
      tarCode = code === null ? `signal ${signal || "unknown"}` : code;
      finish();
    });
    sshProc.on("close", (code, signal) => {
      sshCode = code === null ? `signal ${signal || "unknown"}` : code;
      finish();
    });
  });
}

function createLocalTarArgs(sftp, relativePaths) {
  if (Array.isArray(relativePaths) && relativePaths.length > 0) {
    return ["-cf", "-", "--", ...relativePaths.map(toTarPath)];
  }
  return ["-cf", "-", ...getTarExcludeArgs(sftp.ignore), "."];
}

function createRemoteExtractCommand(remotePath) {
  const safeRemotePath = String(remotePath).replace(/\/+$/, "");
  return `mkdir -p ${shellQuote(safeRemotePath)} && tar -xf - -C ${shellQuote(safeRemotePath)}`;
}

async function downloadRemoteToLocal({ localPath, sftp }) {
  if (!sftp || !sftp.remotePath || !sftp.host) {
    throw new Error("未配置可用的 SFTP 远端路径。");
  }

  fs.mkdirSync(localPath, { recursive: true });
  const title = `正在同步远端到本地：${sftp.remotePath} -> ${localPath}`;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false,
    },
    () => runRemoteTarExtract({ localPath, sftp })
  );
}

function runRemoteTarExtract({ localPath, sftp }) {
  const remoteCommand = createRemoteTarCommand(sftp);
  return new Promise((resolve, reject) => {
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

    const fail = (error) => {
      if (settled) return;
      settled = true;
      sshProc.kill();
      tarProc.kill();
      reject(error);
    };

    const finish = () => {
      if (settled || sshCode === undefined || tarCode === undefined) return;
      settled = true;
      if (sshCode !== 0 || tarCode !== 0) {
        reject(new Error(formatProcessFailure({
          operation: "远端到本地同步",
          sshCode,
          tarCode,
          sshStderr,
          tarStderr,
        })));
        return;
      }
      resolve();
    };

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

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  __test: {
    addTarExcludePattern,
    createLocalTarArgs,
    createListRemoteDirsSshArgs,
    createRemoteExtractCommand,
    createRemoteTarCommand,
    createAgentsManagedBlock,
    createSshCommandTemplate,
    createWorkspaceTargetName,
    resolveCreateProjectTarget,
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
    sortIgnorePatterns,
    toTarPath,
    writeWorkspace,
  },
};
