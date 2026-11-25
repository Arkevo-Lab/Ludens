# 设备接入与 Baseware

**Baseware** 是 Ludens 的**跨设备集成层**。它将本机桌面自动化、摄像头与传感器数据流、机器人与嵌入式硬件桥接、仿真器以及远程 MCP 端点封装为统一的控制器契约（`baseware.json`），同时基于单一 `epoch` 控制租约仲裁所有有副作用的输入，确保执行**收回控制权**后外部设备不会继续收到残留动作。

底层协议细节与错误码定义请参见 [Baseware 参考手册](../reference/baseware.md) 与 [Driver Bridge 协议](../reference/driver-bridge-protocol.md)。

## 1. 一等公民内置浏览器（`browser`）与设备视口（Device Viewport）

使用 **Ludens 桌面端（`ludens-app`）** 时，无需配置模拟器、系统辅助功能权限或硬件桥，即可直接打开网页或 Three.js / WebGL 游戏开玩：

- **运行态自动注入**：Ludens 桌面端会在本地启动零 TCP 端口的 Unix Domain Socket `BrowserHost`（`<LUDENS_HOME>/run/browser-host.sock`）。`ludens-server` 在运行期自动探测 `BrowserHost`，动态注入 **`builtin:browser`** 驱动与 **`builtin-browser`** 受控节点。若桌面端未运行，系统不会凭空注入离线节点；已创建的浏览器工作区会清晰展示离线状态，并在桌面端上线后自动恢复。
- **创建浏览器工作区**：
  - **通过控制台**：点击 **新建工作区**，选择一等公民目标 **内置浏览器（Built-in Browser）**，可选填写 **初始 URL**（留空时默认加载零外部依赖的内置 3D WebGL 互动起始页 `ludens-browser://start`）。
  - **通过 CLI**：

```sh
ludens workspace init --name webgl-play --driver browser --url https://example.com/game
cd "$HOME/.ludens/workspaces/webgl-play"
ludens workspace up
```

  `ludens workspace init --driver browser` 会自动生成开箱即用的 30 Hz `screen.capture` `perception.py` 感知模板。
- **每工作区独立隔离空间**：每个浏览器工作区按 `sessionId = workspaceId` 拥有独立的 `WebContentsView` 与持久化存储分区（`persist:ludens-browser-<sessionId>`），开启 `backgroundThrottling: false` 与后台保活——多个浏览器工作区可并发运行互不干扰、切换工作区秒切页面，即使退居后台也能持续保持 30 Hz 画面采集。工作区 Core 启动前即可在 `Manual` 模式下预热浏览页面，启动 Core 后无缝复用同一 `sessionId` 页面状态。
- **`Manual` 人工游玩 vs `Auto` Shiori 接管与「收回控制权」自动抬键保证**：
  - 在 **`Manual`** 模式下，你可以直接操作内嵌浏览器（鼠标、滚轮、键盘、Pointer Lock 3D 视角与地址栏导航）。
  - 在 **`Auto`** 模式下，Baseware 的 `epoch` 控制门禁会屏蔽人工透传输入，由 Shiori 与 `perception.py` 通过 `screen.capture`、`page.*`、`keyboard.*`、`mouse.*`（含 Pointer Lock 相对位移 `mouse.moveRelative`）与 `input.play` 接管操作。
  - 随时点击 **收回控制权（Reclaim Control）**（或执行 `ludens auto off`），Baseware 会立即取消在途 `input.play` 序列并触发 `release(epoch)` → `session.releaseAll`，强制抬起所有按住的键盘按键与鼠标键，确保绝不卡键。
- **统一 `<DeviceViewport />` 与 Web 控制台 `/viewport` 串流**：
  - 在 **Ludens 桌面端（`electron-local`）**，`<DeviceViewport />` 将原生 `WebContentsView` 直接贴合到可拖拽调宽的右侧工作台槽位（0ms WebGL 渲染 + 原生音频），主窗口弹出 Modal 遮挡时自动降级为最新静态帧占位。
  - 在 **Web 控制台、手机端或远端客户端**，`<DeviceViewport />` 连接 `ludens-server` 的 HMAC 鉴权 `/viewport` 二进制 WebSocket 帧流（通过 `createImageBitmap` 渲染并采用单槽丢旧帧背压），并在 `Manual` 模式下将鼠标、滚轮、键盘与 Pointer Lock 输入回传给宿主。
  - **沉浸模式（Immersive Mode）**：在 **运行（Live）** 顶栏或视口右上角点击 **沉浸模式**，可将内置浏览器（以及计算机视口或设备观测舞台）全屏最大化为主工作区、顶部居中展示胶囊地址栏，并将原有的 Shiori 胶囊输入栏（支持一键收起/展开与最新动态预览）置于屏幕最下方；点击 **分栏视图** 即可零中断切回左右分栏，过程中不重建连接、不丢帧、不丢失输入草稿。

