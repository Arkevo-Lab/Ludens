# 设备接入与 Baseware

**Baseware** 是 Ludens 的**跨设备集成层**。它将本机桌面自动化、摄像头与传感器数据流、机器人与嵌入式硬件桥接、仿真器以及远程 MCP 端点封装为统一的控制器契约（`baseware.json`），同时基于单一 `epoch` 控制租约仲裁所有有副作用的输入，确保执行**收回控制权**后外部设备不会继续收到残留动作。

底层协议细节与错误码定义请参见 [Baseware 参考手册](../reference/baseware.md) 与 [Driver Bridge 协议](../reference/driver-bridge-protocol.md)。

## 1. 开箱即用的桌面目标（`cua`）

Ludens 内置了基于 `stdio` MCP 传输的 `cua`（`builtin:cua`）桌面自动化驱动，以及默认受控节点 `local-desktop`，无需任何外部驱动包即可启动：

```sh
ludens init --name desktop-monitor --driver cua
cd "$HOME/.ludens/workspaces/desktop-monitor"
ludens up
```

如需指定自定义 CUA 服务启动命令，可在 `ludens init` 时传入 `--cua-command <path>`，或在 `ludens.json` 中配置 `cuaCommand`（直接调试时则传给 `baseware serve --driver cua --cua-command <path>`）。

工作区启动后，可在终端核验控制器列表与参数 Schema：

```sh
ludens controller list
ludens controller controller/screenshot --help
```

## 2. 五种传输协议与外部驱动包

Baseware 将全局驱动清单（`~/.ludens/drivers.json`）与全局受控节点池（`~/.ludens/machines.json`）解耦管理，原生支持五种传输协议：

| 传输方式 | 典型受控目标 | 关键参数 / CLI 选项 |
| --- | --- | --- |
| `stdio` | 本机 MCP 桌面驱动（`cua`）或本地子进程驱动 | `--driver cua [--cua-command <path>]` 或 `--transport stdio` |
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

## 3. 在控制台（**设备**，`?view=baseware`）管理驱动与节点

打开控制台侧栏的 **设备（Devices）**（`?view=baseware`，页头显示 **设备与节点 · Baseware**），无需手写 JSON 即可可视化管理驱动与受控设备：

- **驱动包（Driver Packages）** 页签：列出全局已安装驱动以及工作区本地引用的 `file:` 驱动源码；点击 **添加驱动包** 可将 npm、GitHub 或本地路径写入 `~/.ludens/drivers.json`。
- **受控设备（Controlled Devices）** 页签：展示 `~/.ludens/machines.json` 中的全部节点及默认合成的 `workspace-default` 端点；点击 **新建受控节点** 可按 `stdio`、`bridge`、`ssh`、`http` 或 `sse` 填写主机、端口、URL 或 SSH 配置。
- **节点检视与控制器（Node & Controllers）** 详情页签：选中任意节点即可测试连通性、将该节点设为当前工作区的主设备或并发挂载多个节点、查看实时暴露的控制器 JSON Schema 并执行测试调用。
- **守护进程与租约（Daemon & Lease）** 详情页签：查看 Baseware 套接字状态、当前 `epoch` 控制租约归属、重连计数，或立即吊销设备控制权。

也可以在工作区的 **配置（Config）**（`?view=perception`）中的 **目标设备（Target Device）** 页签固定或调整当前工作区的默认目标。

## 4. 多节点并发挂载与跨设备路由

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
ludens machine list
ludens machine connect local-desktop lab-bench-ssh
ludens machine use lab-bench-ssh
ludens machine disconnect edge-sensor-http
```

直接操作 Baseware 服务时对应命令为 `baseware machine list`、`baseware machine use <id>`、`baseware machine connect <id> [<id2> ...]` 与 `baseware machine disconnect <id>`。

### 跨节点控制器调用路由

当工作区同时挂载了多个节点时，支持两种路由写法：

- **默认主节点路由（无节点前缀）**：`controller/<tool>` 自动发送给当前活跃的主节点（`active`）。
- **显式指定节点路由（带节点前缀）**：`controller/<machineId>/<tool>` 无论当前主节点是谁，都会精确路由到指定节点。

CLI 示例：

```sh
ludens controller controller/screenshot
ludens controller controller/lab-bench-ssh/gpio.read --args '{"pin":4}'
ludens controller controller/gpio.read --machine lab-bench-ssh --args '{"pin":4}'
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

## 5. 独立调试 Baseware 与断线恢复

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
