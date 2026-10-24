# Claude 手机入口（claude-mobile）

用 iPhone 的 Safari 遥控家里 Mac 上的 Claude Code：看电脑上的对话（实时同步），在手机上接着聊、发图片和文件。手机自己创建的会话也支持停止和审批。可以“添加到主屏幕”，用起来像一个 App。

适合**没有用 claude.ai 账号登录**、用不了官方 Remote Control 的情况（比如用 API Key 或中转站）。

> 非 Anthropic 官方项目，当前为实验版本。Apple Silicon 在开发机上验证过；Intel 安装路径已提供，尚未在 Intel 真机上验证。

## 功能

- **实时同步**：读取 `~/.claude/projects` 里的全部对话（Claude 桌面 App、终端 `claude`、本工具自己的），电脑上有新内容，手机马上显示。
- **接着电脑的对话继续**：已在桌面打开的 Claude 对话，消息直接投递给桌面原进程；回复由同一个进程产生，电脑无需重新打开会话。
- **发图片和文件**：手机新建会话中照片直接发送（HEIC 在 Mac 上转 JPG）；电脑原会话通过本机文件引用读取附件。
- **审批和提问**：手机引擎创建的会话可在手机处理；电脑原会话仍在电脑审批。
- **模型 / 思考强度 / 权限模式**：输入框上方显示实际记录值；手机引擎会话可切换，电脑原会话需在电脑调整。
- 电脑对话运行中，手机消息排入原进程的下一次处理；停止仍需在电脑操作。

## 要求

- macOS（Apple Silicon 或 Intel）
- 这台 Mac 上 Claude Code 已经能正常使用。用 API Key 或中转站的，在 `~/.claude/settings.json` 里写好：
  ```json
  { "env": { "ANTHROPIC_BASE_URL": "https://你的中转地址", "ANTHROPIC_AUTH_TOKEN": "你的令牌" } }
  ```
- 手机和 Mac 在同一个局域网；在外面用的话，用 Tailscale 等方式连回家里局域网。

## 安装

```bash
git clone https://github.com/oceanliangcn716/claude-mobile.git ~/.local/share/claude-mobile
cd ~/.local/share/claude-mobile
./install.sh
```

国内网络可以用镜像加速 npm：

```bash
NPM_REGISTRY=https://registry.npmmirror.com ./install.sh
```

安装脚本会：下载一份独立的 Node.js（不用 sudo，不影响系统）、安装依赖、从本机 Claude.app 生成主屏幕图标、设置登录自动启动、在桌面放一个「Claude手机连接」。

## 手机连接

1. 在 Mac 上双击桌面的 **「Claude手机连接」**，配对链接会复制到剪贴板（通过“通用剪贴板”同步到 iPhone）。
2. 在 iPhone 的 Safari 地址栏粘贴打开，自动完成配对（30 天有效，经常用会自动续期）。
3. Safari 分享 → **添加到主屏幕**。

在 Mac 自己的浏览器里打开 `http://localhost:3082` 不需要配对。

## 使用说明

- 左上角：对话列表（可搜索，可按“电脑 / 手机”筛选）。右上角 ＋：新对话（选择工作目录）。
- 回车换行，点发送按钮发送；电脑键盘可用 Cmd/Ctrl + Enter。
- 点输入框上方的“模型 · 思考强度 · 权限”可以切换，可以设为以后的默认值。
- 工具步骤默认折叠，点开能看命令、改动和输出。

**同步边界：**

