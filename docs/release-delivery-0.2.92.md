# 0.2.92 文件操作实际进度与退出核验

清单、目录读取、哈希、传输与清理的静默不再被等同于失败。所有文件控制器和 SSH 文件观察器使用实际文件数量/字节推进；暂未变化只提示等待，保留手动取消、真实错误及原身份/退出保护。inventory 在枚举阶段报告实际项目数，过滤范围后再查询目录链接；stat 和遍历失败不能返回空清单。

本机清理不再固定 60 秒杀执行器；CLI 文件 RPC 不再固定 15 秒因 socket 静默中断。精确路径、规范安全根、物理直接父目录、./直接子项、类型/链接/变更核对及删除双确认保持。未执行生产清理。

磁盘映射下载需要持久化的写事务退出/取消回执；memoryOnly 读取不创建写事务，API 断开只取消该读取，且取消信号覆盖自定义读取流。没有以复制成功或输出计数代替 SHA256 和 SSH 退出证据。

实际现场观察来自 SimpleExperiment 0.5.361 / SimpleSFTP 0.2.91；前置清单失败与超过三分钟仍持续计数的请求并存。完整身份、时刻、调用路径和逐入口复核保存在 SimpleExperiment 的 `docs/file-operation-progress-audit.md`，不复用 0.5.359 的旧科研产物证据。

## 验证

目标 API/CLI 20 项、哈希与枚举 12 项、停滞 7 项等通过。全量回归曾在旧下载取消夹具失败后挂起 20 秒，已按仓库规则停止。修正错误分类及夹具退出保护后，获得用户明确授权，仅单独重测该文件一次，26 项通过，约 2.87 秒。其余 41 个文件使用原串行执行器逐一运行，243 项通过；完整覆盖共 42 个文件、269 项，未重复该已单独验证文件。

最终 package 的内置串行 build 门禁、23 个运行文件闭包及语法检查通过。确定包身份 simple-local.simple-sftp，版本 0.2.92，universal 平台，VS Code engine ^1.80.0；26 个条目、169720 字节，24 个源码/运行文件与当前文件逐字节一致，5 份 Python AST 及实际 discovery 秘密排除通过。

文件：`simple-sftp-0.2.92.vsix`。

SHA256：`ca05a0669600f6a0d3475bb67ca7bbc89a4c10edc989c2ae7ba1fdc97cddf00f`。同名 `.vsix.sha256` 精确绑定该文件名。

实现提交 `7a8d361f0d6577f146efab4bf1be638af7e1bee4` 已普通 fast-forward 推送 origin/master，并 fetch 核对一致。[稳定 Latest v0.2.92](https://github.com/zlinkw/SimpleSFTP/releases/tag/v0.2.92) 的 tag 与 target_commitish 绑定该提交，draft=false、prerelease=false；VSIX 169720 字节、精确 SHA256 清单 90 字节。GitHub 资产 digest、清单及实际下载 SHA256 一致，没有覆盖历史资产。

实际已安装旧版 Experiment 0.5.361 的 ReleaseClient 从真实公开 Latest 识别 0.2.92 Windows 更新，实际下载并核实 universal 身份、版本及字节与确定包一致；同时核验配套 Experiment 0.5.362。验证目录 `C:/Users/ZLK/AppData/Local/Temp/simpleex-0362-release-verify-MjlXCD` 保留。

显式且仅执行一次 `npm run install:latest`，无 force 或降级。VS Code 安装列表确认 simple-local.simple-sftp@0.2.92；全部 21 个已安装 JS/Python 运行文件逐字节一致，CLI 入口已核对。配套 Experiment 0.5.362 同样完成稳定发行及一次安装。

安装前最后核对的 Host 仍运行 SFTP 0.2.91；安装后未操作面板、API 或服务器，等待用户 Reload Window。未以打包、安装或本机回归代替现场验收。本次不自动补交 PLAN、启动/停止/重跑科研任务、改科研环境或更新远端 Agent；不能提前宣布现场问题解决。本节为文档补记，不修改 tag 或已发行字节。
