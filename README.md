# ClawLink 会话路由中心

在 macOS / Windows 上把多个 OpenClaw 微信账号、Telegram、飞书、Discord Bot 的文字消息转发到原生应用聊天、PI Coding Agent 的会话文件、Paseo 的已有会话，读取回复后发回原聊天。包含中文 / 英文前端和本地 Node.js 后端，沿用目标软件 / PI 的登录与模型配置，ClawLink 不收集模型 API Key。原生聊天能否绑定取决于目标应用是否暴露可用的系统无障碍接口。

## 安装包

### Windows 10/11 x64

Windows 与 macOS 共用微信 / Telegram / 飞书 / Discord 接入、路由切换、指令编辑、账户权限和 AI 主动发消息代码。Windows 使用 Electron 独立窗口及系统托盘、UI Automation 会话连接器；自带 Node 和 .NET Framework 连接器，无需另装 Node。当前为未签名的测试版本。

GitHub 仓库的 **Actions → Windows build and validation** 在 `main` 更新时自动构建并验证；成功后从该次运行的 **Artifacts → ClawLink-Windows-x64** 下载。`ClawLink-1.2.0-Windows-x64-setup.exe` 为当前用户安装，ZIP 为解压运行版；普通更新安装包会保留 `%APPDATA%\ClawLink` 中的账号和配置。不要把自己的数据目录放进解压目录或上传到仓库。Mac 和 Windows 各自保存配置，同一机器人应只由一台电脑上的一个 ClawLink 实例接收，避免重复回复。

安装后在「设置」开启「登录 Windows 后自动启动」。关闭窗口后继续在托盘接收消息，通过托盘「退出并停止机器人」结束服务。解压版开启自启后应保持 exe 路径不变。启动权限只用于当前用户，不需要管理员权限。截图截取主屏幕，只需开启账户截图权限；没有 macOS 的屏幕录制授权步骤，锁屏 / 无交互桌面时拒绝截图。

**Windows 原生会话绑定**：先运行目标 Windows 应用，添加路由会话时从实际发现的应用中选择。连接器按完整 exe 路径、唯一窗口标题及聊天正文标识确认目标；操作普通用户权限的窗口，不支持绕过管理员权限、锁屏或安全桌面。目标需提供 UI Automation 文本和按钮接口，未暴露输入框 / 回复区域 / Invoke 按钮的版本会明确拒绝绑定或发送。Electron 应用可尝试用其 `--force-renderer-accessibility` 启动选项暴露元素，然后重新检查。不会假定所有版本的 ChatGPT / Codex / Claude Windows 客户端均兼容；真实目标仍需手工测试发送和回传。

PI 支持 Windows npm 安装入口，或者用 `PI_CLI_PATH` 指定 `cli.js` 完整路径；npm `.cmd` 解析为 Node 脚本执行，消息和路径不经过 cmd.exe 拼接。Paseo 自动检查当前用户安装目录和 Program Files，也可设置 `PASEO_APP_PATH` 为安装目录或 `Paseo.exe`；仍要求该安装版本提供兼容 SDK。

### macOS Apple Silicon

`release/ClawLink-1.2.0-macOS-arm64.zip` 是 macOS 13.5+、Apple Silicon 的本地测试安装包。解压后将 `.app` 拖到「应用程序」并打开。安装包自带 Node、连接器和界面，无需安装开发工具；控制台直接显示在 ClawLink 的独立 App 窗口中，Dock 和菜单栏均有入口。关闭窗口后继续接收机器人消息；菜单栏或 Cmd+Q 退出时停止服务。

在 App 的「设置」中开启「登录 Mac 后自动启动 ClawLink」。如系统要求批准，点击「打开系统登录项」，允许 ClawLink；界面按系统实际注册状态显示，不会默认开启自启。它在用户登录后运行，电脑仍需保持登录、联网。

