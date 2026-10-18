# 0.2.100 大清单清理请求与进度查询

大目录预览可以生成超过 1 MiB 的冻结元数据清单，原执行、子执行器 stdin 与每次 `files.cleanup.check` 却都重传这份清单并受通用 1 MiB 限制。执行错误被调用方保留待主动查询，随后的查询再次超限，于是显示 check 的 `REQUEST_TOO_LARGE` 并安全停止剩余批次。

冻结清单请求采用独立的 32 MiB 有界预算，与既有最多 50,000 条清单及预览回复预算配套；普通不携带清单的请求保留 1 MiB 限制。独立 tmux 子执行器也经过同一解码与限额检查，避免只修外层请求。没有取消输入或清单上限。

远端开始执行后的主动查询仅携带精确目标摘要和冻结目标 SHA256，不再重传目录清单。服务端从已有 `clean_dir/.operations/managed/<稳定身份>.json` 读取既有不可变输入，核对当前根身份、operationId、操作、精确路径/类型/指纹、完整目标摘要、文件身份及读取前后变化，然后继续查询实际文件系统和实际 tmux 窗口及剩余条目/字节。摘要在 JavaScript/Python 间使用相同 UTF-8 键序和二进制浮点编码，数字属性名、非 ASCII 文本及科学记数法均有覆盖；原库存指纹和操作身份算法保持不变。冻结输入只提供已确认清单，不能证明目标存在、已删除或任务完成。

状态查询不创建输入、不启动执行器、不补写历史清单；输入缺失且目标仍存在时显示未知，清理窗口仍活跃时保留执行中，目标确实不存在且无活跃执行器才能确认完成。输入篡改、换根或目标重建不能重放删除。明确 `OPERATION_BUSY` 的未启动回执恢复 pending，后续仍核对完整目标并仅重试同一已确认请求；丢失响应不作为重发依据。

回归覆盖 8,000 行、超过 1 MiB 的协议清单、精简查询小于 8 KiB、实际 Python stdin、大输入的实际 managed-start/子进程、冻结输入篡改/丢失、目标重建、持续窗口和输入/条目限额。Windows/Linux 子执行器的底层删除替换为移入隔离夹具归档，未删除用户项目文件；条目规模为协议压力夹具，不是生产批量删除耗时实测。保留原双确认、安全根、主仓库/链接/挂载及物理直接父目录和 `./直接子项` 执行保护。

本批仅更新 SimpleSFTP，兼容现有 SimpleExperiment 0.5.382；不自动重放旧批次，不部署远端 Agent。测试、发行与安装结果在交付后补记。

## 验证

`node --test --test-force-exit --test-timeout 20000 test/cleanupLargeInventory.test.js`：3 项通过。随后串行 `npm test`：45 文件、287 项通过；`npm run package -- --replace`：90 项构建门禁通过，显式替换本批尚未发布或安装的同版本工作包。远端压缩加载命令 18,172 字符，小于 20,000 上限。

VSIX 身份/版本/平台/engine、26 个 ZIP 项与 23 个运行文件源字节闭包及秘密排除通过。冻结资产 `simple-sftp-0.2.100.vsix` 为 174,253 bytes，SHA256 `4285df21f7c5bdf489401522ba715d8aa666c60d629fa123e2910fcccef59506`；配套 `.vsix.sha256` 绑定此精确文件名。发行和安装另记真实回执。

## 发行及安装回执

源码 `c802dbb5134a610b7f02f32356a5f6bd5cc63e4b` 已普通推送至既有 `origin/master`，fetch 后一致。[稳定 Release v0.2.100](https://github.com/zlinkw/SimpleSFTP/releases/tag/v0.2.100) 绑定该提交，非 draft、非 prerelease；Latest 包含上述 VSIX 与逐包校验文件，资产名、大小和指纹均一致。首次创建请求因 GitHub HEAD 连接 EOF 失败，主动查询确认该版本不存在、Latest 仍为 0.2.99 后才重新创建；未覆盖历史 tag 或资产。

已使用本机已安装 SimpleExperiment 0.5.382 的真实更新解析器，按 SimpleSFTP 0.2.99 检查匿名公开 Latest，识别 0.2.100 更新；实际匿名下载 SimpleSFTP 0.2.100、SimpleExperiment 0.5.382 及各自 `.vsix.sha256`，与各自冻结包字节一致，源提交、平台、版本和文件名绑定均通过。

显式执行一次 `npm run install:latest`，无 force、无降级；已安装 SimpleSFTP 0.2.100 的 23 个运行文件与已发布包逐文件 SHA256 一致，VS Code CLI 确认 SimpleExperiment 仍为 0.5.382，`simple-sftp-api` 与 `simpleex` 入口存在。安装后停止当前插件 API/面板操作，等待用户 Developer: Reload Window；之后需要重新预览并双确认剩余精确目标，旧批次不自动重放。未执行用户真实文件删除或远端 Agent 部署。

冻结包、实际下载和串行验证回执位于本机 `C:/Users/ZLK/AppData/Local/Temp/sftp-0100-acceptance-20261018`。本节属于交付后纯文档回执，不重打或重装运行包。
