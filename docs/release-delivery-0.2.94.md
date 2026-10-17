# 0.2.94 有界内存结果读取通道

配套 SimpleExperiment 0.5.364 的结果汇总优化。0.2.93 的 metadata tree 与代码 inventory 已独立，但 memoryOnly 指标下载仍使用 bulk 容量；在同一服务器的大清单或传输后等待。实际 H20 存在 hashing/1532 文件的清单，元数据目录查询仍在 431 ms 得到缺失结论；这不能证明所有文件读取都能及时获得票据。

新增 memoryOnly=true 且 metricsOnly=true 的专用读取容量。现有 normalizer、内存解包器仍将实际批次限制为 4 MiB，保留路径、文件类型、白名单、长度和 SHA256 逐文件核实；不创建原始指标文件、暂存目录或恢复清单。通道仍最多两个服务器、同服务器一个，取消与失败释放使用既有 TransferCapacity。API 外层与 downloadMappedPathsCore 内层选择同一通道，避免嵌套后重新进入 bulk 队列。普通落盘下载、上传、清理和资源写入锁不变，没有让它们借用内存通道。

capabilities 增加 memoryReadLane=1、capacityTiming=1；内存下载回应增加精简 queryTiming，报告真实容量等待、执行及完成时间，不把排队当作文件读取进度。旧调用方与既有内存协议兼容。

新增真实 API 组合反例：同主机 bulk inventory 未释放时，旧版内存读取启动计数仍为 0；修复后两个内存读取均能开始，且第一份失败后票据释放、第二份能继续，磁盘目录保持为空。只改 API 外层尚不足以通过回归，内层默认 bulk 的嵌套排队也已修复。目标 metadataTreeRead 8 项与 mappedBatchDownload 26 项通过，保留坏内容、gzip 截断、SSH 失败、取消及普通落盘路径保护。

完整串行回归、确定包、源码推送、稳定发行与一次安装回执完成后补记。没有在科研服务器重放、删除或重跑任务，也不自动部署 Agent/Scheduler。新版安装后须重载才能做现场验收。

最终 `npm test` 串行 42 文件、273 项通过；递增 0.2.94 后 `npm run package` 退出 0，全部 build 门禁和 23 文件运行闭包通过。没有 20 秒挂起后重试。确定包 `simple-sftp-0.2.94.vsix`：170860 字节、26 个 ZIP 条目、21 个 JS/Python 运行文件；SHA256 `1452a52b9da84a89f760154b162d299cc79ff2496a945d67840450a75988aa92`。身份、版本、universal 平台、源锁文件、运行字节和实际 discovery 秘密排除均通过。同名清单精确绑定文件名。包已冻结，后续文档回执不改包、不覆盖历史资产。
