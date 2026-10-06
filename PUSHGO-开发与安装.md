# TaskNotes PushGo 二开安装

官方源码固定提交 69535cd956d11474b980deef8429ff0be232185f，开发分支 codex/pushgo-checkin，保留官方历史、MIT 许可证和插件 ID tasknotes。上游远程为 upstream，当前版本仍为 4.13.8；此包是本地二开测试发行物。

关闭 TaskNotes 后，备份 vault/.obsidian/plugins/tasknotes 中的旧文件，解压交付包，将 main.js、styles.css、manifest.json 放到该插件目录，再启用插件。移动端用同样三个文件通过 vault 同步工具安装；不替换日常 vault 配置或任务笔记。Obsidian 最低版本 1.12.2。

设置 → TaskNotes → 集成 → 定时通知与拍照打卡，可配置业务地址、附件目录、配对密码、默认窗口、优先级映射、早晚统计和频道凭据。先保存连接、登录配对，再保存服务器默认值和频道绑定。频道 ID 从 PushGo 复制，名称用于展示。

命令：拉取打卡记录和照片；推送设置和同步中心；接入或设置当前任务的推送打卡。TaskNotes 创建、编辑、日历调整、优先级、状态、归档及删除入口已接入。未启用集成时按原插件行为运行。

新增实现：src/api/pushgo/PushGoIntegration.ts 负责 API、操作日志和持久化；src/pushgo/model.ts 管理批准快照、显式字段补丁和托管区块；src/pushgo/uiOrigin.ts 隔离 UI 入口；src/pushgo/PushGoPanel.tsx 使用官方 shadcn 原生组件。Tailwind CSS 只扫描新增界面并加 tn-pushgo 作用域。

配对令牌保存在插件独立 pushgo-state.<设备UUID>.json 中。备份旧文件和操作队列；令牌不写入任务笔记。临时文件与备份用于断电恢复，服务器以操作 ID 和基础版本处理幂等。恢复前台/联网自动同步，操作冲突与图片失败可在同步中心查看。每台设备拥有独立队列文件，设备 UUID 保存在本机 WebView 本地存储中，避免 vault 同步覆盖另一设备的待提交操作；各设备单独配对，任务笔记中的 UUID 可跨设备关联。

正常使用 Obsidian 文件同步仍由你的 vault 同步工具负责，业务服务不替代整个 vault 同步。照片通过业务 API 单独拉取，默认目录 PushGo附件/，禁止放入任务目录。社区插件更新可能覆盖二开文件，更新前备份并按二开版本升级。

本地构建：npm ci、npm run typecheck、npm run build、npm run check:bundle-size。隔离实测必须同时安装相邻 tasknotes-pushgo-server 目录的依赖，并设置 TASKNOTES_E2E_OBSIDIAN_BINARY 为安装的 Obsidian 可执行文件、TASKNOTES_E2E_REUSE_OBSIDIAN=0、TASKNOTES_E2E_VAULT_DIR 为当前源码目录下新建的 .pushgo-e2e-vault/<随机 UUID> 绝对路径，再运行 npm run e2e -- e2e/pushgo.spec.ts。每次使用全新测试 vault 和独立 profile，不能复用日常 Obsidian；并发运行时还需要不同的 profile 与调试端口。
