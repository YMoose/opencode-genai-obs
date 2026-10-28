# opencode-genai-obs

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

<a href="README.md">English</a> | <b>简体中文</b>

**面向 OpenCode v2 的 OpenTelemetry GenAI 追踪与 LLM 原始请求采集插件。**

`opencode-genai-obs` 挂载于 OpenCode v2 的会话事件流与传输层钩子，通过标准 OTLP/HTTP（protobuf）将 Agent 执行链路实时导出至任意兼容后端（Arize Phoenix、Jaeger、SigNoz、OTel Collector 等），并支持将发往模型侧的原始请求体（wire body）落盘为本地 JSONL。

## 追踪模型与核心能力

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

- **Turn 级调用链拓扑** — 一轮用户交互对应一条 Trace（`invoke_agent` 轮根 Span → `chat` 模型步 → `execute_tool` 工具调用）。通过 `subagent` / `task` 派生的子会话，其 `invoke_agent` 容器 Span 直接作为子树挂载在触发它的工具 Span 下。
- **OTel GenAI semconv + OpenInference 双语义约定** — 同时写入标准 `gen_ai.*` 属性（`gen_ai.operation.name`、`gen_ai.request.model`、`gen_ai.usage.input_tokens` / `output_tokens` / `cache_read.input_tokens` / `cache_write.input_tokens` / `reasoning.output_tokens`、`gen_ai.tool.call.*`）与 OpenInference 镜像属性（`openinference.span.kind`、`llm.token_count.*`、`llm.total_cost`、`input.value`、`output.value`），不绑定特定平台即可在 Phoenix 与通用 OTel 后端获得完整视图。
- **Compaction 与 Retry 可观测** — 上下文压缩（`session.compaction.*`）独立成条 Trace，携带模型、Token、成本与摘要文本；发生重试的模型步（`session.retry.scheduled`）会在随后重试的 `chat` Span 上打标 `opencode.retry.attempt` 与 `opencode.retry.error`。
- **LLM 原始请求体（Wire Body）采集** — 拦截发往模型厂商的序列化请求 JSON（完整 system prompt、裁剪后消息历史、tools schema、采样参数），落盘为按会话切分的 JSONL，并可按需注入 `chat` Span 的 `input.value`。
- **确定性 Trace / Span ID** — ID 由会话、消息与工具调用 ID 经 SHA-256 派生（而非随机 UUID），保证多模块实例（realm）与离线补灌链路下的幂等去重。
- **细粒度隐私门控与日志脱敏** — 对齐 Claude Code `OTEL_LOG_*` 语义的五路内容开关（`userPrompts`、`assistantResponses`、`toolDetails`、`toolContent`、`wireBody`），支持属性字符数与磁盘字节数截断，插件日志自动脱敏凭证。

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

## 配置

配置文件查找顺序：`OCG_OBS_CONFIG` > `OPENCODE_CONFIG_DIR/ocg-obs.json` > `~/.config/opencode/ocg-obs.json`（支持 JSONC 注释与尾逗号）。所有字段均可选且经过严格类型校验（类型错误或未知字段会写日志告警并回退至默认值）：

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
    "contentMaxLength": 61440,            // 内容属性最大字符数（默认 60 KB，对齐后端 64 KB 单 attr 上限）：
                                          //   -1 = 不截断，0 = 仅元数据（值省略，保留 *_original_length），
                                          //   N > 0 = 截到 N 字符并追加 [TRUNCATED]
    "resourceAttributes": {},             // 并入 OTLP Resource 块（内置键优先，不被覆盖）
    "annotations": { "enabled": true }    // 向 /v1/session_annotations 推送会话项目名与标题（Phoenix REST 扩展；
                                          // 非 Phoenix 后端建议设为 false 以免产生 404 重试）
  },
  "wire": {
    "enabled": false,                     // 将发往模型侧的原始请求体追加写入本地 JSONL
    "maxFrameBytes": -1                   // 磁盘单帧字节上限：-1 = 全量，0 = 仅元数据，N > 0 = 前 N 字节
  }
}
```

### 环境变量

标准 OpenTelemetry 环境变量优先于配置文件（**env > 配置文件 > 默认值**），便于团队或组织级统一注入：

| 环境变量 | 映射字段 |
|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`（回退：`OTEL_EXPORTER_OTLP_ENDPOINT`） | `tracing.endpoint`（末尾的 `/v1/traces` 自动剥除） |
| `OTEL_EXPORTER_OTLP_HEADERS` + `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | `tracing.headers`（`k1=v1,k2=v2`，按 W3C Baggage 规范做 percent-decode；traces 专用优先） |
| `OTEL_RESOURCE_ATTRIBUTES` | `tracing.resourceAttributes`（`k1=v1,k2=v2`，支持 percent-decode） |

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
