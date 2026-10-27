# opencode-genai-obs

OpenCode v2 plugin：GenAI-semconv OTLP tracing + LLM wire body 采集，输出到任意 OTLP/HTTP 兼容后端（OTel Collector / Phoenix / SigNoz / Jaeger …）。只对齐语义约定（OTel GenAI semconv + OpenInference），不绑定特定观测平台。

> **当前状态：运行中**。wire body 采集（Phase 1）+ 实时 OTLP tracing（Phase 2）已上线实测。**插件只做实时**；历史/崩溃数据补灌走 `obsystem/otel-span-exportor` 的离线链路（export → adapter → send，与插件幂等 id 一致）。

## 安装

在 `~/.config/opencode/opencode.json` 的 `plugin` 数组里加本仓库的绝对路径：

```json
{
  "plugin": ["/home/cambricon/yzh/ocg-obs"]
}
```

重启 opencode。

## 功能：实时 OTLP tracing（Phase 2）

默认开启：session 事件流 → OTel GenAI semconv span → OTLP/HTTP 后端（protobuf）。一轮对话 = 一条 trace（轮根 span = 用户消息摘要），chat span（LLM 调用，带完整 wire body）/ execute_tool span 秒级实时可见。子 agent 会话整棵挂进调用它的 tool span。

```jsonc
{
  "tracing": {
    "enabled": true,                    // 默认 true
    "endpoint": "http://localhost:4318",// 任意 OTLP/HTTP 后端；4318 = OTLP 标准端口
                                        // （Phoenix 用户配 http://localhost:6006）
    "project": "opencode",              // openinference.project.name resource 属性
    "headers": {},                      // 附加请求头（认证），/v1/traces 与 /v1/session_annotations 共用
    "content": true,                    // 粗开关：false → toolDetails / toolContent 默认关
    "contentGates": {                   // 细粒度门（均可单独覆盖，对齐 Claude Code OTEL_LOG_* 语义）
      "userPrompts": true,              //   轮根 span input.value（用户消息）
      "assistantResponses": true,       //   轮根 output.value、chat output.value、gen_ai.output.messages、reasoning
      "toolDetails": true,              //   tool call arguments（默认跟随 content）
      "toolContent": true,              //   tool call result（默认跟随 content）
      "wireBody": true                  //   wire body 进 chat span input.value（false = 只落盘 JSONL）
    },
    "contentMaxLength": 0,              // 内容类属性最大字符数，0 = 不截断；
                                        // 截断追加 [TRUNCATED] 标记并补 *_original_length 属性
    "resourceAttributes": {},           // 并入 OTLP resource 块（host.name / team.* 等；内置键不覆盖）
    "annotations": { "enabled": true }  // session project/title 实时列（走 Phoenix 兼容后端的
                                        // /v1/session_annotations，非 OTLP 标准；其他后端建议关闭）
  },
  "wire": { "enabled": true }           // wire body 落盘 + 喂进 chat span input.value
}
```

### 环境变量（覆盖配置文件，对齐标准 OTEL 惯例）

组织级统一部署可以不改每人配置，直接 shell env 驱动：

| 环境变量 | 作用 |
|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`（回落 `OTEL_EXPORTER_OTLP_ENDPOINT`） | `tracing.endpoint`；`/v1/traces` 尾路径自动剥掉 |
| `OTEL_EXPORTER_OTLP_HEADERS` + `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | `tracing.headers`（`k1=v1,k2=v2`；traces 专用优先） |
| `OTEL_RESOURCE_ATTRIBUTES` | `tracing.resourceAttributes`（同格式） |

优先级：**env > 配置文件 > 默认**（同 Claude Code monitoring-usage 文档惯例）。
配置文件查找：`OCG_OBS_CONFIG` > `OPENCODE_CONFIG_DIR/ocg-obs.json` > `~/.config/opencode/ocg-obs.json`。

