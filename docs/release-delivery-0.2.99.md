# 0.2.99 根目录直属项清理

用户批量删除项目根目录的 `runtime_manifest.json` 时，存在性检查返回 `UNSAFE_PARENT`。原检查把直接父目录也要求为项目根的严格后代，误拒绝全部根目录直属文件和目录；同一条件也存在于预览及执行前的直接父目录进入函数，不能只修存在性检查。

统一使用 `checked_parent`：目标仍须为项目根的严格后代，直接父目录允许等于项目根或位于根内。`below` 的严格语义保持不变。存在性读取、预览和实际执行共用这项边界；删除执行仍成功进入直接父目录，核对物理工作目录，并仅向底层传入 `./直接子项`。进入失败、物理目录不符、项目根本身、主仓库 `.git`、归档区、链接、挂载、类型或预览变化仍拒绝。父目录错误增加具体阻拦路径及原因。

Windows 和 Linux 的真实 Python 引擎夹具覆盖根文件、根目录、真实缺失、预览后修改及父目录失败；底层删除替换为移入隔离夹具归档，不永久删除测试文件。API 夹具使用真实引擎检查和预览根文件，并核对两个独立的精确路径确认。保留已有子仓库、清理窗口、同批路径、断线及内容保护回归。旧测试中把根文件拒绝作为期望的断言改为允许。

本批仅修改 SimpleSFTP，继续兼容 SimpleExperiment 0.5.382，未修改主插件运行代码或远端 Agent。完整测试、确定包、发布和安装结果在交付后另记；现场删除仍由用户重载后重新确认精确路径。本次不重放用户旧删除。

交付验收（2026-10-18）：

- 运行源码 `ece51d9f0085ee3dfb9b6fec8d99784b83fdc513` 已普通推送至既有 origin/master，fetch 后核对一致。全量串行测试 44 文件、284 项通过，npm run package 的 build 门禁 87 项通过；Windows/Linux 根目录直属项夹具通过。
- [稳定 Release v0.2.99](https://github.com/zlinkw/SimpleSFTP/releases/tag/v0.2.99) 绑定上述提交，包含 `simple-sftp-0.2.99.vsix`（172,734 bytes）和精确文件名绑定的 `.vsix.sha256`；SHA256 `e097b20510d90eb13675942b0edb6f8b6cc8c39baa3fbc7ac54f0e449e2dfe54`。26 ZIP 项、23 声明运行文件，身份/universal 平台/engine/运行闭包/源字节一致性、秘密排除均通过。
- 真实已安装的 0.5.382 ReleaseClient 从匿名公开 Latest 识别 SimpleSFTP 0.2.99 更新，SimpleExperiment 0.5.382 保持无需更新。两个实际 VSIX 及其校验文件重新匿名下载，版本、tag、提交、非 draft/非 prerelease、大小、GitHub digest 与冻结 SHA256/字节一致。主插件继续复用 `599c72a6041da5926ee80d7faac30f8ea189a83e` 绑定的既有 .382 包，不重打包或重装。
- 显式安装一次 SimpleSFTP 0.2.99，23 个安装文件与发行包逐项指纹一致，已安装 SimpleExperiment 仍为 0.5.382，`simple-sftp-api` 和 `simpleex` 入口已核对。随后停止插件 API/面板操作，等待 Developer: Reload Window 后现场验收；未重放旧删除，未删除用户目录，未部署远端 Agent。本回执是打包后的文档提交，不改变已冻结发行包。验证目录 `C:/Users/ZLK/AppData/Local/Temp/sftp-0099-acceptance-20261018`。
