# ClawLink 会话路由中心

在 macOS 上把多个 OpenClaw 微信账号、Telegram Bot 的文字消息转发到 Codex、ChatGPT、Claude 的原生聊天、PI Coding Agent 的会话文件、Paseo 的已有会话，读取回复后发回原聊天。包含中文前端和本地 Node.js 后端，沿用目标软件 / PI 的登录与模型配置，ClawLink 不收集模型 API Key。

## 安装包

`release/ClawLink-1.0.0-macOS-arm64.zip` 是 macOS 13.5+、Apple Silicon 的本地测试安装包。解压后将 `.app` 拖到「应用程序」并打开。安装包自带 Node、连接器和生产版前端，无需安装开发工具；菜单栏出现 ClawLink，并自动打开控制台。菜单栏可以重新打开控制台、进入辅助功能设置或退出并停止机器人。

本地服务使用系统分配的空闲端口，实际地址由软件打开。界面资源全部保存在安装包中；登录和聊天仍需要网络。安装包采用本地 ad-hoc 签名，**尚未经过 Developer ID 签名及 Apple 公证，不能作为已完成公证的公开发行版**。不要关闭系统的 Gatekeeper；本地遇到系统阻止时可按 macOS 的「隐私与安全性 → 仍要打开」流程处理。

开发版与安装包各自保存数据；请避免两者同时接收同一个账号。安装包数据位于 `~/Library/Application Support/ClawLink`，更新 `.app` 不会移除这些数据。

## 从源码启动

需要 macOS、Node.js 22+、Xcode Command Line Tools（`xcode-select --install`，用于编译 Swift）。

```bash
npm ci
npm run native:build
npm start
```

打开 <http://localhost:4173>。也可以双击 `scripts/start.command`。服务仅监听 `127.0.0.1`，不能直接部署到远程服务器操作本机软件。

## 使用顺序

1. 在控制台「会话空间」点击「添加路由会话」，填写用于 `/switch` 的名称，选择目标。这只是添加路由配置，不会强制新建 Codex / Paseo 聊天。
2. **Codex / ChatGPT / Claude**：在目标软件中打开已有聊天，选择窗口并读取元素。Codex 的 Bundle ID 是 `com.openai.codex`，本机名称可能显示为 ChatGPT；旧 ChatGPT 客户端是 `com.openai.chat`。ClawLink 按应用标识识别，不根据 API Key / ChatGPT 登录方式限制绑定。选择当前聊天的唯一标识、输入框、回复容器和发送按钮，保存时校验窗口。
3. **PI Coding Agent**：选择已有 `.jsonl` 会话文件，或创建新 PI 会话。PI 中 `/session` 可查看文件路径；控制台也会列出 `~/.pi/agent/sessions` 下最近的会话。已有文件沿用上下文和工作目录；新会话存于 ClawLink 数据目录的 `pi-sessions`。可选填 provider / model，留空沿用 PI 配置。需先在 PI 中完成登录，PI 使用其现有工具权限；避免从终端和 ClawLink 同时修改同一个会话文件。
4. **Paseo**：安装并启动桌面客户端，在列表按标题 / 工作目录搜索并选择已有会话，或粘贴完整会话 UUID。沿用该会话的模型、工具与权限。适配器通过已安装 Paseo 的 SDK 连接其本机 daemon，不依赖窗口输入框。当前按 Paseo 0.7.2 接口验证；自定义安装路径可通过 `PASEO_APP_PATH` 设置，SDK 不兼容会明确报错。
5. **辅助功能只用于原生窗口绑定**。检查显示「已允许」就无需重复授权。未允许时点击「请求系统授权」，在系统设置 → 隐私与安全性 → 辅助功能中允许发起操作的进程。源码模式可能显示启动服务的 Codex / 终端或 `ClawLinkBridge`，不一定存在名为 ClawLink 的项目；安装包模式可添加 ClawLink.app。界面显示桥接进程路径，可在“+”文件选择器用 Cmd+Shift+G 定位，最终以重新检查结果为准。PI / Paseo 会话适配器无需辅助功能。
6. 添加微信机器人，使用微信扫描腾讯 iLink / OpenClaw 返回的二维码。如手机显示数字，在前端输入验证码。Telegram 使用 @BotFather 的 Bot Token，**不使用二维码登录**。一个账号 / Token 只应由一个服务接收消息。
7. 控制台提供 `/pair 配对码`。在微信或 Telegram **私聊**中发送一次，授权此聊天。配对码使用后失效；可在机器人管理中生成新码。Telegram 群聊可手工填写群 ID（通常为负数），群内允许的成员共享该群路由。
8. 给机器人发普通文字，转发到配置的会话。不同机器人可以选不同会话，也可以共享；前端「切换到此会话」或机器人 `/switch 会话名` 均可切换。会话菜单可手工发送测试消息确认完整回复。