配置校验：所有字段做类型检查，类型不匹配（如 `"false"` 字符串）**告警并回落默认值**，不按 JS 真值性静默生效；根级与 `wire` / `tracing` / `contentGates` 层的未知 key（拼写错误）同样告警。告警见日志。

行为要点：

- `tracing.enabled: false` + `wire.enabled: true` = **wire-only 模式**：只落 JSONL，不订阅事件流，任何数据不离开本进程
- 默认 endpoint 为 OTLP 标准端口 `http://localhost:4318`；此前默认 Phoenix 端口 `6006`，依赖默认值的 Phoenix 部署需显式配置 endpoint（**迁移提示**）
- 不发送任何后端专属请求头；project 语义统一走 `openinference.project.name` resource 属性
- `tracing.annotations.enabled: false` 可关闭 Phoenix 兼容后端专属的 session annotation（非 Phoenix 后端建议关闭，避免 404 重试噪音）
- OTLP POST 与 session annotation 请求带 30s 超时，对端挂死不会卡住发送队列/插件卸载
- `session.deleted` 事件触发该会话全部内存状态清理（长驻进程防泄漏）
- 插件热重载若先卸旧 owner，存活实例的 hook 回调会自动触发 pipeline 补选，采集不中断

## 功能：wire body 采集

每次发往 LLM 的原始请求体（完整 system prompt + 裁剪后 messages + tools schema + 采样参数 + provider 专属 options）落盘成 JSONL。

**默认关闭**。开启：创建 `~/.config/opencode/ocg-obs.json`：

```json
{
  "wire": {
    "enabled": true
  }
}
```

落盘位置：`~/.local/share/opencode/raw-requests/<sessionID>.jsonl`，每行一条记录：

```json
{
  "v": 1,
  "ts": "2026-10-27T03:25:06.123Z",
  "seq": 42,
  "hook": "ws.send",
  "sessionID": "ses_e84ae6de0ffeS1LUNCUejdumYi",
  "agent": "sisyphus",
  "model": { "providerID": "volces", "id": "volces/kimi-k3" },
  "kind": "primary",
  "frame": "{\"model\":\"volces/kimi-k3\",\"messages\":[...],\"tools\":[...],\"temperature\":0.6,...}"
}
```

- `hook`：从哪个 hook 拿到的（`ws.send` 是主路径，`http.request` 是兜底）
- `kind`：`primary` | `compaction` | `title` | `generate`（opencode 自带的请求分类）
- `frame`：完整 wire body（ws 是 frame 字符串，http 是 request body 文本）
- `seq`：进程级单调递增序号

**隐私**：body 里有完整 system prompt + 历史 + tools。文件权限 0600，不入 git，不外传。不用了删文件即可。

## 路线图

- [x] **Phase 1**：wire body 采集（v2 `experimental.ws.send` + `http.request` hook → JSONL）
      ✅ 2026-10-27 实测通过：frame 为 provider 原生 JSON（system/messages/tools/max_tokens/thinking），
      volces/kimi-k3 走 `http.request` 路径（dúan hook 双挂是必要的），
      compaction 请求同样被捕获，多实例加载未见重复写入。
      注意体积：单条 primary frame 约 1.4MB（336 messages + 21 tools），磁盘增长快。
- [x] **Phase 2**：事件驱动 span builder（`session.step.*` / `session.tool.*` 事件 → OTel GenAI span，实时发 Phoenix）
      ✅ 2026-10-27 实测通过：chat/tool span 秒级入 Phoenix；wire 帧精确进 `input.value`（OpenInference）；
      轮根 span 押后至 execution 结束；subagent 挂接点按 metadata.sessionID 注册。
      关键障碍记备：opencode 为每 location 加载独立 module realm（实测 3/进程），
      hook 按 location 派发、事件订阅每实例一条 → 用 globalThis pipeline 单例化解。