- 桌面原会话使用 Claude Code 的本机 peer inbox，沿用同一个进程和上下文，手机不会再启动另一个 SDK 进程接管它。电脑正在运行时消息以 `next` 优先级排队。
- 电脑会把手机输入显示为会话间消息，可能折叠在工具步骤中；手机显示原文和同一进程的回复。内容依据本机记录更新，并非每个生成中的字符都即时镜像。
- 这不是官方 Remote Control，也不是所有控件均可遥控。电脑原会话的停止、审批、模型和思考强度调整仍需在电脑操作；手机显示最近一轮记录中的实际值。
- 先在电脑 Claude 中打开目标会话。原进程退出、协议不匹配或通道不可用时明确报错，不回退到独立进程。终端会话继续使用原来的空闲接管规则；手机新建会话仍由 SDK 执行。
- 本机通道使用内部协议，已在 Claude Code 2.1.308 上验证消息收发。升级 Claude 后可能需要适配。实现参考 [cc-peer 的协议说明](https://github.com/mikekelly/cc-peer/blob/main/docs/PROTOCOL.md)，并适配本机实际协议；该协议没有官方稳定性承诺。
- 保留原进程的审批机制，不伪装成子进程、不使用子进程令牌、不通过调试器修改应用。读取的 peer token 只在本机发往对应的原进程，不返回给网页、不记录到日志。
- 断线重发按客户端消息 ID 去重，结果保存在本机私有目录，重启服务后仍保留。已排队与已执行是不同状态；投递成功不等于模型已完成。
- 锁屏与睡眠不同：peer 消息走后台进程，不需要点击桌面；Mac 锁屏时，只要未睡眠、网络在线且原 Claude 进程仍运行，通道可以继续投递。这仍不会把消息变成桌面的普通输入，也不会增加模型切换、停止或审批接口。辅助功能控制尚未实现，不能据此承诺原版体验或锁屏控制。

**模型显示：** 输入框上方显示“当前/上一轮实际用的模型和思考强度”（手机引擎在运行时取引擎状态，否则从对话记录读最近一轮），以及“下一轮”从手机发出时会用的设置。手机引擎会话选过的设置会存盘，重启后仍然有效；没选过时沿用记录里实际用的，不会悄悄切到全局默认。

## 常驻占用

- 文件变化通过系统事件监听和 SSE 推给手机；最后一个网页断开后暂停对话轮询和运行进程检查，重新连接时恢复并补齐状态。
- Safari 切到后台时保存草稿并关闭实时连接；回前台、从页面缓存恢复或网络恢复时重新连接、订阅和同步。
- 未变化的对话复用解析结果，避免每次重连都解析全部历史；读取期间追加的记录仍会在下次检查时补齐。
- 图片缓存预算为 48 MB（单张超大图片仍可能超过该预算）；未查看的对话缓存两分钟后回收，另限制空闲缓存数量。缓存预算不等于整个 Node 进程的内存上限。
- 不做屏幕录像或画面传输。模型执行进程、Claude 桌面本体的占用需要单独计算；降低桥接服务占用不会消除模型运行本身的消耗。

## 配置

`config.json`（第一次启动时自动生成）：

| 字段 | 说明 |
| --- | --- |
| `port` | 端口，默认 `3082` |
| `bind_host` | `auto`：自动绑定 Mac 当前的局域网 / Tailscale 地址，地址变化会自动跟随；也可以写固定 IP |
| `trust_loopback` | 本机 `localhost` 访问免配对，默认 `true` |
| `models` | 可选模型列表，格式为 `[{"value":"服务商模型ID","label":"显示名称","efforts":["low","medium","high"]}]`；`efforts` 为该模型可选的思考强度，空数组表示不支持调节。不填时启动时读取本机 Claude Code 的模型目录和档位（不发请求、不产生费用），读不到时用 `opus` / `sonnet` / `haiku` 别名 |
| `defaults` | 新对话默认的模型、思考强度、权限模式、工作目录 |

新安装默认使用 Opus、中等思考强度、每次询问权限。服务商不支持通用别名时，请同时修改 `models` 和 `defaults.model`。Claude Code 的模型目录不代表你的服务商一定支持某个模型或档位；不支持时会在页面显示服务商返回的错误。

改完重启服务：

```bash
launchctl kickstart -k gui/$(id -u)/local.$(id -un).claude-mobile
```

## 安全

- 只监听本机和私有网段地址（192.168.x、10.x、172.16–31.x、Tailscale 100.64/10），从不监听 `0.0.0.0`；不要把端口映射到公网。
- 配对链接等于这台 Mac 的控制权，只发给自己的设备。要作废所有已配对设备：删除 `private/pair.secret` 后重启服务，再重新配对。
- 走的是局域网 http，不是 https；在外面请通过 Tailscale 等加密通道访问。
- 上传的附件保存在 `private/uploads/`（文件权限 600），不会自动删除。

## 卸载

```bash
./uninstall.sh
```

然后删除整个程序目录即可。

## 文件结构

```
server.mjs          服务入口（HTTP、实时推送、配对）
lib/peer.mjs        投递到桌面原进程的本机消息通道
lib/engine.mjs      手机新建会话的执行引擎（Claude Agent SDK）
lib/hub.mjs         对话列表、对话内容、文件变化实时同步
lib/transcript.mjs  把对话记录整理成页面条目
lib/uploads.mjs     附件保存和图片处理
lib/live.mjs        识别电脑上正在运行的 Claude 进程
lib/auth.mjs        配对和登录状态
lib/net.mjs         局域网地址监听
web/                手机页面
install.sh          安装 / 更新
uninstall.sh        卸载
tests/              默认离线测试，不调用模型
tests/manual/       需要主动启用的付费冒烟测试
```

## 日志

`logs/server.log`、`logs/launchd.log`

## 隐私与发布

运行时生成的 `config.json`、`private/`（配对密钥、附件）、日志、对话记录和本机 Node 环境均不属于源代码包，已加入 Git 忽略规则。仓库不包含任何用户的 API 密钥、Claude 登录凭据、会话内容或截图。

本工具在 Mac 本地运行，不内置遥测或项目方服务器。发送的消息、图片和工具读取的内容会交给用户自行配置的模型服务商；这部分仍受服务商条款约束。手机首次配对后可以读取这台 Mac 的本地对话，务必只配对自己的设备。

本机 HTTP 访问使用签名、HttpOnly、SameSite Cookie。局域网传输本身不提供 TLS；外出使用 Tailscale 等加密通道。不要把服务端口映射到公网。已配对的电脑浏览器和手机浏览器同时使用这个网页时，内容通过 SSE 推送同步。继续桌面应用原会话时使用其原进程的本机 inbox，不启动第二个进程写入。

## 更新本机运行版本

在仓库目录运行：

```bash
tools/deploy.sh            # 默认部署到 ~/.local/share/claude-mobile
```

脚本会备份旧代码、同步新代码（保留配置、配对密钥、附件、日志）、写入 `BUILD`（版本号+提交号）并重启服务，最后核对服务报告的运行版本。页面的设置面板和对话列表底部会显示正在运行的版本，例如 `1.2.0+abc1234`。有手机任务正在运行时会拒绝部署。

## 开发与验证

```bash
npm ci
npm test                 # 离线验证配对、防伪、地址限制、附件隔离
node --check server.mjs
```

手动模型测试会产生 API 用量；只有主动设置 `ALLOW_PAID_TESTS=1` 才执行：

```bash
ALLOW_PAID_TESTS=1 npm run test:manual -- opus
# 端到端脚本会向已运行的服务发消息、允许工具并创建测试文件；请使用专门测试环境。
ALLOW_PAID_TESTS=1 npm run test:e2e
```

需要准备依赖但暂时不注册登录服务，可以运行 `INSTALL_NO_START=1 ./install.sh`，然后 `npm start` 手动启动。Shell 会话的环境变量不会自动继承到登录服务；使用自定义凭据时应配置 Claude Code 自身的官方凭据存储或 settings.json。

发布前先暂存明确要发布的源文件，再运行 `npm run check:privacy`。此检查是常见隐私模式的静态检查，不能代替人工确认。发布 ZIP 应从 Git 提交导出，避免把运行目录一起压缩。

## 许可证

本项目代码采用 [MIT](LICENSE)；第三方依赖和可选本机图标见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