本地服务使用系统分配的空闲端口，实际地址由软件打开。界面资源全部保存在安装包中；登录和聊天仍需要网络。安装包采用本地 ad-hoc 签名，**尚未经过 Developer ID 签名及 Apple 公证，不能作为已完成公证的公开发行版**。不要关闭系统的 Gatekeeper；本地遇到系统阻止时可按 macOS 的「隐私与安全性 → 仍要打开」流程处理。

开发版与安装包各自保存数据；请避免两者同时接收同一个账号。安装包数据位于 `~/Library/Application Support/ClawLink`，更新 `.app` 不会移除这些数据。

## 从源码启动

需要 Node.js 22+。macOS 还需 Xcode Command Line Tools（`xcode-select --install`，用于编译 Swift）；Windows 10/11 x64 使用系统 .NET Framework 4.8 编译器。

```bash
npm ci
npm run native:build
npm start
```

开发调试打开 <http://localhost:4173>。macOS 双击 `scripts/start.command` 会打开构建好的独立 App；尚未构建时自动构建。修改源码后请重新执行 `npm run release`（Mac）或 `npm run release:windows`（Windows）再打开 App。服务仅监听 `127.0.0.1`，不能直接部署到远程服务器操作本机软件。

## 使用顺序

1. 在控制台「会话空间」点击「添加路由会话」，填写用于 `/switch` 的名称，选择目标。这只是添加路由配置，不会强制新建 Codex / Paseo 聊天。
2. **Codex / ChatGPT / Claude**：在目标软件中打开已有聊天，选择窗口并读取元素。Codex 的 Bundle ID 是 `com.openai.codex`，本机名称可能显示为 ChatGPT；旧 ChatGPT 客户端是 `com.openai.chat`。ClawLink 按应用标识识别，不根据 API Key / ChatGPT 登录方式限制绑定。选择当前聊天的唯一标识、输入框、回复容器和发送按钮，保存时校验窗口。
3. **PI Coding Agent**：选择已有 `.jsonl` 会话文件，或创建新 PI 会话。PI 中 `/session` 可查看文件路径；控制台也会列出 `~/.pi/agent/sessions` 下最近的会话。已有文件沿用上下文和工作目录；新会话存于 ClawLink 数据目录的 `pi-sessions`。可选填 provider / model，留空沿用 PI 配置。需先在 PI 中完成登录，PI 使用其现有工具权限；避免从终端和 ClawLink 同时修改同一个会话文件。
4. **Paseo**：安装并启动桌面客户端，在列表按标题 / 工作目录搜索并选择已有会话，或粘贴完整会话 UUID。沿用该会话的模型、工具与权限。适配器通过已安装 Paseo 的 SDK 连接其本机 daemon，不依赖窗口输入框。当前按 Paseo 0.7.2 接口验证；自定义安装路径可通过 `PASEO_APP_PATH` 设置，SDK 不兼容会明确报错。
5. **辅助功能只用于原生窗口绑定**。检查显示「已允许」就无需重复授权。未允许时点击「请求系统授权」，在系统设置 → 隐私与安全性 → 辅助功能中允许发起操作的进程。源码模式可能显示启动服务的 Codex / 终端或 `ClawLinkBridge`，不一定存在名为 ClawLink 的项目；安装包模式可添加 ClawLink.app。界面显示桥接进程路径，可在“+”文件选择器用 Cmd+Shift+G 定位，最终以重新检查结果为准。PI / Paseo 会话适配器无需辅助功能。
6. 添加微信机器人，使用微信扫描腾讯 iLink / OpenClaw 返回的二维码。如手机显示数字，在前端输入验证码。Telegram 使用 @BotFather 的 Bot Token；飞书使用 App ID / App Secret；Discord 使用 Bot Token，后三者**不使用二维码登录**。一个账号 / 应用只应由一个服务接收消息。
7. **微信扫码确认后自动授权扫码账号，无需 `/pair`**；已登录的旧微信账号也会自动兼容。Telegram、飞书、Discord 需在 Bot **私聊**中发送控制台提供的 `/pair 配对码`，授权此聊天。配对码使用后失效；可在机器人管理中生成新码。群聊或服务器频道需手工填写正确的聊天 ID；飞书群聊及 Discord 服务器频道仅响应 @ 此机器人的消息，群成员共享该聊天路由。
8. 给机器人发普通文字，会自动转发到机器人当前默认会话。创建机器人时可以选择默认会话；如果当时还没有选择，ClawLink 会使用唯一启用的自定义路由目标，或在没有自定义路由时使用第一个已绑定会话，因此不需要每次先发切换指令。存在多个自定义路由且没有默认目标时，先用前端「切换到此会话」或机器人 `/switch 会话名` 选择目标。成功转发后默认会在原聊天附带目标提示，可在「账户权限」关闭。会话菜单可手工发送测试消息确认完整回复。

