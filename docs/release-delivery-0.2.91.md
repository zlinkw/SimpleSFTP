# 0.2.91 端口转发与文件传输退出证明

只读现场复现：一条手动 ssh -N -T 转发的 shell 祖先已退出，0.2.90 将其视为未知文件传输，使最新产物同步报 LOCAL_PROCESS_ANCESTRY_UNAVAILABLE。未清除传输登记，未取消或重新发起真实传输。

本次只修改本机退出证明。保守解析完整 Windows SSH 参数，仅将明确无远端命令的 -N 调用视为端口转发；未知、配置代理、远端命令、破损引号均不豁免。只有 SSH 的命令行短暂进入本机内存，随即丢弃；其他进程不读取命令行，结果不含参数或凭据。原服务仍活跃、旧子传输、未知普通 SSH 祖先、远端写进程、持久化失败与身份变更仍阻止重传。

本机实时只读快照在修复逻辑下核实旧服务已退出、传输数为 0，并单独识别一条无关隧道；现场仍由当前服务发起的普通 SSH 工作不受干预。定向退出证明 9 项、恢复集成 32 项通过，新增门禁进入 build。

npm run package 完成 13 个串行测试文件、72 项通过、0 失败，运行语法/依赖闭包检查通过。simple-sftp-0.2.91.vsix 共 26 条 ZIP 记录、23 个声明 runtime 文件，与本机验证源码逐字节一致，身份/版本/平台、Python AST、秘密排除通过。包为 169,109 字节，SHA256 为 e483156ad117fd8c3aaeb81d01fc0285ad6ce7c698827b589ad16596a9ea453e；同名 .vsix.sha256 绑定精确文件名。

源码 2e8b50b7e62d87b3c052ff37ab2d908023587ba8 已普通推送 origin/master 并 fetch 核对一致。稳定发行 https://github.com/zlinkw/SimpleSFTP/releases/tag/v0.2.91 的实际 Latest、tag 和目标提交一致，draft=false、prerelease=false，大小、GitHub SHA256 digest 和逐包校验文件通过。旧 SimpleExperiment 0.5.353 的实际 ReleaseClient 识别本次更新并从公开地址下载，身份/版本/平台和字节比对通过；配合 SimpleExperiment 0.5.354 的最终双包验证目录为 C:/Users/ZLK/AppData/Local/Temp/simpleex-0354-release-verify-vM1OWx。

显式执行一次 npm run install:latest，确认 simple-local.simple-sftp@0.2.91，23 个 runtime 文件及 package 身份与 VSIX 一致。simple-sftp-api --help 输出现有用法（当前 CLI 解析返回 1），未调用 API。未重复安装或 force；安装后等待用户 Reload Window，不操作当前插件面板/API。未修改服务器、环境、科研任务或产物，未清空历史登记，未停止或自动重发真实传输。
