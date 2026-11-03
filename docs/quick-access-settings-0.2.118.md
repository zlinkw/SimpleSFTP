# 0.2.118 中文快捷入口设置

目标：将五个固定底部快捷按钮的显示和对应快捷键配置集中到全中文设置；默认显示全部，允许关闭全部或逐项选择。隐藏后侧栏与命令面板的设置入口继续可用。快捷键复用 VS Code 原生编辑器，按精确命令过滤，由用户录入/修改/移除，不预设传输按键、不直接改写用户 keybindings.json。

基准：2026-11-03 刚 fetch 的 origin/master `7c136f209bf0fee8a1f98eebdececc02afca02bf`，0.2.117。原主目录干净，从 2012c0d 仅快进到此提交；原生 Codex Windows，无 Pi/Herdr 管理器证据，适用普通 master 快进交付。SimpleExperiment 不修改，训练服务器、传输、清理与 Agent 操作均不在范围内；不提升权威版本。

七文件边界：quick-access.js、extension.js、package.json、package-lock.json、test/quickAccess.test.js、readme.md 和本记录。新设置键及枚举中文，本机用户级保存并监听变化；所有窗口共用显示偏好，服务器/任务身份及实际命令不改。主开关不抹去逐项选择，取消不保存，空列表有效，保存错误显示中文原因。没有新增依赖、兼容层、轮询或性能测试。

检查：先单独运行 quickAccess.test.js，覆盖五按钮缺省、实时配置切换、总开关、逐项保存/取消/空列表、五个精确快捷键编辑入口、不执行传输、保存失败及全中文配置。随后按既有 npm run package 验证运行语法/闭包、全部当前串行测试并组包，保留真实日志。源 diff 与 UTF-8 复读通过后提交/push/fetch。最终只作试行发布、实际下载指纹核对及一次安装；不把 mock 当真实 UI 或服务器验收。

状态：实现、本机规定检查、发布、下载核对及一次安装完成；2026-11-03 用户确认无误并明确要求转正，0.2.118 已提升为正式 Latest。真实训练服务器操作未执行，不因版本认可而冒充服务器验收。

首次定向 quickAccess 6/6 通过。首次 package 在 api.test 的固定版本断言失败：实际 0.2.118、期望旧 0.2.117，21/22 通过；原始日志保留于系统临时 sftp-quick-access-118-package.log 与 run-pBFf6o/api.test.js.log。反向检查发现 stagedSlotLifecycle 也有同一版本常量。两处改为合法版本及 package-lock 同版本核对，原能力/安全/真实 receiver 断言、测试范围和超时保持。先独立提交这两个测试及本记录，产品修改不混入准备提交；之后继续主批次规定检查。

准备回归：api 22/22、stagedSlotLifecycle 11/11，exit=0；日志 sftp-118-prep-api.log 与 sftp-118-prep-stagedSlotLifecycle.log，后者真实本机 WSL 夹具耗时 18935ms，未改变超时或 receiver 行为。产品主批次尚未完成，不按准备通过宣称交付。

准备提交 87597bd6cf43e67c454fecaed8915ab6dfe13ccd 已 push/fetch 一致。其后 package 完整 69 文件/465 项通过，日志 sftp-quick-access-118-package-final.log、run-e86pvs，包尚未发布/安装。最后 diff 核对发现快捷键分支打开编辑器后会再次弹设置选择器抢焦点；在同一原 quickAccess 用例追加实际调用次数断言，5/6 通过、该项失败（sftp-118-keyboard-focus-before.log），证据与原包保留。仅快捷键分支改为打开编辑器后返回，取消同样不再重开菜单；设置/逐项显示循环不变。重新运行定向并按原完整 package/原超时组包，未放宽断言或改验证范围。

最终定向 6/6 通过，sftp-118-keyboard-focus-fixed.log；最终 npm run package -- --replace exit=0，69 个当前测试文件、465 项全部通过，无跳过，完整日志系统临时 sftp-quick-access-118-package-delivery.log 及 run-St3ntB。仅替换自有未发布的固定生成包，前一包按原字节另存系统临时 simple-sftp-0.2.118-before-keyboard-focus.vsix；未清理任何文件。实际 runtime 语法/依赖闭包 23 文件通过；最终归档 26 项等于现有白名单与必要工具元数据，身份/版本/universal/源字节一致，源码完整指南保留，包内只含原有简短指南。最终包 242568 字节，SHA256 edf506aa2b01933eb8a348a42787ad62f0179913109b658753137d29ab21b3ba，清单绑定精确 simple-sftp-0.2.118.vsix。UTF-8 复读和 diff 检查通过；实际用户设置未变、未访问训练服务器、未执行传输/清理/Agent 操作。主批次七文件，旧版本夹具已在独立准备提交中处理。

## 真实交付结果

源码提交 `23cbf92918c7b63cf4674a4159c3f06120037e5d` 普通 push/fetch 一致。[v0.2.118 试行发布](https://github.com/zlinkw/SimpleSFTP/releases/tag/v0.2.118) 公开非 draft、Pre-release，显式 latest=false，tag 的真实远端引用绑定该提交。网页核对版本、提交、VSIX 和 91 字节精确文件名校验清单；实际从网页下载两资产至 Downloads，与上述已验证本机包/清单逐字节一致，未覆盖历史发行。

发布后真实更新客户端读取两仓公开 Latest 均 HTTP 200：当前 0.5.482/0.2.118 不降级，旧 0.5.439/0.2.116 仍能看到权威 0.5.440/0.2.117；实际记录系统临时 `sftp-118-actual-update-client-1793709205750.json`。网页重新导航 SimpleSFTP /releases/latest 也仍为 0.2.117，未转正，SimpleExperiment 运行源码和安装未改。

发行和字节核对结束后，仅显式执行一次 npm run install:latest，exit=0；安装器实际查询已安装版本并核对为 simple-local.simple-sftp@0.2.118，无 force、降级或重复安装。完整安装日志系统临时 `simple-sftp-0.2.118-install.log`，VS Code CLI 的 DEP0169 弃用提示原样保留，安装及核对成功。设置默认开启，没有替用户修改实际显示偏好或键盘绑定；原生交互仍待用户 Developer: Reload Window 后核实，重载约一分钟。安装后不再操作当前插件界面，不连接训练服务器。最后记录为纯文档，不重复打包、发行或安装，提交/push/fetch 后本机交付收口。

## 用户认可与正式提升

2026-11-03 用户明确回复“确认无误，SFTP试行版转正式版号”。原 v0.2.118 Release 已改为 draft=false、prerelease=false、latest=true，并更新正式标题与说明；版本、tag 提交、包及清单字节保持不变，不重新安装。正式包仍为 242568 字节及上述 edf506… SHA256，校验清单 91 字节。提升前再次真实下载两资产，与本机确定包/清单一致；原465项验证复用，没有因提升元数据重跑或重打包。

真实网页 Latest 已指向0.2.118，实际更新客户端的两公开 Latest 请求 HTTP200，核对发布target/非draft/非prerelease/资产/摘要。已装0.2.117可看到更新，已装0.2.118无需更新，SE正式源仍0.5.440；记录系统临时 sftp-118-stable-promotion-1793709783520.json。本仓只更新README和本记录并普通push/fetch；配套仓库同步权威JSON与标签元数据，不覆盖已发布SE包。未操作训练服务器或远端Agent，无新增安装/重载要求；历史试行经过与失败记录保持。
