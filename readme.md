# SimpleSFTP

`SimpleSFTP` 是一个本地 VS Code 扩展，用于在 Windows 本地编辑项目，并通过系统 `ssh`、`tar` 与远端 Linux 项目目录同步。当前版本为 `0.2.0`。

## 最新功能

- 创建本地 SFTP 工作区：从远端目录选择项目，在本地生成项目目录和 `.vscode/sftp.json`。
- 支持共享服务器配置：服务器配置保存在 `%APPDATA%\SimpleSFTP\server-profiles\servers.json`，可从 `%USERPROFILE%\.ssh\config` 导入；旧位置会自动迁移。
- SSH 信息以用户配置为准：支持 `host`、`user`、`port`、`sshConfigHost`，不会在同步流程中写死服务器地址。
- 支持非 22 SSH 端口：目录浏览、上传、下载、状态显示和 `AGENTS.md` 命令模板都会使用同一端口。
- 远端到本地同步：通过远端 `tar` 打包、本地 `tar` 解包，按 ignore 规则排除大型文件、数据集、缓存、日志、权重等。
- 本地到远端上传：支持全量上传、保存时上传变更文件、手动上传指定文件。
- 设备交接：通过远端 `.simple-sftp-handoff.json` 标记当前设备已上传，另一台设备打开项目时可提示先同步。
- 可视化 ignore 配置：扫描远端文件和目录，推荐缓存、数据集、权重、日志、输出等 ignore 规则。
- 目标级 ignore：编排器传入目标时，ignore 可写入 `zlk_cluster/sftp-target-ignores.json`，不同 Hub/Worker 目标可独立保护。
- 编排器 manifest 同步：支持 `SimpleExperiment` 调用 `uploadWorkspace` 分发代码，并用 manifest 控制上传文件和远端 prune。
- 只读目标查看：`SimpleSFTP：查看当前目标` 可显示当前本地目录、远端路径、SSH host、user 和 port。
- Dev Container 兼容：插件运行于 Windows UI Extension Host 时，将 `/workspaces/<项目>` 映射为 `D:\GitRepo\<项目>`；文件上传、下载、忽略扫描和本地状态写入均使用宿主路径，编辑器仍使用原远程 URI。
- 文件位置强确认：每次上传、下载、交接、忽略扫描或创建同步工作区前，都会显示本地宿主路径、远端预期路径和文件范围；用户可选择“此后该路径不再提醒”。
- 本机 AI API：通过 `127.0.0.1` 暴露 JSON-RPC 2.0 HTTP 接口和 `simple-sftp-api` CLI，支持参数化完成服务器、项目和上传下载操作，并保留确认门禁。
- VS Code UI：状态栏按钮、Explorer 侧边栏视图和命令面板命令均可用。

## 命令

| 命令 | 功能 |
| --- | --- |
| `SimpleSFTP：创建或打开远端项目` | 选择远端项目目录，创建本地工作区。 |
| `SimpleSFTP：远端同步到本地` | 从远端同步到本地。 |
| `SimpleSFTP：上传工作区到目标` | 上传整个工作区或 manifest 指定的代码文件。 |
| `SimpleSFTP：上传指定文件到目标` | 上传调用方传入的指定文件。 |
| `SimpleSFTP：上传并标记交接` | 上传并写入远端交接标记。 |
| `SimpleSFTP：配置忽略规则` | 配置本地或目标级 ignore 规则。 |
| `SimpleSFTP：选择服务器` | 选择共享服务器配置。 |
| `SimpleSFTP：导入 VS Code SSH 配置` | 从 `~/.ssh/config` 导入 SSH 配置。 |
| `SimpleSFTP：打开共享服务器配置` | 打开共享服务器配置文件。 |
| `SimpleSFTP：查看当前目标` | 查看当前工作区 SFTP 目标。 |