## 外观与语言设置

点击左侧「设置 → 主题」，选择 **暗色 / 亮色 / 跟随系统**。立即生效，默认跟随系统；系统外观变化时自动更新。偏好保存在本机数据目录，刷新、升级和重启换端口后仍保留；浏览器版、Mac 和 Windows 使用相同设置。

在同一设置窗口的「界面语言」中选择 **简体中文 / English**，立即切换页面、导航、弹窗和提示文字。语言偏好保存在本机，刷新、升级和重启后恢复；切换语言不会翻译或修改用户名称、路径、消息、自定义指令和日志内容。

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
| `/pair 配对码` | Telegram / 飞书 / Discord 首次授权私聊；微信扫码后自动授权 |
| `/help`、`/start` | 帮助 |
| `/sessions` | 列出会话名称、ID 与绑定状态 |
| `/route` | 当前目标和启用的规则 |
| `/switch 会话名` 或 `/switch 会话ID` | 只切换当前聊天的会话；会话名可以含空格 |
| `/broadcast` | 下一条普通消息发送到全部已绑定会话，之后恢复原目标 |
| `/pause` | 暂停当前聊天 |
| `/resume` | 恢复当前聊天 |
| `/screenshot` | 截取当前主屏幕并向原聊天发送图片；需允许此账户截图和 macOS 屏幕录制权限 |
| `/research 消息内容` | 示例：在前端创建 `/research` 自定义路由后，仅转发后面的内容 |

匹配顺序：暂停状态 → 下一条广播 → 精确匹配的自定义指令 → 聊天独立路由 → 机器人默认规则。未知 `/指令` 返回帮助，不会发到目标会话。前端切换默认不会覆盖已经独立切换过的聊天。

以上为默认名称。「指令设置」可以修改所有内置指令的触发词、帮助说明和可选表情，包括 `/help`、`/pair` 和截图指令。可用中文、Unicode emoji 或 `[微笑]` 等微信表情文本；名称须为单个词、不重复。修改后旧名称失效，帮助、配对提示、速览和前端切换跟随更新。自定义路由在「路由规则」中编辑触发词、说明和表情；「默认」是路由类型，无需聊天指令。指令设置中的帮助预览可按账户查看，微信不显示配对指令。

## 新增机器人：飞书与 Discord

所有平台共用多机器人、普通消息直接转发、`/switch`、自定义路由、单次广播、权限、截图回传和 AI 收件人功能。飞书 / Discord 使用出站长连接，无需公网域名、Webhook 或路由器端口转发。ClawLink 运行期间保持联网即可。

### 飞书企业自建机器人

