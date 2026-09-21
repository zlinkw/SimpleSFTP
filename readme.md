# SimpleSFTP

SimpleSFTP 是一个 Windows VS Code 扩展，用于在本地项目和远端 Linux 项目目录之间同步代码、轻量结果和 Agent runtime。它使用系统 `ssh` 和 `tar` 传输，不内置 SCP/RSYNC，也不会保存云凭据。

SimpleSFTP 与 [SimpleExperiment](https://github.com/zlinkw/SimpleExperiment) 配套使用。SimpleExperiment 负责服务器状态和实验调度；SimpleSFTP 只负责真实文件传输。

## 主要能力

- 创建或打开远端项目对应的本地工作区。
- 远端到本地同步；可按服务器选择远端文件或文件夹，并限制文件类型和大小。
- 全量上传、指定文件上传、manifest 受控同步。
- 可选的保存后增量上传。
- 共享服务器配置，可从 `~/.ssh/config` 导入。
- 独立的远端下载范围；旧目标级 ignore 配置继续兼容。
- 上传前强制确认本机路径、服务器账号和远端目标路径。
- 本机 JSON-RPC API 和 `simple-sftp-api` CLI，供自动化工具调用。

## 安装

1. 安装最新版 `simple-sftp-<version>.vsix`。
2. 如果使用 SimpleExperiment，也安装其配套版本。
3. 执行 **Developer: Reload Window**。

```powershell
code --install-extension .\simple-sftp-<version>.vsix --force
```

## 快速开始

### 独立使用

1. 打开本地项目文件夹。
2. 运行命令 **SimpleSFTP: 创建或打开远端项目**。
3. 选择 SSH host 或共享服务器配置。
4. 填写远端项目目录。
5. 在强确认窗口核对本地目录、服务器账号和远端路径。
6. 使用 **远端同步到本地** 或 **上传工作区到目标**。

### 与 SimpleExperiment 配合

通常不需要手工填写 SimpleSFTP 目标。在 SimpleExperiment 中配置 Hub/Worker 后，“准备 Agent 并启动”和运行前同步会把最终解析出的远端项目路径写入共享服务器配置。

推荐顺序：

```text
配置 Xshell 会话
→ 在 SimpleExperiment 填写 Hub/Worker 项目父目录
→ 准备 Agent 并启动
→ 插件生成对应 SimpleSFTP 目标
→ 运行前自动同步代码
```

远端代码目录始终由用户配置计算：

```text
<项目父目录>/<当前工作区名称>
```

例如项目父目录为 `/data/experiments`，本地工作区名为 `my-project`，上传目标是 `/data/experiments/my-project`。不要把当前项目名填成父目录。

## 命令

| 命令 | 功能 |
| --- | --- |
| 创建或打开远端项目 | 选择远端目录并创建本地同步工作区。 |
| 远端同步到本地 | 已设置范围时仅下载所选远端文件；否则沿用旧同步规则。 |
| 上传工作区到目标 | 上传全量文件或 manifest 指定的受管文件。 |
| 上传指定文件到目标 | 供 API/编排器上传明确文件。 |
| 上传并标记交接 | 上传后写入交接标记。 |
| 设置下载文件范围 | 浏览远端项目，选择允许下载的文件或文件夹，并设置文件类型与大小上限。 |
| 选择服务器 | 切换共享服务器配置。 |
| 导入 VS Code SSH 配置 | 从 `~/.ssh/config` 导入 host/user/port。 |
| 查看当前目标 | 显示当前本地路径、远端路径、host、user 和 port。 |

## 配置

普通用户优先使用面板和共享服务器配置。常用设置：

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `remoteBase` | 空 | 默认远端项目根目录；可为空，调用方显式传入时优先。 |
| `localBase` | 空 | 默认本地项目根目录。 |
| `sshHost` / `execHost` | 空 | 默认 SSH alias；不要填写私密信息。 |
| `userName` | 空 | 默认用户名。 |
| `sshPort` | `22` | 默认 SSH 端口。 |
| `uploadOnSave` | `true` | 保存时上传变更文件。 |
| `connectTimeoutSeconds` | `15` | SSH 建连超时。 |
| `uploadTimeoutSeconds` | `600` | 单次传输整体超时。 |
| `uploadCancellable` | `true` | 进度窗口显示取消按钮。 |
| `workspaceHostRoot` / `workspaceContainerRoot` | 空 | 仅 Dev Container 工作区映射需要。 |

共享服务器配置保存在：

```text
%APPDATA%\SimpleSFTP\server-profiles\servers.json
```

## 同步规则

默认排除 `.git`、IDE 目录、Python 缓存、虚拟环境、构建产物、`node_modules`、数据集、checkpoint、模型权重、日志、输出目录、压缩包和常见二进制数组文件。

未设置下载范围时，既有 `.vscode/sftp.json` 和目标级 ignore 规则继续生效。设置下载范围后，远端到本地同步只读取所选远端路径中符合扩展名和大小上限的文件；范围按服务器保存到本机项目的 `simple_cluster/sftp-download-scopes.json`。`.git`、`.vscode`、`.codex` 和插件状态目录始终不会进入下载范围。

全量上传不会镜像删除远端文件。manifest 同步采用调用方已确认的文件类型与大小规则，不再根据 `data/` 子目录或文件名重复过滤；仍会阻止路径越界以及 `.git`、`.vscode`、`.codex`、旧插件状态目录。manifest 同步只会清理上一版 manifest 存在、当前 manifest 缺失且通过路径安全检查的受管文件。

新版本状态文件写入 `simple_cluster/`。旧版 `zlk_cluster/code_sync_state.json` 只作为只读兼容来源；发现旧目录时会提示人工核对后手动删除，插件不会自动删除它。

## 文件位置确认

上传、下载、交接和下载范围配置前会显示：

- 本机宿主路径；
- 服务器 label/host/user/port；
- 完整远端目录；
- 文件范围和数量。

选择 **仅本次继续** 只放行当前操作。选择 **此后该路径不再提醒** 只记住完全相同的项目、账号、端口和路径组合；任一条件变化都会再次询问。

API 调用危险动作必须传 `confirm: true`。SFTP 路径动作还需要 `pathConfirmed: true`，或已有精确匹配的免提醒记录。缺少确认时返回 `CONFIRM_REQUIRED`，不会产生副作用。

## 本机 API

扩展启动后监听本机回环端口，默认首选：

```text
127.0.0.1:19766
```

实际地址、token、pid 和版本写入：

```text
%APPDATA%\SimpleSFTP\api.json
```

端点：

- `POST /api/v1/rpc`
- `GET /api/v1/health`
- `GET /api/v1/capabilities`
- `GET /api/v1/openapi.json`
- `GET /api/v1/events`

请求必须带：

```http
Authorization: Bearer <token>
```

CLI 示例：

```powershell
simple-sftp-api status
simple-sftp-api servers.list
simple-sftp-api upload.workspace --json upload.json
```

公开方法以 `/api/v1/capabilities` 的实时返回为准。

指定文件上传时，`remotePath` 是实际目标目录。若同时传入 `server.remotePath`，两者必须一致；不一致时插件会拒绝上传。`target.show`、API 确认预览和实际传输使用同一目标解析逻辑。用服务器名称指定目标时，该名称必须匹配已保存的服务器配置；未知名称不会回退到当前活动服务器。上传前请核对预览中的主机、端口与远端目录。

## 故障排查

| 问题 | 处理 |
| --- | --- |
| 连接超时 | 核对 host、port、VPN、防火墙和本机网络。 |
| 认证失败 | 先用系统 `ssh <alias>` 登录测试。 |
| SFTP subsystem 不可用 | 确认服务器允许 SFTP 子系统。 |
| 权限不足 | 确认远端目录存在且当前用户可写。 |
| 上传卡住 | 在进度窗口取消，或用 transfers API 停止；调低大文件并发并检查网络。 |
| 参数过长 | 升级到 manifest/file list 打包版本，并把大型第三方仓库加入 ignore。 |

## 开发

```powershell
npm test
npm run package
```

生成的 `.vsix` 位于仓库根目录。历史发布包不要覆盖。