## 配置项

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `simpleSftp.workspaceHostRoot` | 空 | Dev Container 工作区对应的 Windows 宿主根目录，例如 `D:\GitRepo`；普通 Windows 工作区无需配置。 |
| `simpleSftp.workspaceContainerRoot` | 空 | Dev Container 工作区根目录，例如 `/workspaces`；远程工作区必须与宿主根同时配置。 |
| `simpleSftp.remoteBase` | 空 | 默认远端项目根目录。 |
| `simpleSftp.localBase` | 空 | 默认本地项目根目录。 |
| `simpleSftp.sshHost` | 空 | SSH host alias，用于目录浏览和同步。 |
| `simpleSftp.execHost` | 空 | 写入 `AGENTS.md` 命令模板的执行 host。 |
| `simpleSftp.userName` | 空 | 默认 SSH 用户名。 |
| `simpleSftp.sshPort` | `22` | 默认 SSH 端口。 |
| `simpleSftp.handoffPrompt` | `true` | 打开工作区时是否检查远端交接标记。 |
| `simpleSftp.handoffMarkerName` | `.simple-sftp-handoff.json` | 远端交接标记文件名。 |
| `simpleSftp.uploadOnSave` | `true` | 保存文件时是否自动上传本地变更。 |
| `simpleSftp.writeAgentsFile` | `true` | 创建工作区时是否写入 `AGENTS.md` 管理块。 |
| `simpleSftp.largeFileThresholdMB` | `50` | 扫描远端 ignore 候选时的大文件阈值。 |

共享服务器优先级高于 VS Code 默认配置。创建项目时目标解析顺序为：当前 active shared server、命令参数或已有配置、VS Code setting 默认值。

## 工作区文件

- `.vscode/sftp.json`：本扩展使用的同步目标配置，包含 `host`、`username`、`port`、`remotePath` 和 ignore 规则。
- `.vscode/simple-sftp-session.json`：记录最近一次同步、上传或交接状态。
- `.vscode/simple-sftp-upload-state.json`：记录保存时上传的基准时间。
- `AGENTS.md`：本地 agent 使用说明，只更新 `SimpleSFTP` 管理块。
- `.git/info/exclude`：创建工作区时自动加入 `AGENTS.md`，避免误提交本地协作说明。
- 远端 `.simple-sftp-handoff.json`：设备交接标记。
- `zlk_cluster/code_sync_state.json`：代码同步状态文件。
- `zlk_cluster/code_sync_manifest.json`：manifest 模式下的远端代码清单。
- `zlk_cluster/sftp-target-ignores.json`：目标级 ignore 状态。

## 同步语义

### Dev Container 工作区

插件必须运行在 Windows UI Extension Host。配置 `simpleSftp.workspaceHostRoot=D:\GitRepo` 和 `simpleSftp.workspaceContainerRoot=/workspaces` 后，容器 URI `/workspaces/<项目>` 会映射到 Windows 宿主路径 `D:\GitRepo\<项目>`。Node 文件操作、`tar` 工作目录和本地状态文件使用宿主路径；打开 `.vscode/sftp.json` 等项目文件时保留 `vscode-remote` URI。缺少配置或路径越界时，上传、下载和相关远端操作会在确认窗口前阻断。

### 文件位置确认

文件传输确认窗口展示本地宿主位置、远端预期位置、服务器、远程工作区 URI 和文件范围。选择“仅本次继续”只放行当前操作；选择“此后该路径不再提醒”按本地宿主路径、服务器、端口和远端路径记忆确认。确认记录保存在 VS Code 用户状态，不写入项目或远端目录。

### 远端同步到本地

`远端同步到本地` 会在远端执行 `tar`，本地解包到当前工作区。同步会应用 `.vscode/sftp.json` 中的 ignore 规则，不会下载被忽略的目录或文件。

### 全量上传

`上传工作区到目标` 在无 manifest 时执行全量上传。全量上传会应用 ignore 规则，不会镜像删除远端已有文件。

### 保存时上传

当 `simpleSftp.uploadOnSave` 为 `true` 时，保存本地文件会按时间基准扫描变更文件并上传。扩展会把外部 SFTP 插件的 `uploadOnSave` 写为 `false`，避免重复上传。

