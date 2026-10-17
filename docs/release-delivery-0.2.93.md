# 0.2.93 精确清单与代码读取容量

配套 SimpleExperiment 0.5.363。完整清单继续验证每个声明文件、SHA256、缓存身份与读取期间变化；精确 scope 直接访问目标，目录 scope 完整递归，避免从项目根开始枚举无关兄弟项。重叠范围只读一次，空范围、缺失路径、错误和链接保护保持明确。

inventoryPurpose=code-sync 的有界范围读取使用独立容量，避免排在同服务器大型产物清单后；每通道最多两个服务器、每服务器一个操作。写入通道的容量、资源锁、取消及结果未知防重放保留。活动查询及最终 inventory 回应暴露精简容量和执行时间，不把排队或心跳当成文件进度。

旧实现的两条反例已在隔离环境复现。此前完整串行覆盖 42 文件、271 项通过；又补充同服务器代码通道的排队和失败释放检查，最终包门禁将覆盖该目标。没有在科研服务器重放操作、删除文件、修改产物或运行任务。源码、确定包指纹、稳定 Release 和一次安装回执在交付完成后补记；重载前不宣称现场加速已验收。

最终 `npm run package` 退出 0，包含 metadataTreeRead 7 项和全部既有串行 build 门禁，23 文件运行闭包通过。该新增用例加上此前 42 文件/271 项覆盖了最终逻辑；没有并行测试或超过 20 秒后的重试。确定包 `simple-sftp-0.2.93.vsix` 为 170663 字节、26 个 ZIP 条目、21 个 JS/Python 运行文件，逐字节匹配当前文件；publisher/name/version、universal 平台、源锁版本和实际 discovery 秘密排除通过。

SHA256：`742e44343fe1572a5da6856d3b5cbc9886fc89c42660495de2bdb9ac72eb9797`。同名清单精确绑定包名。包在交付回执补记前生成；不重新打包或替换资产。

实现提交 `e75af6b0de826e2e8752c302b8a00b23545b1150` 已普通推送 origin/master、fetch 核对一致。[稳定 Latest v0.2.93](https://github.com/zlinkw/SimpleSFTP/releases/tag/v0.2.93) 的 tag/target_commitish 绑定该提交，draft=false、prerelease=false。VSIX 170663 字节，同名 SHA256 清单 90 字节；真实 Latest、资产 digest、实际下载内容与本机确定包一致。配套 [Experiment v0.5.363](https://github.com/zlinkw/SimpleExperiment/releases/tag/v0.5.363) 同样完成发行。

实际旧版 Experiment 0.5.362 ReleaseClient 识别并下载 Windows 更新包，身份、版本、universal 平台及精确清单验证通过。验证目录 `C:/Users/ZLK/AppData/Local/Temp/simpleex-0363-release-verify-zs0Gwf` 保留。

显式且仅一次 `npm run install:latest` 成功；VS Code 列表为 simple-local.simple-sftp@0.2.93，已安装 21 个 JS/Python 运行文件与包逐字节一致。两个 CLI 入口和 simpleex --help 核对通过。安装后停止插件 API、面板及服务器操作，等待用户重载；未重提、重跑或删除科研任务产物，也未升级远端服务。现场新代码的耗时验收尚未执行，不能提前宣称 H20 已加速。本节仅为文档回执，不改变发行包。