## 2. 开箱即用的桌面目标（`cua`）

Ludens 同样内置了基于 `stdio` MCP 传输的 `cua`（`builtin:cua`）桌面自动化驱动，以及默认受控节点 `local-desktop`，无需任何外部驱动包即可启动：

```sh
ludens workspace init --name desktop-monitor --driver cua
cd "$HOME/.ludens/workspaces/desktop-monitor"
ludens workspace up
```

如需指定自定义 CUA 服务启动命令，可在 `ludens workspace init` 时传入 `--cua-command <path>`，或在 `ludens.json` 中配置 `cuaCommand`（直接调试时则传给 `baseware serve --driver cua --cua-command <path>`）。

工作区启动后，可在终端核验控制器列表与参数 Schema：

```sh
ludens-core controller list
ludens-core controller controller/screenshot --help
```

## 3. 五种传输协议与外部驱动包

Baseware 将全局驱动清单（`~/.ludens/drivers.json`）与全局受控节点池（`~/.ludens/machines.json`）解耦管理，原生支持五种传输协议：

| 传输方式 | 典型受控目标 | 关键参数 / CLI 选项 |
| --- | --- | --- |
| `stdio` | 内置 `browser` / `cua` 桌面驱动或本地子进程驱动 | `--driver browser [--initial-url <url>]`、`--driver cua [--cua-command <path>]` 或 `--transport stdio` |
| `bridge` | 本机或局域网 TCP 行协议硬件桥 / 仿真器 | `--transport bridge --host <host> --port <n>` |
| `ssh` | 通过 SSH 标准输入输出隧道托管的远程设备（`ssh -o BatchMode=yes`） | `--transport ssh --ssh-host <host> --ssh-user <user> --ssh-port <n> --ssh-identity <path> --ssh-command <cmd>` |
| `http` | Streamable HTTP MCP 设备或服务端点 | `--transport http --url <url>` |
| `sse` | Server-Sent Events MCP 端点 | `--transport sse --url <url>` |

### 安装与校验外部驱动包

外部驱动通过 `--driver <id> --driver-package <spec>` 加载（或在控制台 **设备** 页面登记到 `~/.ludens/drivers.json`）。`<spec>` 支持三种地址格式：

1. **npm 包**：例如 `@scope/driver-pkg@1.2.0`（由 Bun 缓存在 `~/.local/state/ludens/baseware/drivers/` 或 `$XDG_STATE_HOME/ludens/baseware/drivers/`）
2. **GitHub 仓库**：例如 `github:org/repo#commit-sha`、HTTPS 地址或 `git@github.com:org/repo.git#rev`（生产与评测建议锁定具体 commit SHA）
3. **本地目录或入口文件**：例如 `file:/abs/path/to/driver` 或 `file:./drivers/my-driver`

在正式引入工作区前，可先静态校验驱动包的 `DriverRegistration` 声明是否合规（不会调用连接真机的 `load()`）：

```sh
baseware driver discover --package 'file:/path/to/my-driver'
```

`baseware driver discover` 会安装依赖、加载入口模块并输出 JSON 格式的 `DriverManifest`。需要留意：`discover` 过程中包安装脚本与模块顶层代码仍会在本机执行，请仅加载来自可信来源的驱动包。

## 4. 在控制台（**设备**，`?view=baseware`）管理驱动与节点

打开控制台侧栏的 **设备（Devices）**（`?view=baseware`，页头显示 **设备与节点 · Baseware**），无需手写 JSON 即可可视化管理驱动与受控设备：

