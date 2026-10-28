# opencode-genai-obs

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

<a href="README.md">English</a> | <b>简体中文</b>

**面向 OpenCode v2 的审计级 GenAI 可观测插件——标准 OTLP traces 与 metrics，外加全量原始请求落盘。**

`opencode-genai-obs` 挂载于 OpenCode v2 的会话事件流与传输层钩子，通过标准 OTLP/HTTP（protobuf）将 Agent 执行链路实时导出至任意兼容后端（Arize Phoenix、Jaeger、SigNoz、OTel Collector 等），并支持将发往模型侧的原始请求体（wire body）落盘为本地 JSONL。

运营监控类插件回答的是*"今天烧了多少 token"*；本插件回答的是*"线上究竟发出了什么、这一轮为什么花了这些钱"*——磁盘上保留完整请求体，trace/span ID 确定性可复算，会话级审计标注齐全。

## 信号范围

本插件的信号**严格限定在 GenAI 语义约定内**：

- **Traces** —— `gen_ai.*` 属性 + OpenInference 镜像，主信号
- **Metrics** —— `gen_ai.client.token.usage` 与 `gen_ai.client.operation.duration`；不做 infra/运行时指标，也不做应用运营指标（会话计数、commit 计数等——那是运营监控类插件的定位）
- **Events/Logs** —— 可选开启：`gen_ai.*` 消息事件（`system` / `user` / `tool` / `choice`；assistant 消息由 `choice` 覆盖）。内容遵循 contentGates——被门控的事件仍会上报，但仅含元数据

`opencode.*` 自定义 span 属性不受此限——范围约束的是"做哪些信号域"，不是 span 上的自有属性。

## 观测内容

### Traces

每一轮对话（Turn）实时映射为一条结构化 Trace：

```text
<user prompt preview>                                    [AGENT · invoke_agent · 4.2s]
├── chat claude-sonnet-4-5           1,840 → 312 tok · $0.009  [LLM · chat]
├── execute_tool grep                "timeout" in src/         [TOOL · execute_tool · 80ms]
├── execute_tool subagent (explorer)                           [TOOL · execute_tool]
│   └── invoke_agent explorer                                  [AGENT · child session]
│       ├── chat gemini-flash        920 → 180 tok             [LLM · chat]
│       └── execute_tool read        src/auth/client.ts        [TOOL · execute_tool]
└── chat claude-sonnet-4-5           2,310 → 490 tok · $0.014  [LLM · chat]

compaction (auto)                    12,400 → 620 tok · $0.021 [LLM · standalone trace]
```

| Span | `gen_ai.operation.name` | 内容 |
|---|---|---|
| 轮根（用户提问预览） | `invoke_agent` | 用户输入预览、最终回答、会话标题/目录、token 与消息总数、成本 |
| `chat <model>` | `chat` | 厂商/模型、输入/输出/推理/缓存 token、成本、输出消息、wire 帧 `input.value` |
| `execute_tool <name>` | `execute_tool` | 工具名/调用 ID、参数、结果、耗时、子代理挂载 |
| `invoke_agent <agent>` | `invoke_agent` | 子会话容器 span，直接挂在父级工具 span 下 |
| `compaction` | —（独立 trace） | 模型、token、成本、摘要、触发原因 |

发生重试时，随后的 chat span 会打标 `opencode.retry.attempt` / `opencode.retry.error`。

### Metrics

| 指标 | 类型 | 属性 |
|---|---|---|
| `gen_ai.client.token.usage` | Histogram（`{token}`） | `gen_ai.provider.name`、`gen_ai.request.model`、`gen_ai.token.type` = `input` / `output`（input 含可计费缓存读写） |
| `gen_ai.client.operation.duration` | Histogram（`s`） | `gen_ai.operation.name`（`chat` / `execute_tool`）、chat 带厂商与模型、工具带 `gen_ai.tool.name`、失败带 `error.type` |

### 日志事件（可选开启）

| 事件 | 时机 | 内容门 |
|---|---|---|
| `gen_ai.user.message` | 每个 turn 开启 | `userPrompts` |
| `gen_ai.system.message` | chat span 消费到含可解析 system prompt 的 wire 帧（OpenAI `messages[0]` 或 Anthropic 顶层 `system`） | `wireBody` |
| `gen_ai.tool.message` | 每次工具调用结束 | `toolContent` |
| `gen_ai.choice` | 每个 LLM 步结束（finish reason + 补全内容） | `assistantResponses` |

