# pi-qq-chat

让 [Pi](https://pi.dev) 变成 QQ 聊天机器人。通过 OneBot v11（NapCat / LLOneBot）收发消息，可在 headless 服务器上常驻运行。

- 私聊 + 白名单群的**所有消息**都会交给 Pi；连发的几条会合并后统一回复
- 每次只处理一个聊天，回复不会发错群
- **纯聊天**：Pi 的所有工具（bash、读写文件等）都被禁用，QQ 用户无法操作服务器
- 模型觉得不需要接话时输出 `<NO_REPLY>`，机器人就保持沉默
- 会话持久化，重启后接着聊；上下文过长时由 Pi 自动压缩
- 管理员指令：`/status`（模型、上下文用量、队列）、`/reset`（清空记忆，开新会话）、`/help`；其他 Pi 扩展注册的指令（如 `/persona`）也能直接在 QQ 里用
- 人格交给独立扩展 [pi-persona](https://github.com/keqiant/pi-persona)，本插件只负责 QQ 平台规则

## 两种运行方式

这是一个 Pi 插件，**默认不生效**：装进你平时用的 Pi 也不会有任何变化。只有加了 `--qq` 开关时，它才会连接 QQ、关闭所有工具、接管会话。

| 方式 | 命令 | 适合 |
|---|---|---|
| headless 启动器 | `npm start`（`src/daemon.ts`，自动打开开关） | 服务器常驻，配合 systemd |
| Pi TUI | `pi --qq` | 在终端里实时看群消息和回复，也能手动插话 |

TUI 方式需要先安装插件：`pi install git:github.com/keqiant/pi-qq-chat`。

## 架构

```
QQ ⇄ NapCat (OneBot v11, 正向 WebSocket) ⇄ src/extension.ts ⇄ Pi 会话
                                              ↑ 由 src/daemon.ts（Pi SDK）常驻加载
                                                + config.extensions 里的扩展（如 pi-persona）
```

系统提示结构：

```
preamble   ← 人格扩展写入；没装人格扩展时，本插件填默认开头“你是「botName」…”
<cwd>      ← Pi 自动添加
<qq_chat>  ← 本插件：只能聊天、消息格式、纯文本、<NO_REPLY>……与人格冲突时以此为准
```

| 文件 | 作用 |
|---|---|
| `src/extension.ts` | Pi 扩展（`--qq` 时生效）：入站排队、系统提示、禁用工具、回复出站 |
| `src/daemon.ts` | headless 启动器：打开 `--qq`、只加载本扩展和 `extensions` 里列出的扩展、无工具、持久会话 |
| `src/onebot.ts` | OneBot v11 WebSocket 客户端（自动重连） |
| `src/message.ts` | 消息段 ⇄ 文本、去 Markdown、长消息切分 |
| `src/queue.ts` | 按聊天合并消息（debounce）与调度 |

## 部署

### 1. Pi 与模型凭据

服务器上安装 Pi 并登录（或设置 `ANTHROPIC_API_KEY` 等环境变量）：

```bash
pi auth login --provider anthropic
```

### 2. NapCat

按 [NapCat 文档](https://napneko.github.io/) 安装并登录机器人的 QQ 小号，在 WebUI 的“网络配置”中新建 **WebSocket 服务器**（即正向 WS）：

- Host `127.0.0.1`，端口 `3001`
- 消息格式 `array`
- 设置一个 Token

### 3. 本项目

```bash
git clone <this repo> ~/pi-qq-chat && cd ~/pi-qq-chat
npm install
mkdir -p ~/.config/pi-qq && cp config.example.json ~/.config/pi-qq/config.json
$EDITOR ~/.config/pi-qq/config.json   # 填 token、群号、管理员 QQ
npm start                             # 前台试跑
```

常驻运行见 `deploy/pi-qq.service`（systemd user unit）。

### 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `onebot.url` / `onebot.accessToken` | `ws://127.0.0.1:3001` | NapCat 正向 WS 地址与 token |
| `allowedGroups` | `[]` | 响应的群号 |
| `allowPrivate` / `privateWhitelist` | `true` / `[]` | 是否响应私聊；白名单为空表示所有人 |
| `admins` | `[]` | 可用 `/status`、`/reset` 的 QQ 号 |
| `botName` | `Pi` | 没有人格扩展时默认开头里的名字；也用来去掉回复开头的“名字：”，建议与人格里的名字一致 |
| `extensions` | `[]` | 额外加载的 Pi 扩展：`git:…`、`npm:…` 或本地路径（相对配置文件所在目录） |
| `debounceMs` | `1500` | 最后一条消息后静默多久再回复 |
| `maxReplyChars` | `1500` | 超出则拆成多条发送 |
| `quoteReply` | `false` | 群聊回复时引用原消息 |
| `images` | `true` | 把图片转给模型（需要支持图像的模型） |
| `model` / `thinkingLevel` | Pi 默认 | 例如 `anthropic/claude-opus-5-5` / `low` |
| `sessionDir` / `workspaceDir` | `~/.local/share/pi-qq/…` | 会话文件与空工作目录 |

环境变量覆盖：`PI_QQ_CONFIG`、`PI_QQ_WS_URL`、`PI_QQ_ACCESS_TOKEN`、`PI_QQ_GROUPS`、`PI_QQ_ADMINS`、`PI_QQ_EXTENSIONS`（逗号分隔）。

### 人格

安装 [pi-persona](https://github.com/keqiant/pi-persona)：在 `extensions` 里加上 `"git:github.com/keqiant/pi-persona"`，把人格文件放进 `~/.config/pi-persona/personas/`，然后管理员在 QQ 里发 `/persona <名字>` 切换。人格文件的写法见 pi-persona 的 README。

人格文件和你平时用的 Pi 共用，但机器人的“当前人格”单独记录在 `~/.local/share/pi-qq/persona-active`（即 `sessionDir` 的上一级目录），所以在 QQ 里切换人格不会影响你平时的 Pi，反过来也一样。想共用就自己设置 `PI_PERSONA_STATE`。

### 管理员指令

| 指令 | 作用 |
|---|---|
| `/status` | 模型、上下文用量、排队消息 |
| `/reset` | 清空记忆，开新会话 |
| `/help` | 列出所有可用指令 |
| `/<其他>` | 其他扩展注册的 Pi 指令，会转发给 Pi 执行，结果发回当前聊天 |

不是已注册指令的 `/xxx`（比如 `/捂脸`）会当作普通消息处理。

> 群里每条消息都会触发一次模型调用（连发的会合并），活跃群里费用不低。
> 想省钱可以用更便宜的模型、把 `thinkingLevel` 设为 `off`/`low`，或调大 `debounceMs`。

## 开发与测试

```bash
npm run typecheck
npm test                                   # 单元测试
npm run mock -- --scenario & \
  PI_QQ_WS_URL=ws://127.0.0.1:3001 PI_QQ_GROUPS=123456 PI_QQ_ADMINS=10000 npm start
                                           # 用模拟 OneBot 跑端到端场景（会真实调用模型）
npm run mock -- --persona-scenario         # 人格场景：需要在 extensions 中加载 pi-persona 及其示例人格
npm run mock                               # 交互式模拟：g/@/o/p/a <文字>
pi -e ./src/extension.ts --qq              # 在 Pi TUI 里调试，能看到注入的消息
```
