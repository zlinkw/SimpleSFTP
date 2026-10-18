# 子仓库整目录删除与阻拦证据

本批为 SimpleExperiment 0.5.378 和 SimpleSFTP 0.2.98 的配套交付。confirmed_paths 双确认删除整个项目子目录时，允许将其内部 .git 目录或普通 worktree 指针文件一并纳入本轮固定元数据清单。仅递归执行器获得绑定原始目标目录的内部 .git 边界，不接受独立 .git 目标，不读取或跟随 gitdir 指针。项目根目录、主仓库 .git、归档区、链接、挂载、越界、父目录进入与物理目录核验、最短直接子项和两次精确路径确认继续保护；普通移动、恢复和非 confirmed_paths 清理保持原规则。目标及内部 .git 变化使原预览失效，需要重新确认。

Python 错误返回具体 blockingPath 与 reason，API 只转发这些字段和错误码，不转发任意附加内容。SimpleExperiment 在实际 RPC 错误及删除页面显示错误码、原因和完整阻拦路径；旧配套只有路径时也保留错误码并补充含义。本机独立 .git/clean_dir 目标增加明确保护。远端整目录删除要求新配套能力 confirmedPathNestedRepositories=1。

回归先复现子仓库 .git 预览被拒及结构化原因丢失。真实 Python 扫描、递归执行器和 API 双确认均覆盖；删除底层调用移入隔离测试归档，验证最短 ./子项、实际父目录、主仓库 .git 不变、worktree 外部引用不访问、链接/挂载/归档拒绝及预览后新增文件不授权删除。测试仅操作临时夹具，不对用户项目或服务器执行新的删除。真实 RPC 解析和树删除错误链覆盖完整显示。

测试、确定包、源码推送、稳定发行和一次安装状态通过后补记。安装后需用户重载窗口，才可现场验收；本批不自动部署远端 Agent 或重放删除。

完整检查：SimpleSFTP npm test 串行 43 文件、281 项通过；npm run package 的 84 项 build 门禁通过，23 文件运行闭包通过。SimpleExperiment npm run package 的 1001 项 build/Windows flow 通过；额外 Linux 子仓库真实递归执行器夹具 1 项通过，删除底层使用移入隔离归档的替身。Python 子进程 10 秒、单文件 20 秒上限保持，测试过程中以有界本地 WSL 运行时保持器避免冷启动，结束后正常关闭，不影响用户服务。未执行服务器或消费项目的实际删除。

SimpleExperiment npm run lint、git diff --check、禁止端口、UTF-8 与中文、PanelHtml vm.Script 通过。两个包的身份、universal 平台、engine、运行闭包、源字节一致性及秘密/机器状态排除通过；SimpleSFTP 还检查实际 discovery token 未进入解压内容。

冻结包：simple-experiment-0.5.378.vsix，3197378 字节，SHA256 e4e60c7aa97a5219eb7175bd81cc0d4eac483596f74618f530a614450b48b109，558 ZIP 条目、384 个 dist 文件、262 模块/2 入口；simple-sftp-0.2.98.vsix，172519 字节，SHA256 dcf2319a6470613e5938c4aaffb225dff224314432d6008602ad4fb76b38f79c，26 ZIP 条目、23 个声明文件。各自 .vsix.sha256 精确绑定文件名。验收日志、确定包和指纹位于 C:/Users/ZLK/AppData/Local/Temp/simpleex-0378-acceptance-20261018。

源码、稳定发行和安装回执完成后补记。本记录验收回执于打包后补充，不改变已冻结包。真实窗口与真实服务器删除尚未执行验收，等待用户重载并重新进行精确路径双确认。

发行与安装回执：SimpleSFTP 源码 b31655a08dff8afd2914aaffee7d68040b2ca85d、SimpleExperiment 源码 d31dc8280eb27e86d2de8b0894dd6959d8d71113 均普通推送各自 origin/master，fetch 核对一致。[SimpleSFTP v0.2.98](https://github.com/zlinkw/SimpleSFTP/releases/tag/v0.2.98) 先发布并核对真实 Latest，再发布 [SimpleExperiment v0.5.378](https://github.com/zlinkw/SimpleExperiment/releases/tag/v0.5.378)；两者 tag、targetCommitish 绑定上述源码提交，draft=false、prerelease=false。

实际旧版 0.5.377 ReleaseClient 从公开 Latest 识别两项更新，并下载两个 VSIX 及各自 .vsix.sha256。精确名称、平台、身份、大小、SHA256、GitHub digest 和冻结字节全部一致。验证记录 live-release-verification.json 保留在上述隔离验收目录。

显式各执行一次 npm run install:latest，先安装 SimpleSFTP 0.2.98，再安装 SimpleExperiment 0.5.378；无 force、无降级。立即核对已安装版本、SimpleSFTP 23 个声明文件、SimpleExperiment 384 个 dist 文件与 simpleex.cmd 均符合发布字节；simpleex --help 和 CLI 入口核对通过。安装后停止两套插件 API/面板及服务器操作，等待用户 Developer: Reload Window。未重放旧删除，未删除用户项目/服务器文件，未部署或重启远端 Agent。真实删除须在重载后由用户重新核对完整路径并完成双确认。本回执为打包后文档，不改变已发布包。