### 上传指定文件

`上传指定文件到目标` 面向命令调用方。调用方可传入 `localBase`、`server`、`files`、`manifest` 等参数。文件会复制到临时目录后通过 tar 上传，远端文件名会经过相对路径安全检查。

### Manifest 代码同步

当 `uploadWorkspace` 收到 `manifest` 时，只上传 manifest 中声明且本地存在、安全的文件。manifest 上传不会因为 ignore 规则静默跳过文件；如果 manifest 文件缺失、路径越界或位于受保护目录，命令返回 `{ ok: false }`。

manifest prune 只删除上一版 manifest 中存在、当前 manifest 中消失、且安全并未被 ignore 保护的远端文件。受保护顶层目录包括 `.git`、`.vscode`、`zlk_cluster`、`data`、`dataset`、`datasets`、`checkpoints`、`weights`、`runs`、`work_dirs`、`outputs`、`results`、`logs` 等。

### 设备交接

`上传并标记交接` 可选择先全量上传，再写入远端 `.simple-sftp-handoff.json`。另一台设备打开同一工作区时，如果检测到交接设备不同，会提示执行远端到本地同步。

## Ignore 规则

默认 ignore 包含 Git、VS Code、Python cache、虚拟环境、构建目录、数据集、权重、日志、输出、压缩包、医学图像、NumPy 文件等常见大型或派生产物。

`配置忽略规则` 会扫描远端项目的前两层目录，自动推荐：

- 缓存和临时文件
- 环境和构建产物
- 数据集目录
- 权重和检查点
- 日志和实验输出
- 压缩包
- 医学图像、普通图像和数组文件

扫描大文件时使用 `simpleSftp.largeFileThresholdMB`，默认 `50 MB`。

## 编排器接口

`SimpleExperiment` 通过 VS Code command 调用本扩展。当前兼容的主要调用如下。

### `simpleSftp.uploadWorkspace`

常用参数：

- `localPath`
- `targetId`
- `targetRole`
- `stateFileMode`
- `fingerprint`
- `manifest`
- `server.transferHost` / `server.resolvedHost`：编排器从 Xshell 会话解析出的真实传输地址，优先级高于旧工作区 `.vscode/sftp.json`。
- `server.id`
- `server.label`
- `server.host`
- `server.user`
- `server.port`
- `server.remotePath`
- `server.sshConfigHost`

返回字段保持兼容：

- `ok`
- `targetId`
- `remotePath`
- `fingerprint`
- `uploadedAt`
- `deletedRemoteFiles`
- `error`

当 `stateFileMode` 为 `virtual` 时，本地不写 `zlk_cluster/code_sync_state.json`。非 virtual 状态只会在上传、远端状态写入和 prune 成功后写入本地。

### `simpleSftp.uploadFiles`

用于上传编排器 runtime 文件，例如 `cluster_agent.py`、`cluster_scheduler.py`。支持传入 `files` 和 `manifest`，manifest 会作为 `runtime_manifest.json` 上传到目标目录。

`targetId` 可带 `-agent-runtime`、`-runtime`、`-code-sync`、`-workspace`、`-files` 后缀。解析共享服务器配置时会自动回到基础端点，例如 `hub-agent-runtime` 会匹配 `hub`，避免部署 Agent 时误用旧别名。

### `simpleSftp.configureIgnores`

用于为 Hub/Worker 目标配置 ignore。目标级 ignore 不覆盖普通工作区 `.vscode/sftp.json`，而是写入 `zlk_cluster/sftp-target-ignores.json`。

## 本机 API 与 CLI

SimpleSFTP 会在 VS Code extension host 启动时尝试监听 `127.0.0.1:19766`。若端口被占用会向上顺延，实际地址、端口、token、pid 和版本写入：

```text
%APPDATA%\SimpleSFTP\api.json
```

端点：