`gen_ai.assistant.message` 有意并入 `gen_ai.choice`（步骤文本即补全内容）。每个事件都携带其来源 span 的确定性 trace/span 上下文，后端可将日志与 trace 关联。被门控的事件仍会上报，但仅含元数据。

### Wire 采集（本地磁盘）

| 记录 | 内容 |
|---|---|
| `<sessionID>.jsonl`（权限 `0600`） | 每次外发 LLM 请求一行 JSON：时间戳、序号、钩子（`ws.send` / `http.request`）、会话/代理/模型、请求类别（`primary` / `compaction` / `title` / `generate`）、原始请求帧 |

## 特性一览

- **确定性 Trace / Span ID** —— 由会话、消息与工具调用 ID 经 SHA-256 派生（而非随机 UUID）：多模块实例（realm）间幂等去重。离线补灌链路（崩溃修复、历史回填）为规划中的后续工作，将复用同一套字节一致的 ID——见 [TODO.md](TODO.md)。
- **LLM 原始请求体采集** —— 发往厂商的序列化 JSON（完整 system prompt、消息历史、tools schema、采样参数）落盘为按会话切分的 JSONL，并可按需注入 chat span 的 `input.value`。详见 [Wire 原始请求采集](#wire-原始请求采集)。
- **W3C trace-context 传播** —— 可选地向白名单厂商的请求注入 `traceparent`,OTel 插桩网关（LiteLLM、vLLM 等）可将自身 span 挂到我们的 trace 下：端到端一棵树，而非两条孤链。
- **会话标注** —— 实时向 Phoenix 兼容的 `/v1/session_annotations` REST API 推送项目名/标题（可开关；非 Phoenix 后端关闭即可，无副作用）。
- **OTel GenAI semconv + OpenInference 双语义约定** —— 标准 `gen_ai.*` 属性与 OpenInference 镜像（`openinference.span.kind`、`llm.token_count.*`、`llm.total_cost`、`input.value`、`output.value`）同时写入，零平台绑定。
- **细粒度隐私门控与日志脱敏** —— 对齐 Claude Code `OTEL_LOG_*` 语义的内容开关、字节级三态截断、插件日志自动脱敏凭证。
- **线格式交给官方 OTel SDK** —— OTLP protobuf 编码委托给 `@opentelemetry/exporter-trace-otlp-proto` / `-metrics-`；其上的管线（span 状态机、确定性 ID、重试/排空队列）为自研。

## 快速开始

**1. 编译并注册插件**

```bash
git clone https://github.com/YMoose/opencode-genai-obs.git
cd opencode-genai-obs && npm install && npm run build
```

将仓库绝对路径加入 `~/.config/opencode/opencode.json`：

```json
{
  "plugin": ["/absolute/path/to/opencode-genai-obs"]
}
```

**2. 配置 OTLP 后端地址**（可选——默认发往 `http://localhost:4318`）

若使用本地 [Arize Phoenix](https://github.com/Arize-ai/phoenix)（`docker run -p 6006:6006 arizephoenix/phoenix`），新建 `~/.config/opencode/ocg-obs.json`：

```jsonc
{
  "tracing": {
    "endpoint": "http://localhost:6006"
  }
}
```

**3. 重启 OpenCode。** 模型步与工具执行完毕后，Span 会实时推送至 `/v1/traces`。

## 后端配置示例

**Arize Phoenix**(traces + 会话标注；Phoenix 不收 metrics——关闭或分流）:

```jsonc
{
  "tracing": { "endpoint": "http://localhost:6006", "project": "ocg-obs" },
  "metrics": { "enabled": false }
}
```

**OTel Collector / Jaeger**(4318 即默认值，无需额外配置）:

```jsonc
{
  "tracing": { "endpoint": "http://localhost:4318" }
}
```

**SigNoz Cloud**（单端点 + ingestion key 请求头，含 metrics）:

```jsonc
{
  "tracing": {
    "endpoint": "https://ingest.us.signoz.cloud:443",
    "headers": { "signoz-ingestion-key": "<SIGNOZ_INGESTION_KEY>" }
  }
}
```

**信号分流** —— traces 进 Phoenix,metrics 走指标后端：

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:6006"
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT="http://localhost:4318"
```

## 配置

配置文件查找顺序：`OCG_OBS_CONFIG` > `OPENCODE_CONFIG_DIR/ocg-obs.json` > `$XDG_CONFIG_HOME/opencode/ocg-obs.json` > `~/.config/opencode/ocg-obs.json`（支持 JSONC 注释与尾逗号）。所有字段均可选且经过严格类型校验（类型错误或未知字段会写日志告警并回退至默认值）：

```jsonc
{
  "enabled": true,                        // 总开关（false 时 setup 直接空操作返回）
  "tracing": {
    "enabled": true,                      // false + wire.enabled = wire-only 模式（仅写本地 JSONL，零网络外发）
    "endpoint": "http://localhost:4318",  // OTLP/HTTP 基础地址（4318 = 标准 OTLP；6006 = Phoenix）
    "project": "opencode",                // 写入 openinference.project.name resource 属性
    "headers": {},                        // 附加请求头（/v1/traces 与 /v1/session_annotations 共用）
    "content": true,                      // 粗粒度隐私门：false 时 toolDetails 与 toolContent 默认关闭
    "contentGates": {                     // 细粒度隐私门（均可单独覆盖 content）
      "userPrompts": true,                //   轮根 Span 的 input.value（用户提问）
      "assistantResponses": true,         //   轮根/chat output.value、gen_ai.output.messages、opencode.reasoning、compaction 摘要
      "toolDetails": true,                //   gen_ai.tool.call.arguments 与工具 input.value
      "toolContent": true,                //   gen_ai.tool.call.result 与工具 output.value
      "wireBody": true                    //   将采集到的 wire 帧注入 chat Span input.value（需开启 wire.enabled）
    },
    "contentMaxLength": 61440,            // 内容属性的最大 UTF-8 字节数（默认 60 KB，对齐后端 64 KB 单 attr 上限）：
                                          //   -1 = 不截断，0 = 仅元数据（值省略，保留 *_original_length），
                                          //   N > 0 = 截到 N 字节（字符边界安全）并追加 [TRUNCATED]
    "resourceAttributes": {},             // 并入 OTLP Resource 块（内置键优先，不被覆盖）
    "annotations": { "enabled": true },   // 向 /v1/session_annotations 推送会话项目名与标题（Phoenix REST 扩展；
                                          // 非 Phoenix 后端建议设为 false 以免产生 404 重试）
    "propagation": { "providers": [] }    // 向出站模型请求注入 W3C traceparent：列入 provider ID（或 "*"）后，
                                          // 主循环请求携带当前 chat span 的上下文，OTel 插桩网关（LiteLLM、
                                          // vLLM 等）便可把自身 span 挂到我们的 trace 下；title/compaction/
                                          // generate 请求永不注入
  },
  "metrics": {
    "enabled": true,                      // gen_ai.client.token.usage + gen_ai.client.operation.duration，
                                          // OTLP/HTTP protobuf 导出。Phoenix 不收 metrics——请用
                                          // OTEL_EXPORTER_OTLP_METRICS_ENDPOINT 指向指标后端（或关闭此项）
    "intervalMs": 60_000                  // 导出间隔
  },
  "wire": {
    "enabled": false,                     // 将发往模型侧的原始请求体追加写入本地 JSONL
    "directory": "~/.local/share/opencode/raw-requests",  // 按会话切分的 JSONL 输出目录
    "maxFrameBytes": -1                   // 磁盘单帧字节上限：-1 = 全量，0 = 仅元数据，N > 0 = 前 N 字节
  },
  "logs": {
    "enabled": false,                     // 可选开启：gen_ai.* 消息事件（system/user/tool/choice），OTLP/HTTP protobuf。
                                          // 内容与 span 属性有重叠——后端对日志事件的索引优于 span 时再开启。
                                          // 被门控的内容仍会上报事件，但仅含元数据
    "intervalMs": 2_000                   // 批量导出延迟（BatchLogRecordProcessor scheduledDelayMillis）
  }
}
```

### 信号开关

| 信号 | 关闭方式 |
|---|---|
| 全部 | `"enabled": false`(setup 空操作） |
| 一切网络外发 | `"tracing.enabled": false` + `"wire.enabled": true` → wire-only 模式（仅磁盘 JSONL) |
| 仅 metrics | `"metrics.enabled": false` |
| 仅日志事件 | 默认关闭；`"logs.enabled": true` 开启 |
| 仅会话标注 | `"tracing.annotations.enabled": false` |
| trace-context 传播 | 默认关闭；配置 `tracing.propagation.providers` 启用 |

### 环境变量

标准 OpenTelemetry 环境变量优先于配置文件（**env > 配置文件 > 默认值**），便于团队或组织级统一注入：

| 环境变量 | 映射字段 |
|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`（回退：`OTEL_EXPORTER_OTLP_ENDPOINT`） | `tracing.endpoint`（末尾的 `/v1/traces` 自动剥除） |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`（回退：`OTEL_EXPORTER_OTLP_ENDPOINT`） | `metrics.endpoint`（末尾的 `/v1/metrics` 自动剥除） |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`（回退：`OTEL_EXPORTER_OTLP_ENDPOINT`） | `logs.endpoint`（末尾的 `/v1/logs` 自动剥除） |
| `OTEL_EXPORTER_OTLP_HEADERS` + 各信号 `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_HEADERS` | 各信号独立 headers（`k1=v1,k2=v2`，支持 percent-decode；每信号按 通用 < 信号专用 合并，无跨信号串扰） |
| `OTEL_RESOURCE_ATTRIBUTES` | `tracing.resourceAttributes`（`k1=v1,k2=v2`，支持 percent-decode） |
| `OTEL_SERVICE_NAME` | 全部信号的 resource `service.name`（优先于 `OTEL_RESOURCE_ATTRIBUTES`；默认 `opencode-genai-obs`） |
| `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`、`OTEL_EXPORTER_OTLP_COMPRESSION`、`OTEL_EXPORTER_OTLP_TIMEOUT` | 由我们委托的官方 OTel SDK exporter 原生处理 |

## Wire 原始请求采集

开启 `wire.enabled: true` 后，每次外发 LLM 请求体都会追加写入 `~/.local/share/opencode/raw-requests/<sessionID>.jsonl`（文件权限 `0600`）：

```json
{
  "v": 1,
  "ts": "2026-10-27T03:25:06.123Z",
  "seq": 42,
  "hook": "ws.send",
  "sessionID": "ses_example0123456789",
  "agent": "build",
  "model": { "providerID": "example", "id": "example/model-x" },
  "kind": "primary",
  "frame": "{\"model\":\"example/model-x\",\"messages\":[...],\"tools\":[...],\"temperature\":0.6}"
}
```

- `kind`：OpenCode 的请求分类（`primary` | `compaction` | `title` | `generate`）。仅 `primary` 帧会按 FIFO 被消费并注入 `chat` Span 的 `input.value`。
- `wire.maxFrameBytes` 仅限制**磁盘 JSONL** 中的 `frame` 体积（Span 路径始终接收完整帧，由 `contentGates.wireBody` 与 `contentMaxLength` 独立控制）：
  - `-1`（默认）：完整落盘
  - `0`：仅记录元数据（`frame: ""`、`truncated: true`、`frameBytes: <原始字节数>`）
  - `N > 0`：保留前 `N` 字节（按 UTF-8 字符边界安全回退切开，末尾追加 `[TRUNCATED]`，并记录 `truncated: true` 与 `frameBytes`）

## 诊断与开发

- **插件日志**：`~/.local/share/opencode/log/ocg-obs.<timestamp>-<pid>.log`（保留 7 天，敏感凭据自动脱敏）。
- **属性映射**：[docs/semconv-mapping.md](docs/semconv-mapping.md) —— 从 OpenCode 采集到的数据如何一一对应到 GenAI semconv / OpenInference。
- **路线图**：[TODO.md](TODO.md)

```bash
npm run build      # 编译 src/ → dist/
npm run typecheck  # tsc --noEmit
npm test           # 编译并运行 node:test 测试套件
```