## 原生会话绑定说明

- **会话标识**：选择正文中当前聊天的唯一标题 / 静态文本，避免通用应用名称或侧栏其他聊天标题。每次发送和读取回复都会检查标识。
- **会话入口（可选）**：绑定原生侧栏中可点击的目标聊天按钮。消息到来时先点击入口，再校验正文标识。多会话共享一个原生窗口时需要各自的入口，否则必须手动保持目标聊天打开。
- **回复容器**：推荐选择仅包含当前聊天正文的容器，使用「整个聊天容器：只读取新增内容」。如果明确有一个随回复更新的「最新助手回复」元素，选择相应模式。回复容器包含输入框、侧栏、按钮文本时可能无法正确提取答案，请用会话菜单中的真实测试消息验证。
- **停止生成按钮（可选）**：生成时可见的停止按钮可用于判断回复仍在生成。连接器还会识别常见中英文停止按钮；之后等待文本稳定再回传。
- 保存绑定时记录原生元素的类型、名称和可用标识。位置变化后只有唯一匹配的元素才会被重新定位；无法确认时停止操作。所有原生操作串行执行；输入框有草稿、窗口不唯一、标识变化、生成未完成或元素失效时拒绝发送。应用升级后可能需要重新绑定。
- Claude 使用兼容粘贴，让原生编辑器接收到输入事件。ChatGPT 优先尝试直接写入，也可在前端改为「兼容粘贴」。粘贴前验证焦点及目标进程，发送前逐字验证内容；操作后恢复原剪贴板，如果用户期间改变剪贴板则保留用户的新内容。
- macOS 辅助功能接口取决于应用版本，并非这些软件的官方会话 API。ClawLink 会动态发现正在运行的普通 macOS 应用，可按 Bundle ID 绑定；Codex 输入框在本机已读取，真实发送 / 回复仍需用户选定聊天后验证。
- PI 和 Paseo 使用专用会话适配器。同一目标的 ClawLink 消息排队：PI 以完整文件路径续聊，从 JSON 事件读取最终助手文本；Paseo 以完整会话 ID 发送，从时间线中按客户端消息 ID 和轮次识别本次助手文本。运行中的 Paseo 会话拒绝发送；需要授权时请在 Paseo 处理并查看后续回复。超时不会自动重发。Paseo 桌面窗口未暴露标准输入框，因此推荐会话适配器。
- 本版支持文字和微信已转写的语音；不转发图片、文件或未转写语音。电脑需保持开机、登录、网络连接，原生窗口目标还需保持目标应用运行。

## 机器人指令

| 指令 | 行为 |
| --- | --- |
| `/pair 配对码` | 首次授权私聊 |
| `/help`、`/start` | 帮助 |
| `/sessions` | 列出会话名称、ID 与绑定状态 |
| `/route` | 当前目标和启用的规则 |
| `/switch 会话名` 或 `/switch 会话ID` | 只切换当前聊天的会话；会话名可以含空格 |
| `/broadcast` | 下一条普通消息发送到全部已绑定会话，之后恢复原目标 |
| `/pause` | 暂停当前聊天 |
| `/resume` | 恢复当前聊天 |
| `/research 消息内容` | 示例：在前端创建 `/research` 自定义路由后，仅转发后面的内容 |

匹配顺序：暂停状态 → 下一条广播 → 精确匹配的自定义指令 → 聊天独立路由 → 机器人默认规则。未知 `/指令` 返回帮助，不会发到目标会话。前端切换默认不会覆盖已经独立切换过的聊天。

## 本地数据

Git 仓库只包含源码、依赖清单、构建脚本、测试和文档。`.gitignore` 排除运行数据、登录凭据、路由与聊天绑定、PI 会话文件、备份、日志、本地环境文件、编辑器及代理设置、签名密钥和生成的安装包。克隆仓库后需自行登录并配置，不会带入开发者的本地账号或会话。