- **驱动包（Driver Packages）** 页签：列出全局已安装驱动以及工作区本地引用的 `file:` 驱动源码；点击 **添加驱动包** 可将 npm、GitHub 或本地路径写入 `~/.ludens/drivers.json`。
- **受控设备（Controlled Devices）** 页签：展示 `~/.ludens/machines.json` 中的全部节点及默认合成的 `workspace-default` 端点；点击 **新建受控节点** 可按 `stdio`、`bridge`、`ssh`、`http` 或 `sse` 填写主机、端口、URL 或 SSH 配置。
- **节点检视与控制器（Node & Controllers）** 详情页签：选中任意节点即可测试连通性、将该节点设为当前工作区的主设备或并发挂载多个节点、查看实时暴露的控制器 JSON Schema 并执行测试调用。
- **守护进程与租约（Daemon & Lease）** 详情页签：查看 Baseware 套接字状态、当前 `epoch` 控制租约归属、重连计数，或立即吊销设备控制权。

也可以在工作区的 **配置（Config）**（`?view=perception`）中的 **目标设备（Target Device）** 页签固定或调整当前工作区的默认目标。

## 5. 多节点并发挂载与跨设备路由

单个工作区可以在 `ludens.json` 中声明允许挂载的节点池（`machines.allowed`）与当前主节点（`machines.active`）：

```json
{
  "driver": "cua",
  "machines": {
    "active": "local-desktop",
    "allowed": ["local-desktop", "lab-bench-ssh", "edge-sensor-http"]
  }
}
```

### 运行期热切换与并发挂载（CLI）

无需重启工作区或 Baseware，即可在终端动态挂载多个受控节点并切换主设备：

```sh
ludens-core machine list
ludens-core machine connect local-desktop lab-bench-ssh
ludens-core machine use lab-bench-ssh
ludens-core machine disconnect edge-sensor-http
```

直接操作 Baseware 服务时对应命令为 `baseware machine list`、`baseware machine use <id>`、`baseware machine connect <id> [<id2> ...]` 与 `baseware machine disconnect <id>`。

### 跨节点控制器调用路由

当工作区同时挂载了多个节点时，支持两种路由写法：

- **默认主节点路由（无节点前缀）**：`controller/<tool>` 自动发送给当前活跃的主节点（`active`）。
- **显式指定节点路由（带节点前缀）**：`controller/<machineId>/<tool>` 无论当前主节点是谁，都会精确路由到指定节点。

CLI 示例：

```sh
ludens-core controller controller/screenshot
ludens-core controller controller/lab-bench-ssh/gpio.read --args '{"pin":4}'
ludens-core controller controller/gpio.read --machine lab-bench-ssh --args '{"pin":4}'
```

Python `ludens_tools` 同样提供对应的多节点 API（`machines()`、`use_machine()`、`connect_machines()`、`disconnect_machines()` 以及 `call(..., machine=...)`）：

```python
from ludens_tools import call, connect_machines, machines, use_machine

connect_machines("local-desktop", "lab-bench-ssh")
print(machines())

# 保持 local-desktop 为主设备的同时，定向读取远程节点传感器
telemetry = call("controller/gpio.read", {"pin": 4}, machine="lab-bench-ssh")
use_machine("lab-bench-ssh")
```

## 6. 独立调试 Baseware 与断线恢复

在脱离完整工作区、单独排查某个硬件驱动或通道时，可以在前台直接拉起 Baseware 进程：

```sh
baseware serve --driver cua --machine-id local-desktop --diagnostics full
```

常用维护与恢复命令：

- `baseware status` / `baseware list`：查看当前接入的驱动、在线节点及已导出控制器数量
- `baseware export [--output baseware.json]`：导出实时控制器目录快照
- `baseware reconnect [--machine <id>]`：对断连节点手动触发重连
- `baseware revoke`：立即吊销当前硬件控制租约（触发 `DISOWN` / `release()`）
- `baseware mcp`：将 Baseware 节点池作为标准 MCP `stdio` 服务对外暴露

在**自主运行**期间若主设备意外断开，Baseware 后台同步循环会持续探测恢复并在重连后恢复通知；Ludens 也会先尝试自动重连，若连续重试仍失败则安全暂停并回退到**手动待命**模式。如需结合控制台与日志进一步定位连接异常，请继续阅读 [控制台使用与排障](console-and-debugging.md)。