- [ ] ~~**Phase 3**：启动重放（从 storage 全量投影，崩溃/漏事件兜底）~~ **砍掉**（2026-10-27 拍板）：
      插件只做实时。崩溃补根/历史补灌/重灌由 `obsystem/otel-span-exportor` 官方离线链路承接
      （id 算法与 `src/spans.ts` 逐字节一致 → Phoenix `DO_NOTHING` 幂等去重）。
      理由：四场景都不是实时需求，且自动重放是危险的默认副作用。详见设计文档 §3。
- [x] **Phase 2.5**：实时 session annotation（`session.created`/`session.renamed` →
      POST `/v1/session_annotations`，Phoenix 兼容后端 Sessions 页 project/title 列秒级更新；
      subagent 会话跳过，3 次重试 + 离线 sync.py 兜底；现由 `tracing.annotations.enabled`
      控制，非 Phoenix 后端可关）✅ 2026-10-27 实测通过
- [ ] ~~**Phase 5**：替代 `obsystem/otel-span-exportor` 全套脚本链路~~ **砍掉**：
      该链路升级为官方离线 repair/backfill 通道，与插件并存（见 Phase 3 说明）
- [ ] **TODO（未来方向，非承诺）**：OTLP **metrics + logs/events**（参照 Claude Code
      monitoring-usage 同文档的 metrics/logs 节；**当前重心仍是 traces，此项不影响 tracing 路径**）
      - metrics 候选（数据源 = 现有 session 事件流，零新增采集）：
        `opencode.session.count`（created）、`opencode.llm.tokens{model,direction}`（step.ended）、
        `opencode.cost.usd`（step.ended cost）、`opencode.tool.calls{tool,status}`（tool.success/failed）、
        turn/tool duration histogram；发送走 OTLP/HTTP JSON（Phoenix 不收 metrics，
        目标后端 SigNoz / OTLP collector → Prometheus）
      - logs/events 候选：`user_prompt` / `tool_result` / `step_failed` 事件，
        复用 contentGates 做内容门；走 OTLP logs 协议
      - 配置沿用现有 OTEL env 惯例（`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` /
        `_LOGS_ENDPOINT` 分路），tracing 不升级 gRPC
- [ ] **TODO（未来方向，非承诺）**：**后端专属能力扩展点（注册/回调机制）** —— 把
      Phoenix 类后端独有字段的获取与写入（现 `annotations.ts` 的 session
      project/title）从核心链路抽象成可注册的扩展点，核心只实现语义（OTel
      GenAI semconv + OpenInference），平台专属行为全部走扩展：
      - 回调注册 API：如 `onSessionCreated` / `onTurnEnded` / `onSpanEmitted`，
        现有 Phoenix annotation 降级为第一个内置扩展（`tracing.annotations.*`
        配置保持兼容），第三方可注册自己的后端适配器
      - 用户自定义入口：配置文件声明扩展模块路径（对齐 opencode 插件目录加载
        惯例）或编程式注册；扩展内可拿到 endpoint/headers/project 配置与
        contentGates 内容门
      - 约束：扩展回调一律 fire-and-forget + 超时保护（同 annotation 现状），
        不得阻塞 span 主路径；扩展故障只告警不影响 tracing

设计文档：`../obsystem/otel-span-exportor/MERGED-PLUGIN.md`  
调研：`../obsystem/otel-span-exportor/RESEARCH.md`

## 开发

```bash
npm run build      # 编译 src/ → dist/
npm run typecheck  # 类型检查
npm test           # 编译并跑 node:test 测试套件（tests/ → dist-test/）
```

测试覆盖：span 状态机（确定性 id、内容门、malformed 事件守卫、session 清理）、
OTLP 编码/POST（超时、非 200）、发送队列（重试、丢弃）、annotation 重试、
wire 落盘/刷盘、配置校验、脱敏与日志（参考 oh-my-opencode-slim 的测试模式），
插件公共合同（禁用不触 ctx、幂等 unload、reload 重建、hook 注销对称），
以及依赖契约（运行时依赖闭包最小化 + src import 图不越界）。
