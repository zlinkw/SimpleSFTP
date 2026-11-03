# 0.2.118 中文快捷入口设置

目标：将五个固定底部快捷按钮的显示和对应快捷键配置集中到全中文设置；默认显示全部，允许关闭全部或逐项选择。隐藏后侧栏与命令面板的设置入口继续可用。快捷键复用 VS Code 原生编辑器，按精确命令过滤，由用户录入/修改/移除，不预设传输按键、不直接改写用户 keybindings.json。

基准：2026-11-03 刚 fetch 的 origin/master `7c136f209bf0fee8a1f98eebdececc02afca02bf`，0.2.117。原主目录干净，从 2012c0d 仅快进到此提交；原生 Codex Windows，无 Pi/Herdr 管理器证据，适用普通 master 快进交付。SimpleExperiment 不修改，训练服务器、传输、清理与 Agent 操作均不在范围内；不提升权威版本。

七文件边界：quick-access.js、extension.js、package.json、package-lock.json、test/quickAccess.test.js、readme.md 和本记录。新设置键及枚举中文，本机用户级保存并监听变化；所有窗口共用显示偏好，服务器/任务身份及实际命令不改。主开关不抹去逐项选择，取消不保存，空列表有效，保存错误显示中文原因。没有新增依赖、兼容层、轮询或性能测试。

检查：先单独运行 quickAccess.test.js，覆盖五按钮缺省、实时配置切换、总开关、逐项保存/取消/空列表、五个精确快捷键编辑入口、不执行传输、保存失败及全中文配置。随后按既有 npm run package 验证运行语法/闭包、全部当前串行测试并组包，保留真实日志。源 diff 与 UTF-8 复读通过后提交/push/fetch。最终只作试行发布、实际下载指纹核对及一次安装；不把 mock 当真实 UI 或服务器验收。

状态：实现完成，定向及规定打包待执行。用户重载后的原生选择器、键盘编辑器与跨窗口展示仍待现场核实。

首次定向 quickAccess 6/6 通过。首次 package 在 api.test 的固定版本断言失败：实际 0.2.118、期望旧 0.2.117，21/22 通过；原始日志保留于系统临时 sftp-quick-access-118-package.log 与 run-pBFf6o/api.test.js.log。反向检查发现 stagedSlotLifecycle 也有同一版本常量。两处改为合法版本及 package-lock 同版本核对，原能力/安全/真实 receiver 断言、测试范围和超时保持。先独立提交这两个测试及本记录，产品修改不混入准备提交；之后继续主批次规定检查。

准备回归：api 22/22、stagedSlotLifecycle 11/11，exit=0；日志 sftp-118-prep-api.log 与 sftp-118-prep-stagedSlotLifecycle.log，后者真实本机 WSL 夹具耗时 18935ms，未改变超时或 receiver 行为。产品主批次尚未完成，不按准备通过宣称交付。