1. 在 [飞书开发者后台](https://open.feishu.cn/app) 创建企业自建应用，在「应用能力」开启机器人。
2. 在「权限管理」为应用申请私聊读取 `im:message.p2p_msg:readonly`、群内 @ 机器人消息读取 `im:message.group_at_msg:readonly`、机器人发送 `im:message:send_as_bot`。需要截图回传时还需图片资源权限 `im:resource`。权限名称可能随控制台语言显示不同，请按权限代码搜索。
3. 在「事件与回调」选择 **使用长连接接收事件**，订阅 `im.message.receive_v1`。首次保存可能要求检测到正在运行的连接：先在 ClawLink 添加应用凭据并保持运行，再返回控制台保存。
4. 发布应用版本，配置可用范围包含自己及要使用的用户，完成企业要求的权限审批。
5. 在 ClawLink「添加机器人」选择「飞书 Bot」，填写名称、App ID / App Secret，选择默认会话并点击「验证并连接」。凭据验证通过后，真实长连接握手完成才显示在线；没有成功连接时按错误检查发布、事件配置或网络。
6. 在飞书与该机器人的**私聊**中发送软件显示的配对指令，收到配对成功提示后直接发送普通文字。

飞书群聊先添加机器人，再在「允许的聊天 ID」填写对应 `oc_…` 群 `chat_id`（可通过飞书开发者 API 调试台查询机器人所在群）。在群内 **@机器人** 后发送文字或指令；未 @、未授权群、其他机器人事件不会转发。当前仅支持国内飞书企业自建应用，不包含国际版 Lark / 应用商店第三方应用。

### Discord Bot

1. 在 [Discord Developer Portal](https://discord.com/developers/applications) 创建应用，在 Bot 页面生成 **Bot Token**。这是机器人凭据，不使用个人账号 Token。
2. 在 Bot 页开启 **Message Content Intent**（超过平台规模限制时还需 Discord 审批）。ClawLink 不申请成员名单或在线状态特权 Intent。
3. 用 OAuth2 的 `bot` scope 生成邀请链接，将机器人加入服务器，授予 View Channel、Send Messages、Read Message History；截图功能还需 Attach Files。频道自身的权限覆盖也必须允许机器人操作。
4. 在 ClawLink「添加机器人」选择「Discord Bot」，填写 Token、名称和默认会话。通过 Token 验证及 Gateway 握手后显示在线。
5. 打开与机器人的 DM（通常需要共享服务器且允许私信），发送软件显示的配对指令。收到成功提示后直接发普通文字；可用 `/switch 会话名` 切换。

服务器频道先在 Discord 设置开启「高级 → 开发者模式」，右键频道「复制频道 ID」，将其填入 ClawLink 的允许聊天列表。频道消息必须 **@机器人** 才处理；授权一个频道后该频道所有能发消息的成员共享路由。AI 输出中的 `@everyone` 等提及以文字发送，不产生通知。当前不处理 Discord 论坛 / 帖子创建或应用 slash interactions；这里的 `/switch` 是普通消息里的文字指令。

### 连接维护与隐私

同一平台可以添加多个机器人，分别路由到不同会话或共享一个会话。暂时断网时由官方 SDK 重连；停止、删除或更换凭据会关闭旧连接并丢弃旧连接排队中的消息。换同一机器人的凭据保留聊天授权和已接收消息去重；如果改连另一个机器人，会清除旧聊天授权、收件人和聊天独立路由，要求重新配对。

凭据仅保存在本地私有 `secrets.json`，前端不回显；只把 SDK 和平台适配代码加入源码及安装包白名单。新增平台通过模拟 HTTP 服务和 SDK 事件进行自动测试，**尚未使用个人飞书 / Discord 账户完成真实收发验收**。

## 账户权限和截图

在「机器人 → 管理 → 账户权限」分别设置每个机器人账户：

- **向 AI 发消息**：控制普通文字和自定义路由是否转发给 AI。
- **转发成功提示**：默认开启；转发成功后在原机器人聊天附带目标会话名称，可单独关闭。
- **接收 AI 主动消息**：控制 AI 工具、回复中的发送指令和控制台通知能否发往此账户。还需开启目标收件人的「AI 发送」；普通提问的回复和机器人指令结果继续回传。
- **允许截图**：默认关闭。开启后仍需允许截图这条指令，并在 App「设置」中请求 macOS 屏幕录制权限。
- **可用指令**：逐条控制内置及自定义路由指令；改名后保留原权限。帮助自动隐藏禁用指令。

从已授权聊天发送默认 `/screenshot`，将当前主屏幕截为图片，微信通过加密 CDN 上传，Telegram 通过 `sendPhoto`、飞书通过图片资源 API、Discord 通过文件附件发回原聊天。截图不发给 AI，不保存到聊天日志；临时文件用后删除，锁屏时拒绝截图。仅支持主屏幕，不拼接多个显示器。系统授权变更可能需要重新打开 App。截图发送失败不会自动重试，真实平台图片收发仍需在用户自己的聊天中验收。

## 让 AI 选择机器人收件人

在「AI 发消息」页面管理收件人。微信扫码账号、已配对的 Telegram / 飞书 / Discord 私聊或手工授权的聊天会自动加入列表；可以将其命名为「工作微信」「私人 TG」等，并开启该收件人的「AI 发送」。多个机器人下的聊天各有独立 ID，即使聊天 ID 相同也不会混用连接。这里只发送到已经授权的机器人聊天，不能搜索或主动联系任意平台用户。

微信发送使用该聊天最近收到的 `context_token`，单独保存在私有凭据文件中。扫码后先从本人微信给机器人发一条消息即可取得上下文；如果提示缺少或失效，请从目标微信聊天给机器人重新发一条消息。重新扫码会清除旧上下文。Telegram 私聊需先与 Bot 开始聊天 / 配对，群聊需授权正确群 ID。平台接受消息仅表示发送请求成功，不表示设备已读。

「接入 AI」提供三种用法，配置使用当前服务的实际路径，适用于源码版和安装包：

1. **MCP 工具**：将页面生成的配置合并到支持 MCP stdio 的 AI 客户端中。工具 `clawlink_list_recipients` 列出已开启的收件人名称、ID、平台和可用状态，`clawlink_send_message` 发送到指定 ID。可以告诉 AI：“任务完成后，把结果发到工作微信。”不要覆盖客户端已有 MCP 配置。
2. **终端工具**：把页面的「AI 接入说明」复制给能执行命令的 AI，例如在本机工作的编码代理。先列举收件人，发送 JSON 从 stdin 输入，避免消息内容被 shell 展开。不会修改 AI 客户端的登录和配置。
3. **原生会话回复指令**：在本页开启对应会话的「回复指令发送」。通过 ClawLink 转发提问时，会附带已开启且可用的收件人和本轮格式。AI 在最终回复中输出 `clawlink-send` JSON 代码块，ClawLink 校验本轮标识和全部目标后执行并回报结果。最多 5 条消息；仅在 ClawLink 发起的轮次内生效。在原生软件中直接输入的新消息，需通过前两种工具方式主动发送。

源码版终端示例（安装包请使用页面生成的绝对路径）：

```bash
npm run ai:recipients
node server/ai-client.js send <<'JSON'
{"recipientId":"从列表选择真实 ID","text":"任务完成，请查看结果。","requestId":"为此消息生成一个新的 UUID"}
JSON
```

`requestId` 为 8 至 128 位字母、数字或 `_.:-`，建议使用 UUID。同一消息重试必须沿用原 ID；重复调用返回之前的提交结果，失败或结果不确定时不会重新发送。服务保留最近 1000 个已结束尝试以及未确认的尝试，重启后继续去重。平台失败、超时或长消息部分分块失败时，请先检查目标聊天，不要换 ID 自动重发。

AI 工具只访问本机服务，凭据由 `ai-client.js` 从私有 `ai-endpoint.json` 读取，不出现在 MCP 配置或命令参数中。前端可以手工选择收件人发送文字；发送活动只记录目标和结果，不记录正文。新增收件人默认关闭 AI 发送，撤销聊天授权会自动移除收件人。

## 本地数据

Git 仓库只包含源码、依赖清单、构建脚本、测试和文档。`.gitignore` 排除运行数据、登录凭据、路由与聊天绑定、PI 会话文件、备份、日志、本地环境文件、编辑器及代理设置、签名密钥和生成的安装包。克隆仓库后需自行登录并配置，不会带入开发者的本地账号或会话。

- 数据目录：源码版为 `server/data`；Mac 安装包为 `~/Library/Application Support/ClawLink`，Windows 安装包为 `%APPDATA%\ClawLink`。Windows 使用当前用户和 SYSTEM 的目录 ACL，子文件继承；Windows 不以 POSIX `600` 作为权限验证依据。
- `state.json`：会话绑定、机器人元数据、路由、主题和界面语言偏好、账户权限、指令名称和帮助说明、指标、最近 200 条活动。日志保存事件信息，不记录完整消息正文。
- `secrets.json`：平台 Token、飞书 App ID / App Secret、消息游标、去重记录、配对码、允许的聊天 ID、每个微信聊天的上下文、AI 工具本机令牌和发送去重记录。文件权限为 `600`、目录为 `700`；本地明文保存，未采用钥匙串加密。所有运行数据已加入 `.gitignore`，HTTP 不提供这些文件，状态接口不返回平台 Token、App Secret、微信上下文或 AI 工具令牌。
- `ai-endpoint.json`：启动时生成的本机端点和 AI 工具令牌，权限 `600`，退出时移除。MCP / CLI 每次调用重新读取，服务重启换端口后无需重启工具进程。收件人名称、开关和会话回复指令开关保存在 `state.json`。
- `service.lock` 阻止同一数据目录的重复服务；已退出进程的锁可以恢复，无法读取的锁会保留并报告错误。安装包的 `service.log`、`endpoint.json`、`window-status.json` 用于本地启动诊断。迁移源码数据到 App 时，先停止源码服务，仅复制配置、凭据和需要的 PI 会话，不复制锁和临时端点；在 App 中重新复制 AI 接入配置，更新运行时及数据路径。
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

后端和浏览器测试使用本地 HTTP 平台服务、官方 SDK 连接替身及原生连接器替身，验证 PI 会话续聊 / stdin / 排队、Paseo 时间线回复定位 / 授权 / 超时、跨类型 `/switch`、QR 请求 / 验证码 / 过期、Token 校验、微信上下文回传、Telegram 长轮询与去重、独立路由、单次广播、失效绑定拒绝发送、持久化和浏览器完整操作。`test:ui:production` 用构建产物连接真实后端；平台与原生应用仍为测试替身。

`test:native` 会编译并打开临时 Cocoa 测试窗口，用真正的 Accessibility 接口完成双会话切换、发送、读取、元素身份重定位、粘贴和草稿保护，需要辅助功能权限。测试专用 Bundle ID 仅在 `CLAWLINK_TESTING` 编译下可用；生产连接器按 Bundle ID 动态发现 Codex、Paseo、ChatGPT、Claude 和其它有窗口的应用。

新增测试验证全部指令改名、动态帮助和持久化、每个账户的双向消息权限、截图撤权拦截、Telegram 图片表单以及微信 AES 加密上传。截图测试使用内存图片和本地模拟平台，不读取或发送个人屏幕。

`test:release` 启动独立安装包，在没有 Node 的 PATH 中验证内置运行时、生产前端、本地 API、数据隔离与退出停止，并实际打开 WKWebView 窗口验证 UI 和原生设置桥接。所有测试使用临时数据，不登录个人账号或向个人聊天发送消息；不会注册登录项或请求屏幕录制权限。当前验证结果与尚待完成的发行门槛见 `RELEASE_CHECKLIST.md`。

## 构建与公开发行

Windows x64 主机执行 `npm run release:windows`，生成 NSIS 安装包、ZIP、SHA-256 文件和 `manifest-windows.json`。随后运行 `npm run test:windows` 验证真实 UI Automation 测试窗口、打包后的 Electron 窗口、内置运行时、数据隔离及退出停止。测试不修改登录项、不登录个人账号；CI 中的截图只读取一次性 runner 桌面。普通 macOS 主机不能作为 Windows 原生运行验证环境。

Windows CI 使用干净 checkout 构建，两个平台使用相同服务文件白名单；不会从开发者机器读取配置、Token、路由、历史或备份。只有构建和 Windows 运行测试成功才上传安装产物。推送 `v*` 标签时附加到对应 GitHub Release；不存在该 Release 则创建草稿，不自动公开发行。当前未配置 Authenticode 签名，发布前仍需验证用户的真实目标应用、开机自启、最低 Windows 版本和代码签名。

在 Apple Silicon macOS 上执行 `npm run release`，生成 `.app`、ZIP、SHA-256 文件和 `manifest.json`。构建只收集指定服务文件、生产依赖及前端产物，不包含运行数据、Token、测试应用或开发依赖。Node 及依赖许可证随包附带。

如具备 Developer ID，构建时设置 `CLAWLINK_SIGN_IDENTITY` 为证书名称。随后使用自己的 Apple 公证配置提交 ZIP：

```bash
xcrun notarytool submit release/ClawLink-1.2.0-macOS-arm64.zip --keychain-profile YOUR_PROFILE --wait
xcrun stapler staple release/ClawLink-1.2.0-arm64.app
spctl --assess --type execute --verbose release/ClawLink-1.2.0-arm64.app
```

公证成功、staple 与系统评估均通过后，再重新压缩已 staple 的 `.app` 并生成新校验和。构建产生的 manifest 默认记录 `notarized: false`；只有实际公证通过后才应更新发行记录。

## 代码

- `server/adapters.js`：统一平台接口、腾讯 OpenClaw 微信协议和 Telegram Bot API。
- `server/bot-platforms.js`：飞书官方 SDK 长连接、Discord.js Gateway、凭据验证、消息过滤和文字 / 图片发送。
- `server/platforms.js`：平台名称与凭据就绪判断。
- `server/pi.js`：PI CLI 会话文件绑定和 JSON 回复提取。
- `server/paseo.js` / `paseo-worker.mjs` / `paseo-core.cjs`：Paseo 本机 SDK 会话发现、验证、发送和本轮回复提取。
- `server/cli.js`：子进程、stdin、超时停止与目标队列。
- `server/native.js`：原生操作排队、等待生成、提取新增回复。
- `native/ClawLinkBridge.swift`：macOS Accessibility 窗口发现、检查、标识验证、发送读取及屏幕截图。
- `native/ClawLinkApp.swift`：独立 App 窗口、WebKit 原生设置桥接、登录项、菜单栏、本地服务生命周期。
- `native/windows/ClawLinkBridge.cs`：Windows UI Automation 会话发现、校验、发送、回复读取及内存截图。
- `windows/main.cjs` / `preload.cjs`：Windows 窗口、托盘、自启、受限设置桥接、本地服务生命周期。
- `scripts/release-windows.js` / `.github/workflows/windows.yml`：Windows 安装包构建及实际 Windows 环境验证。
- `server/index.js`：持久化、授权聊天、路由、接收循环、前端 API。
- `server/messaging.js`：收件人、微信上下文隔离、AI 发送权限、发送去重及本轮回复指令。
- `server/ai-client.js`：AI 消息工具的 MCP stdio / CLI 入口。
- `server/commands.js` / `server/permissions.js`：可编辑指令、动态帮助和账户权限。
- `app.js` / `index.html` / `styles.css`：真实 API 驱动的控制台。
- `scripts/release.js`：独立安装包构建、签名和校验和。

微信协议参考 `@tencent-weixin/openclaw-weixin` 2.4.10。软件独立实现 iLink 接入，不修改用户已有的 OpenClaw 配置。

## 许可证

ClawLink 自有源码以 [Apache License 2.0](LICENSE) 发布，版权声明见 [NOTICE](NOTICE)。允许在协议条件下使用、修改、分发和商业使用；分发时保留许可证、相关声明，并注明修改。协议含明确的专利授权，不授予商标使用权。

第三方依赖和运行时遵循各自许可证。Mac 和 Windows 安装包附带 ClawLink 的 `LICENSE` / `NOTICE` 以及相应第三方声明，不会将第三方组件改为 Apache 2.0。

飞书 / Discord 接入依赖官方 `@larksuiteoapi/node-sdk` 和 `discord.js`，npm 锁文件固定版本；安装包附带各依赖原有许可证。