- `POST /api/v1/rpc`：JSON-RPC 2.0 调用。
- `GET /api/v1/health`：服务健康信息。
- `GET /api/v1/capabilities`：方法列表和确认门禁说明。
- `GET /api/v1/openapi.json`：OpenAPI 3.0 文档。
- `GET /api/v1/events`：有界 SSE 事件流。

请求必须使用 `Authorization: Bearer <token>`，服务只接受本机回环连接。CLI 自动读取 discovery 文件：

```powershell
simple-sftp-api status
simple-sftp-api servers.list
simple-sftp-api upload.workspace --json upload.json
```

`upload.json` 示例：

```json
{
  "localPath": "D:\\GitRepo\\demo",
  "remotePath": "/data/demo",
  "server": {
    "host": "127.0.0.1",
    "user": "demo",
    "port": 22
  },
  "confirm": true,
  "pathConfirmed": true
}
```

危险操作必须显式传 `confirm: true`。SFTP 路径动作还需要 `pathConfirmed: true`，或者本地宿主路径、服务器和远端路径已存在于既有“不再提醒”记录中。缺少确认时返回 `CONFIRM_REQUIRED` 和目标预览，不会触发上传、下载、目录写入或远端任务。

公开方法：

- `status`
- `servers.list`
- `servers.setActive`
- `servers.importSshConfig`
- `remote.listDirs`
- `target.show`
- `project.create`
- `sync.fromRemote`
- `upload.workspace`
- `upload.files`
- `handoff.markReady`
- `ignores.configure`
- `confirmations.reset`

`ignores.configure` 可通过 `ignore` 全量替换规则，也可通过 `patterns`、`add`、`remove` 增量修改。`handoff.markReady` 使用 `upload: true` 表示上传全部后写入交接标记，默认仅标记。

## SSH 与端口

所有 SSH 命令通过系统 `ssh` 执行。host 可为普通主机名，也可为 `user@host` 格式。若 host 已包含 `@`，扩展不会重复拼接 username。

非 22 端口会生成 `ssh -p <port> ...`。22 端口保持 `ssh user@host ...`。`AGENTS.md` 中的命令模板也遵循同一规则。

## 打包与安装

本地测试：

```powershell
npm test
```

本地打包：

```powershell
npm run package
```

手动打包：

```powershell
npx --yes @vscode/vsce package --no-dependencies --out simple-sftp-0.2.0.vsix --allow-missing-repository
```

安装 VSIX：

```powershell
code --install-extension .\simple-sftp-0.2.0.vsix --force
```

安装后不需要重启 VS Code；如果当前 extension host 已加载旧版本，VS Code 可能需要之后自然刷新或下次启动才使用新版运行时代码。

## 与原版的差异

- 原版主要依赖固定服务器和固定端口；最新版支持共享服务器配置、SSH config 导入、用户指定 host、user、port 和 sshConfigHost。
- 原版创建工作区时会写入固定 `server2453` 风格名称和 `port: 22`；最新版按用户配置生成工作区名称和端口。
- 原版只覆盖基础远端到本地、全量上传和交接；最新版增加保存时上传、目标查看、可视化 ignore、目标级 ignore、manifest 同步和安全 prune。
- 原版 `AGENTS.md` 命令模板不区分非 22 端口；最新版会在非 22 端口自动加入 `-p <port>`。
- 原版 manifest 文件可能受 ignore 影响；最新版 manifest 上传必须上传所有安全且存在的 manifest 文件，避免返回与 fingerprint 不一致的假成功。
- 原版状态文件可能较早写入；最新版在上传和远端状态写入成功后再写本地 `code_sync_state.json`。
- 原版没有明确的编排器 ABI 文档；最新版明确支持 `uploadWorkspace`、`uploadFiles`、`configureIgnores` 三类调用，并保持返回字段兼容。
- 原版对远端删除没有 manifest 级保护；最新版只在 manifest prune 中删除安全、未忽略、上一版存在且当前缺失的代码文件，不会镜像删除普通上传目标。