- 数据目录：源码版为 `server/data`，安装包为 `~/Library/Application Support/ClawLink`。
- `state.json`：会话绑定、机器人元数据、路由、指标、最近 200 条活动。日志保存事件信息，不记录完整消息正文。
- `secrets.json`：平台 Token、消息游标、去重记录、配对码与允许的聊天 ID。文件权限为 `600`、目录为 `700`；本地明文保存，未采用钥匙串加密。所有运行数据已加入 `.gitignore`，HTTP 不提供这些文件，状态接口不返回平台 Token。
- `service.lock` 阻止同一数据目录的重复服务；已退出进程的锁可以恢复，无法读取的锁会保留并报告错误。安装包的 `service.log`、`endpoint.json` 用于启动诊断。
- 重启恢复已启用的接收连接。入站消息先记录去重 ID 再派发，避免重启重复发送；进程在派发前崩溃可能丢失该消息。原生发送超时或平台回传失败不会自动重发，以免重复提交。退出时正在处理的消息也可能中断，请检查原生聊天后再决定是否重发。
- 从之前的模拟控制台升级时，旧数据保存为 `prototype-backup-*.json`，新状态为空；不会把演示机器人标记为真实连接。

## 验证

```bash
npm run check
npm run build
npm test
npx playwright install chromium
npm run test:ui
npm run test:ui:production
npm run test:native
npm run release
npm run test:release
```

已安装 Google Chrome 的机器也可执行 `CLAWLINK_TEST_CHROME=1 npm run test:ui`。

后端和浏览器测试使用本地 HTTP 平台服务及原生连接器替身，验证 PI 会话续聊 / stdin / 排队、Paseo 时间线回复定位 / 授权 / 超时、跨类型 `/switch`、QR 请求 / 验证码 / 过期、Token 校验、微信上下文回传、Telegram 长轮询与去重、独立路由、单次广播、失效绑定拒绝发送、持久化和浏览器完整操作。`test:ui:production` 用构建产物连接真实后端；平台与原生应用仍为测试替身。

`test:native` 会编译并打开临时 Cocoa 测试窗口，用真正的 Accessibility 接口完成双会话切换、发送、读取、元素身份重定位、粘贴和草稿保护，需要辅助功能权限。测试专用 Bundle ID 仅在 `CLAWLINK_TESTING` 编译下可用；生产连接器按 Bundle ID 动态发现 Codex、Paseo、ChatGPT、Claude 和其它有窗口的应用。

`test:release` 启动独立安装包，在没有 Node 的 PATH 中验证内置运行时、生产前端、本地 API、数据隔离与退出停止。所有测试使用临时数据，不登录个人账号或向个人聊天发送消息。当前验证结果与尚待完成的发行门槛见 `RELEASE_CHECKLIST.md`。

## 构建与公开发行

在 Apple Silicon macOS 上执行 `npm run release`，生成 `.app`、ZIP、SHA-256 文件和 `manifest.json`。构建只收集指定服务文件、生产依赖及前端产物，不包含运行数据、Token、测试应用或开发依赖。Node 及依赖许可证随包附带。

如具备 Developer ID，构建时设置 `CLAWLINK_SIGN_IDENTITY` 为证书名称。随后使用自己的 Apple 公证配置提交 ZIP：

```bash
xcrun notarytool submit release/ClawLink-1.0.0-macOS-arm64.zip --keychain-profile YOUR_PROFILE --wait
xcrun stapler staple release/ClawLink-1.0.0-arm64.app
spctl --assess --type execute --verbose release/ClawLink-1.0.0-arm64.app
```

公证成功、staple 与系统评估均通过后，再重新压缩已 staple 的 `.app` 并生成新校验和。构建产生的 manifest 默认记录 `notarized: false`；只有实际公证通过后才应更新发行记录。

## 代码

- `server/adapters.js`：腾讯 OpenClaw 微信协议和 Telegram Bot API。
- `server/pi.js`：PI CLI 会话文件绑定和 JSON 回复提取。
- `server/paseo.js` / `paseo-worker.mjs` / `paseo-core.cjs`：Paseo 本机 SDK 会话发现、验证、发送和本轮回复提取。
- `server/cli.js`：子进程、stdin、超时停止与目标队列。
- `server/native.js`：原生操作排队、等待生成、提取新增回复。
- `native/ClawLinkBridge.swift`：macOS Accessibility 窗口发现、检查、标识验证、发送和读取。
- `native/ClawLinkApp.swift`：安装包启动器、菜单栏、本地服务生命周期。
- `server/index.js`：持久化、授权聊天、路由、接收循环、前端 API。
- `app.js` / `index.html` / `styles.css`：真实 API 驱动的控制台。
- `scripts/release.js`：独立安装包构建、签名和校验和。

微信协议参考 `@tencent-weixin/openclaw-weixin` 2.4.10。软件独立实现 iLink 接入，不修改用户已有的 OpenClaw 配置。
