# 室内概念效果图平台：后端架构与 API 契约

## 产品边界

本阶段交付四条可区分的概念工作流：

- `concept`：现场照片快速生成室内概念效果图。
- `advanced`：在概念生成基础上使用深度图、法线图、参考图或局部蒙版。
- `floorplan`：把已有平面图转换为彩色概念平面表现。
- `self-service`：把零至多张有序参考图和用户自由提示词发送到受控文生图/图生图流程，不套用官方风格预设。

平面图结果只用于沟通风格、色彩和空间表达，不承诺识别真实尺寸，也不是施工图、测绘成果、报建文件或 BIM。全景拼接、真实 3D 漫游与支付不在本阶段；积分账本和服务端报价只完成本地切片。

## 组件职责

```text
浏览器工作台
  -> 浏览器草稿（IndexedDB 图片 + 当前标签页 sessionStorage 参数）
  -> 点击生成后才调用资产 API（上传、私有读取、当前用户列表）
  -> 视觉预处理 API（外部服务生成 depth / normal）
  -> 任务 API（创建、按工作台列表、查询、下载结果）
       -> 版本化提示词编译器
       -> 国产图片模型适配层（Seedream / Qwen / Hunyuan / Kling）
       -> 旧 OpenAI / Google / 显式 Mock 适配器（仅供内部演示兼容，不对新任务开放）

D1：资产元数据、任务参数、状态、输出关系
R2：原图、参考图、蒙版、控制图、平面图和生成结果
```

腾讯 CVM 私有测试部署使用相同的数据库/对象存储合同，但运行时替换为单进程 SQLite 与本机文件对象存储。SQLite 启用外键、WAL、`BEGIN IMMEDIATE` 批处理和迁移摘要校验；图片对象使用受根目录约束的原子文件写入。该组合只用于单机私测，不承诺多 Web 副本、高可用或大规模图库。正式公网前应迁至托管 PostgreSQL 与私有腾讯 COS，并重新验证队列领取、并发闸门和 fenced 输出语义。

- 浏览器不接触模型密钥，也不根据动画计时伪造任务进度。
- `generateVision` 是用户主动点击的同步视觉预处理例外：只有所选 source 上传使用幂等键；Depth/Normal 派生请求目前不持久、不计费，也不保证请求幂等，重复点击可能产生重复临时资产。它不是持久生成队列，暂不承诺断点恢复。Cookie 为同源共享，因此同一浏览器不支持 A/B 账号会话并存；owner scope 变化按既有合同全局清理本地草稿并让其他标签页 reload。
- 未提交图片不离开浏览器；刷新复用当前标签页 session ID，关闭标签页后旧草稿不再可寻址，24 小时过期清理，退出或 owner scope 变化通过 BroadcastChannel 跨标签页清除。浏览器只接受 JPEG/PNG/WebP，并在选择时校验单张 20MB、8192px 最长边和 4000 万像素；不限制长宽比。
- 点击生成后按所选模型计算所有输入图总数并上传：Seedream 5.0 Pro/Lite/4.5 分别最多 10/14/14 张，Qwen 三型号最多 3 张。总数包含 source、reference、additional references、启用的 depth/normal；切换模型不会删草稿，只阻止超限提交。上传按本地文件和完整模型变体使用稳定幂等键，防止跨模型复用不兼容 MIME/尺寸；任务 ACK 不确定时保留已解析 payload 并复用同一任务键，只有明确拒绝才清理本次新资产。
- 后端负责 owner 隔离、资产类型校验、任务幂等、持久化和安全错误。
- AI 层负责编译确定性提示词、固定控制图顺序、供应商参数映射和错误归一化。
- 所有局部修改都生成以所选结果为 `parentAssetId` 的新资产，不覆盖旧版本。
- D1/R2 缺失时仅在非生产环境使用带警告头的 `memory-demo`；生产环境绝不静默回退。

## API 契约

### 资产

`POST /api/assets` 使用 `multipart/form-data`：

- `file`：真实内容须为 JPEG、PNG 或 WebP，不能只相信文件扩展名或声明 MIME。
- `kind`：`source | reference | mask | depth | normal | floorplan`。`output` 只由生成任务创建，不能由客户端伪装上传。

`GET /api/assets?scope=today|all&kind=<kind>&limit=50`：

- 查询只返回当前 owner 的 `READY` 资产，默认 `scope=today`、`limit=50`，最大 100。
- `today` 按中国大陆产品时区 UTC+8 的自然日计算。
- 结果按 `createdAt` 新到旧排序，包含私有读取 `url`、`parentAssetId`、`createdAt`，不返回 `ownerId`、`storageKey` 或摘要值。
- 图片内容继续通过 `/api/assets/:id?content=1` 的 owner 校验读取；下载使用同一路由的 `download=1`，仍先做 owner 校验且不暴露存储键。

### 当前用户

`GET /api/me` 返回：

```json
{
  "user": {
    "authenticated": false,
    "displayName": "访客"
  },
  "stats": {
    "total": 0,
    "today": 0,
    "byKind": {
      "source": 0,
      "reference": 0,
      "mask": 0,
      "output": 0,
      "depth": 0,
      "normal": 0,
      "floorplan": 0
    }
  },
  "persistence": "cloudflare-d1-r2"
}
```

平台用户只返回清洗后的显示名称和可选邮箱。匿名访问不会回显任何鉴权请求头或平台内部用户 ID。

### 视觉预处理

`POST /api/vision`：

```json
{
  "sourceAssetId": "asset_source_or_output",
  "artifactTypes": ["depth", "normal"]
}
```

- `sourceAssetId` 必须属于当前 owner，且类型为 `source` 或 `output`。
- `artifactTypes` 是规范字段，兼容旧别名 `artifacts`；内部固定按 `depth`、`normal` 排序。
- 结果持久化为以输入图为父版本的真实资产，响应为 `artifacts:[{artifactType,asset,model,confidence}]`。
- 未配置 `VISION_PIPELINE_URL` 时返回 `503 / NOT_CONFIGURED`，绝不用滤镜或占位图冒充深度、法线推理。

### 风格目录

`GET /api/styles` 返回至少 12 个稳定可提交的风格 ID、名称、说明和封面。浏览器永远拿不到内部 `promptDirective`。

### 创建生成任务

`POST /api/jobs`：

```json
{
  "sourceAssetId": "asset_id",
  "referenceAssetId": null,
  "maskAssetId": null,
  "depthAssetId": "asset_depth",
  "normalAssetId": "asset_normal",
  "stylePresetId": "modern-minimalist",
  "lightingPreset": "noon",
  "preservationMode": "structure",
  "providerPreference": "doubao-seedream-5-0-pro-260628",
  "workflowType": "advanced",
  "resolution": "2K",
  "aspectRatio": "16:9",
  "quality": "standard",
  "lampState": "mixed",
  "colorTemperatureKelvin": 4000,
  "editInstruction": null,
  "outputCount": 4,
  "advancedSettings": {
    "version": 1,
    "geometryFidelity": "balanced",
    "cameraPolicy": "locked",
    "furnishingDensity": "balanced",
    "materialExpression": "natural",
    "lightingContrast": "balanced"
  },
  "idempotencyKey": "client_generated_key"
}
```

冻结枚举与范围：

- `workflowType`：`concept | advanced | floorplan | self-service`
- `resolution`：`1K | 2K | 4K`
- `aspectRatio`：`1:1 | 4:3 | 3:2 | 16:9 | 9:16`
- `quality`：`draft | standard | high`
- `lampState`：`on | off | mixed`
- `colorTemperatureKelvin`：2700 至 6500 的整数
- `lightingPreset`：`morning | noon | sunset | night`
- `preservationMode`：`structure | furniture | clear`
- `providerPreference`：三个固定 Seedream model ID 与三个 Qwen 模型名称：`doubao-seedream-5-0-pro-260628 | doubao-seedream-5-0-260128 | doubao-seedream-4-5-251128 | qwen-image-3.0-pro | qwen-image-3.0 | qwen-image-2.0-pro`。四个工作台默认 Pro；新任务不得提交旧 provider family。后端只使用固定官方端点，配置缺失或无效时在持久化前失败。

本轮不部署。发布前应排空或终态化旧任务；新版本写入六个 model ID 后，旧版本不能安全处理这些值。若需回滚，只回滚 UI/路由并保留六 ID 的读取兼容与旧值拒绝策略。
- `advancedSettings` 缺失时使用规范默认值；存在时严格校验 `version:1` 及五项枚举。规范 JSON 写入 `generation_jobs.advanced_settings_json`，并参与 `requestHash`。GET serializer 全量回读；英文设计指令仅在服务端提示词编译器中生成，绝不返回客户端。

深度图、法线图必须属于当前 owner 并分别为正确 kind。它们只是结构参考图，不宣称真实 ControlNet 或硬约束；AI 输入固定为主图、风格或既有概念参考图、depth、normal；局部蒙版使用供应商专用 mask 位置。`advanced` 可把当前 owner 的 `source` 或既有 `output` 作为主图，并允许 `referenceAssetId` 使用 `reference | output`，以便从今日图片和方案库继续深化；`concept` 与 `floorplan` 的参考图仍只能是 `reference`。普通 `concept` 重生成要求 `source`，但保留旧版局部编辑对 `output + mask` 的兼容。`floorplan` 的输入必须为 `floorplan`，且拒绝 mask/depth/normal；提示词要求保持轮廓、墙体、门窗、房间邻接和可读尺寸，不自行补全歧义。

`self-service` 必须提交非空的 `customPrompt`（去除首尾空白后 1—2000 字），并可提交零至多张 owner 所有的有序参考图。参考图通过 `additionalReferences` 的通用 `reference` 槽位按顺序发送；它不等同于 concept/advanced 的结构化角色，也不接受风格槽位、mask、depth、normal 或局部编辑说明。自助提示词按规范化后的中文原文作为冻结任务参数参与幂等哈希，但不会由任务列表响应回显。`POST /api/prompts/optimize` 使用固定北京 `qwen3.8-flash` 与既有 DashScope 密钥读取器，先本地 quote 再显式确认。输入 token 成本 0.8 元/百万 ×3，100积分/元，向上取整至少1积分；系统输入包含在 UTF-8 字节加 framing 的费用上限估算中，该估算不是实际 token 计数。仅成功时按供应商 `usage.prompt_tokens` 结算，输出费用由网站承担。0033 新增 owner 请求与 ledger `optimization_id` 分支，保留原图像 guard；原子预留、单次派发、结果保存/实际结算/余款释放，失败、未知或超时释放全部，同 quote 不重发。账户余额读取会恢复过期请求。旧免费请求缺报价拒绝；返回结果前再次检查会话和同意。浏览器仅保存当前 owner 草稿范围的 quote 句柄、上下文和输入指纹，刷新后查询同一结果，不另存原文。

新 `local-edit:v2` 的五种快捷方式会在哈希、审核和持久化前忽略 `customPrompt`；第六种 `prompt` 方式必填文字。已接受 v1 队列/历史保持旧覆盖语义，新 v1 写入拒绝。未来发布必须 consumer 兼容版本先行、再 Web；回退保留0033活库，旧 Web 回退必须关闭旧 `ARK_PROMPT_MODEL` 免费入口，不能恢复旧数据库。

### 查询任务

`GET /api/jobs?workflowType=<type>&limit=20&cursor=<opaque>` 只返回当前 owner、指定工作台的任务，采用 `(createdAt,id)` 键集分页，并批量回读 READY 输出，避免逐任务查询。任务列表可以持久化显示并轮询状态，但它不把 `waitUntil` 升级为可靠生产队列。

`GET /api/jobs/:id` 返回所有冻结参数，并额外返回按 `depth`、`normal` 排序的 `controlAssetIds` 与生成结果：

```text
QUEUED -> PREPROCESSING -> GENERATING -> VALIDATING
  -> SUCCEEDED | PARTIAL_SUCCEEDED | FAILED | CANCELED
```

## 持久生成队列（Phase 4A 内核）

`generation_jobs` 继续是用户可见任务与冻结参数记录；新增的 `generation_job_items` 把 `outputCount` 拆为逐张执行项，每个 `(job_id, ordinal)` 唯一，对应一次潜在计费操作。`generation_attempts` 保存每次领取的安全审计状态，但不保存密钥、图片、Base64 或完整提示词。

Phase 4A 已实现以下 D1 内核：

- 任务项状态：`QUEUED | LEASED | PREPROCESSING | SUBMITTING | PERSISTING | RETRY_WAIT | SUCCEEDED | FAILED | RECONCILIATION_REQUIRED | CANCELED`。
- 单条条件 `UPDATE ... RETURNING` 原子领取；领取时同时检查到期时间、重试预算、每用户并发和每供应商并发。供应商并发使用持久化的规范键 `seedream | qwen`，而不是模型 ID，因此同一供应商的不同模型不能绕过上限。
- `lease_token + lease_generation` 构成 fencing token。心跳、阶段转换、重试和终态写入都必须匹配当前 fence；旧 Worker 不能覆盖新 Worker。
- 租约在调用供应商之前过期时，可以在剩余预算内使用 15/60/300 秒上限的 full-jitter 退避；预算耗尽则失败。
- 一旦进入 `SUBMITTING`，通用状态机不再允许转为普通 `FAILED` 或取消；`SUBMITTING` / `PERSISTING` 阶段的中断只能进入 `RECONCILIATION_REQUIRED`，禁止自动再次调用供应商。
- 任何含 `RECONCILIATION_REQUIRED` 的任务对既有公开 JobStatus 聚合为 `VALIDATING`，不能被上层当成普通失败重提、退款或结算；后续由对账流程明确收口。
- 多个 item 状态可聚合回既有公开 JobStatus，因此当前工作台任务列表合同不必提前扩张。

Phase 4A **尚未接入生产执行链**：两个公开任务创建路由已在本地改为原子写入 job 与逐张 item，但仍没有 Queue producer、已部署 consumer、DLQ 或定时 sweeper；国产真实生成的 `GENERATION_QUEUE_NOT_READY` 硬门保持不变且位于持久化之前。当前 `.openai/hosting.json` 只声明 D1/R2，Worker 只导出 `fetch`，构建产物的 queues/consumers/triggers/workflows 均为空；当前 Sites 技能文档也没有 Queue/Cron 注册合同，因此不能猜测 Sites 会保留额外 handler 或把 `waitUntil` 当作持久运输。Phase 4B 先在本地实现运输层无关的单 item consumer、心跳、fenced 输出和崩溃恢复；实际启用必须另行配置有明确长期运行保证且能安全访问任务/资产的独立 consumer，例如后续腾讯 CVM，或经官方确认能共享同一 D1/R2 的独立 Worker。

### Phase 4B 内部控制面第一切片

本地代码已经增加 CVM 主动轮询所需的最小内部控制面，但默认完全关闭，也没有接入公开任务创建链：

- `POST /api/internal/generation/claim`：以 `workerId + claimRequestId` 原子领取一条 item；同一 `claimRequestId` 在 ACK 丢失后只会恢复原 fence，不会领取下一条。`executionKind` 只能是 `provider | acceptance`，省略时固定为 `provider`，且重放时必须保持一致；正式 consumer 固定请求 `provider`。租约时长、每用户并发和每供应商并发只从服务端配置读取，客户端不能提高额度。无任务返回 204；响应不包含 owner、提示词、R2 key 或任何密钥。
- `POST /api/internal/generation/heartbeat`：只有精确且未过期的 `itemId + leaseToken + leaseGeneration` 可以续租。
- `POST /api/internal/generation/transition`：正式任务接受 `BEGIN_PREPROCESSING`、`BEGIN_PROVIDER_DISPATCH`、`RECORD_PROVIDER_RESPONSE`、`FAIL_BEFORE_PROVIDER`、`MARK_AMBIGUOUS`；固定验收任务另有 `BEGIN_ACCEPTANCE_EXECUTION`、`RECORD_ACCEPTANCE_RESULT`。专用事件必须与 item 的 `execution_kind` 匹配，不接受任意 `from/to`，也不能通过该接口把任务直接写成 `SUCCEEDED`。正式供应商与模型从 item 的冻结配置在服务端派生，CVM 不能自报或改写。
- `POST /api/internal/generation/sweep`：有界恢复过期租约；供应商调用前可安全重试，`SUBMITTING/PERSISTING` 只能转入人工对账。

内部请求只允许 HTTPS 和无查询参数的固定 POST 路径，正文上限 16 KiB。机器身份使用标准 WebCrypto HMAC-SHA256，签名覆盖版本、固定部署受众、key ID、时间戳、随机 nonce、方法、路径和原始正文 SHA-256；生产、测试等环境使用不同受众与密钥。previous 密钥必须带最长 7 天的显式到期时间。D1 `generation_internal_nonces` 只保存短期 nonce hash，使用唯一主键防跨 isolate 重放，不保存认证秘密。领取请求 ID 持久化在 attempt 中；每次领取、转换、重试或恢复都把 item/attempt 变更与公开 job 聚合放入同一 D1 batch，旧 fence 不能覆盖新尝试。

### Phase 4B 内部字节运输与 fenced 输出切片

本地代码在第一切片之上增加了以下默认关闭能力：

- `POST /api/internal/generation/work` 为有效 `PREPROCESSING` fence 返回单 item 工作说明，强制 `outputCount=1`，并按 source、style/role reference、depth、normal 的顺序签发短时输入票据。
- `POST /api/internal/generation/input` 使用机器 HMAC、短时票据和实时 fence 三重校验逐张读取 R2 输入；每次重新核对 owner、READY、kind、MIME、体积和 SHA-256，不返回 R2 key。
- `POST /api/internal/generation/output-prepare` 只在 `PERSISTING` 阶段登记一次输出；`POST /api/internal/generation/output` 对原始二进制正文做 HMAC、8 MiB 上限、MIME/magic/尺寸/摘要校验。`generation_output_commits` 将 item、attempt、lease generation、不可覆盖的 R2 key 和输出摘要绑定；最终 D1 batch 同时发布 READY asset、output relation、item/attempt success 和公开 job 聚合。
- 输出上传与最终 D1 ACK 丢失可以按同一 upload request/ticket 幂等恢复；R2 已写而 D1 最终 batch 失败时，sweep 会先核验并完成 fenced commit，再执行普通租约恢复。冲突对象或无法确认的供应商后阶段任务进入 `RECONCILIATION_REQUIRED`。
- 可移植 consumer 核心只处理一条 item；供应商 dispatch 后禁止安全重试。租约心跳从预处理开始贯穿逐张输入、供应商执行、输出登记与上传；后续输入会刷新 work ticket，并拒绝除 ticket 外发生变化的冻结工作说明。文件 spool 使用固定 attempt 目录、0700/0600 权限、随机 `wx` 临时文件和原子目录发布；重启时恢复完整 staging、隔离损坏或失效记录，并优先重传已有输出而不再次调用模型。

票据使用只有队列控制面 Web 持有的 `GENERATION_INTERNAL_TICKET_SECRET`，与 consumer 持有的机器 HMAC 密钥严格分开。票据有效期限制为 120–300 秒，不截断到签发瞬间的 lease 截止时间；签发时仍要求 lease 有效，且每次读取输入或提交输出都会再次实时核验 exact item/attempt/generation/lease token 与状态，因此过期或被替换的 fence 不能复用尚未到期的票据。claim 在产生 lease/attempt 前强制检查 R2 与 ticket 配置。队列输出不复用旧 `attachCloudflareOutput`/`reconcilePendingOutputs`；旧恢复路径明确跳过已有 queue item 的 job。

### Phase 4B 国内供应商单任务 executor

本地 consumer 已增加 Seedream/Qwen 的严格 prepare/execute 边界。`/work` 返回值必须通过精确字段、国内模型、模型分辨率、工作流、角色、连续索引、数量和控制图顺序校验；下载后的每张图片还会再次核对角色、索引、MIME、长度与 SHA-256。风格提示词编译、官方固定端点、模型能力、账号槽位和全部输入预检发生在 `BEGIN_PROVIDER_DISPATCH` 之前，因此确定性的本地错误不会形成供应商调用。dispatch 事件只记录服务端派生的 provider/model 和 consumer 选中的非秘密账号槽位 ID，不记录密钥。

通过 dispatch fence 后，每个 item 的 prepared executor 只允许执行一次生成调用：Seedream 是一次生成 POST；Qwen 是一次生成 POST，之后可按供应商合同执行一次结果文件 GET，但绝不重发生成 POST。Seedream 4.5 严格要求官方固定的 JPEG 输出，5.0 当前严格要求请求的 PNG。供应商 request ID 与本地关联 ID 分开保存；收到供应商 ID 后，如果响应解码、结果下载、图片校验或本地 spool 失败，该 ID 会随 `MARK_AMBIGUOUS` 保存并进入 `RECONCILIATION_REQUIRED`，不能作为普通失败自动重试。现有测试全部使用 mock fetch，证明 prepare 阶段零网络、单次调用、4.5 JPEG 合同和 provider request ID 保留；没有读取真实密钥，也没有产生费用。

该 executor 切片完成时还不包含 CVM 守护、定时 sweep 或实机故障验证；后续 `e4afa10` 补上同机私有控制面和空队列 daemon 验收，`0031550` 又以无供应商网络的隔离栈补齐活动 item 的 fenced I/O、ACK 丢失和 spool 恢复。2026-09-13 的独立付费 Canary 进一步验证了一次 Seedream 4.5 真实供应商成功返回、私有输出落盘、fenced commit 和 owner 下载，但未覆盖真实供应商超时/不确定响应，因此仍不能解除 `GENERATION_QUEUE_NOT_READY`。consumer 只通过受控内部接口访问任务，不获得 SQLite、对象目录或桶凭据。

### Phase 4C CVM 守护与本地运输基线

代码已把 `HttpConsumerControlPlane`、`FileSystemConsumerSpool` 和国内单任务 executor 装配成独立 Node ESM consumer，并以 `e4afa10` 部署到 CVM 完成空队列运行验收。daemon 严格串行：同一时刻只运行一次 spool 恢复/清理、一次 sweep 或一个 `runOne`，不会让定时维护与供应商调用重叠。连续完成若干 item 后会主动让出事件循环；空队列和控制面故障分别使用有上限的 full-jitter 退避，避免断网热循环。实机曾发现退避 timer 被 `unref` 会让 top-level await 以 13 退出，`e4afa10` 已只针对 daemon 常驻退避移除该调用；租约心跳 timer 仍保持原语义。

每次 claim 使用独立请求 ID；如果请求抛错、响应是否送达不明确，daemon 必须原值重试，只有拿到 `idle | completed | safe-failure | reconciliation-required` 明确结果后才轮换。SIGTERM/SIGINT 只停止新领取并中断等待，不取消已经开始的供应商请求；活动 `runOne` 完成到可恢复边界后退出，容器预留 10 分钟 stop grace。租约仍由 `runOne` 心跳续期，provider timeout 独立限制为 30—180 秒。

容器入口使用 Linux 内核 `flock --no-fork` 对共享持久目录中的固定锁文件加非阻塞独占锁，第二进程或第二容器不能同时运行；无额外等待子进程，因此 Node 进程可以直接接收容器停止信号并执行优雅停机。进程崩溃、容器被强杀或 PID 复用都由内核文件描述符生命周期释放锁，不做存在 TOCTOU 的 socket/PID 文件清理。健康状态原子写入 0600 文件，只包含 `starting | ready | degraded | draining | stopped`、时间、计数和规范化错误码。Compose 不暴露端口、固定以 UID/GID 10001 的非 root 身份和只读根文件系统运行、移除 Linux capabilities，并把三类密钥作为独立只读文件挂载到 `/run/secrets`；CVM 部署步骤必须把持久目录和 secret 文件属主设为 10001，secret 权限设为 0400/0600，运行时也会拒绝错误 owner、组/其他可读写和路径中的符号链接。

`.quarantine` 仅用于付费结果或损坏记录的短期人工取证，不是权威任务状态。维护先完整检查真实目录且不跟随符号链接，再按 7 天 TTL、100 条、1 GiB 上限最旧优先清理，绝不触碰活动 attempt。任何清理异常都会停止本轮维护并让健康状态降级。`RECONCILIATION_REQUIRED` 仍由 D1 状态机作为权威人工对账入口；已部署的 `0016` 另以只追加实体 DLQ 记录明确无供应商调用证据的最终失败，不改变 daemon 行为，也绝不自动重新调用供应商。

当前 claim 不支持按 consumer 能力筛选，所以首版配置必须同时提供 Seedream 与 Qwen 两个账号槽位；模型和供应商端点仍由服务端冻结白名单与 provider 适配器决定。CVM 已验证空队列内部 HMAC、nonce 重放、容器单实例、优雅重启和控制面断网恢复；后续独立 active-item 栈又验证了 claim ACK 丢失、提交前租约过期、fenced input/output、output ACK 丢失、spool 崩溃恢复和提交后人工对账。独立 Seedream 4.5 Canary 又以单 attempt、无重试完成了真实付费闭环。正式内部 API 保持 0、consumer 主动停止且 `restart=no`；公开 `GENERATION_QUEUE_NOT_READY` 安全门保持关闭。尚未覆盖真实供应商超时的生产处置和多用户长时运行。

### Phase 4C 零费用 active-item 验收切片

本地新增的 `0013_volatile_blade.sql` 给 item 增加默认值为 `provider` 的 `execution_kind`，并增加只保存固定 run、item、场景和夹具摘要的 `generation_acceptance_runs`。数据库触发器拒绝未知 execution kind 和 scenario。公开创建路径不传该字段，因此仍只能生成 `provider` item；`D1GenerationQueue` 的领取 SQL 必须精确按 execution kind 过滤，验收领取还必须携带由规范 run ID 派生的目标 item ID，claim request 重放必须同时保持执行类型与目标 item 一致。

验收任务同时要求：`execution_kind=acceptance`、`provider_key=acceptance`、`provider_preference=acceptance-fixture-v1`、`queue_acceptance:` owner、匹配的 acceptance run、固定输入 SHA-256 和固定工作说明。输出也必须是固定 PNG 摘要、空 provider request ID 和固定模板版本。任一条件被修改都会在 dispatch/输出提交之前拒绝。正式国内 executor 额外拒绝任何非 `provider` 工作说明。

验收 bundle 的 executor 不接收 fetch、URL、模型或 Key，只把内置 320×320 PNG 经过真实 input ticket、临时 spool、output ticket、R2/本机对象与 fenced D1 提交流程写回。专用 Compose 的 admin 无网络；probe 只有 internal control 网络，不挂载供应商密钥，也不连接 provider egress；它和正式 consumer 锁住同一宿主 inode，防止并行。场景只能由固定 run ID 前缀选择，不能携带任意故障点或执行参数；验收 sweep 必须同时声明 `executionKind=acceptance` 和目标 item，服务端 SQL 再限定该 item，不会顺带恢复同库其他验收任务。

本地端到端测试已用真实 Node SQLite、本机对象存储和文件 spool 验证一个目标 job/item 的 happy path，以及 claim ACK 丢失、提交前租约过期安全重试、output ACK 丢失幂等确认、spool 落盘后进程崩溃恢复、提交后租约过期转人工对账。恢复路径分别证明不会重复 attempt 或重复 executor；危险的提交后中断只把内部 item/attempt 标记为 `RECONCILIATION_REQUIRED/AMBIGUOUS`，公开 job 保持 `VALIDATING`。同库其他 run、其他 item spool 和旧版 provider spool 仍保持隔离/兼容。

提交 `0031550e04629014857d05e0dfb39e6f00948213` 已在腾讯 CVM 使用独立 SQLite、对象和 spool 目录复跑六组固定场景。验收 Web 无宿主端口、admin 无网络、probe 只连 internal control 网络，不挂载供应商密钥或连接 provider egress；正式 consumer 全程停止。实机结果与本地合同一致，生产依赖审计为 0 个已知漏洞。该次验收后专用 Web 已停止，当时的私有 Web 保持旧发布指针健康；在该历史节点，`0014` 的对账管理与 `0015` 的安全重排已本地实现但尚未部署。实体 DLQ 增强、真实供应商超时和付费闭环仍是后续范围。

后续不可变发布 `fd44583b091f9b99ba38089856bcb1e51b9b9760` 已将 `0013`—`0015` 应用到 CVM 正式私测 SQLite。部署合同把 `sites-demo`、不信任客户端身份头、内部 API 关闭硬编码在 Compose 中，不允许环境文件静默升权。离线备份同时持有 Web/consumer 锁，复制整个 SQLite 目录和对象目录，在无网络、非 root、只读容器根文件系统中验证 integrity/FK 与 SHA-256 manifest。迁移后 16 条历史校验和与镜像一致，Web 仍仅宿主回环可达，consumer 与内部 API 仍关闭，公开生成硬门未解除。此次验收没有供应商调用或费用。

2026-09-13 的独立供应商 Canary 使用不可变提交 `d3c14fcefaf78d6f4a8146883c9442d9eca84788`、独立 SQLite/对象/spool 目录与专用 Compose，不改动正式私测栈。脚本在打开 provider egress 前精确验证固定 item、Seedream 4.5、480×480 夹具摘要、2K、1:1、单张输出与最大 attempt=1，并以持久化付费标记拒绝再次执行。本次唯一供应商调用约 25 秒后返回 2048×2048 JPEG，经私有落盘、摘要核对、fenced commit 和 owner 下载成功；任务无对账 case 或 DLQ。验收后真实供应商 Key 已删除，Canary 进程已停止，正式 Web 仍指向 `297df65f8a7316ee161f608d50ed006d1cbaf64b`，内部 API、正式 consumer 和公开生图硬门均保持关闭。

暂停 Sites 后的单机 CVM 私测路线复用相同的 8 条内部路由和 `0009`—`0012` 状态机。CVM 构建把 Cloudflare binding seam 映射为真实 SQLite D1 兼容层与本机对象存储；Web 与 consumer 通过专用 `queue-control` Docker bridge 通信。Docker 29 实机上，仅连接 internal bridge 的 Web 不会实际建立宿主端口映射，因此 Web 另接仅它使用的 `web-loopback-publish` bridge；端口使用 Compose long syntax 精确绑定 `127.0.0.1:3000`，该 bridge 的默认绑定同样固定到回环地址并关闭 IP masquerade，consumer 不接入该网络。默认控制面仍只允许 HTTPS；只有 Node runtime 双方显式配置 `private-docker` 时才接受精确的 `http://zaoshi-web:3000/`，其他 HTTP 主机、IP、端口和路径全部拒绝。该模式仅用于同一主机的私有测试，不是跨主机或公网生产传输。

`private-docker` 的 HMAC、正文摘要和 nonce 只保护请求身份、完整性与重放，不为 HTTP 响应和图片内容提供加密或完整性保证。因此它只在宿主内核、root、Docker daemon、Web、consumer 全部可信、`queue-control` 不连接第三个服务、且联调素材不含用户隐私时可接受；任何同网恶意 peer 都可能观察或篡改工作说明、ticket 或图片响应。跨主机、公网或正式生产必须改用经过证书校验的 TLS 控制面。

Node Web 启用内部 API 时，HMAC 和 ticket secret 必须从 `/run/secrets` 下同运行 UID、0400/0600、非符号链接的文件加载，内容必须是至少 32 个字符的可打印 UTF-8 文本；不能直接使用可能含 NUL/换行或解码损失的任意二进制随机字节。禁止同时配置同名明文 secret。共享 HMAC 只挂给 Web 与 consumer；ticket secret 只挂给 Web；Seedream/Qwen Key 只挂给 consumer。Web 不接 provider egress，`web-loopback-publish` 已在当前 CVM 实测宿主回环可达且容器外连被阻断；consumer 不挂 SQLite、对象目录或 ticket secret。公开国内生成硬门在任何 Web 侧供应商凭据检查之前返回，因此当前私测接线不会要求 Web 保存供应商 Key，也不会开放浏览器真实生图。禁用 masquerade 是本次单机私测的纵深防护，不替代正式环境的 egress firewall 与经过证书校验的 HTTPS。

直连 CVM 的两个 Web Compose 合同强制 `sites-demo + TRUST_PLATFORM_IDENTITY_HEADERS=0 + GENERATION_INTERNAL_API_ENABLED=0`，并覆盖环境文件中的同名值；当前 SSH 私测不能信任客户端传入的 `oai-authenticated-user-*` 头。Web-only 配置也使用独占、禁 IP masquerade 的回环发布网络。未来可信身份代理或队列 Canary 必须使用单独评审的部署合同，不能通过修改环境文件使当前私测栈静默升级权限。

SQLite 迁移前使用 `deploy/cvm/backup-safe.sh` 做离线一致性快照：Web 与 consumer 必须停止，脚本验证传入旧镜像 SHA 与已安装 Web 容器一致，并在复制和校验全过程持有 `.web.lock` 与 `.consumer.lock`。备份包含整个 DB 目录（含 WAL/SHM）及 objects，拒绝任何源或备份根符号链接；随后在 `--network none`、只读容器根文件系统中，以只读/query-only 连接验证备份副本的 `integrity_check` 与 `foreign_key_check` 并生成摘要清单。恢复快照属于破坏性操作，必须单独授权；迁移成功后通常只回退兼容的旧应用镜像，不执行 down migration 或删除审计表。

### 公开任务与逐张 item 原子创建

两个公开任务创建入口在完成鉴权、owner、资产 READY/kind、模型能力和输入体积检查后，调用同一原子创建原语。该原语只允许 D1/R2 模式和国产模型，把一条 `generation_jobs` 与 `outputCount` 条 `generation_job_items` 放在同一 D1 batch 中；item ID 由 `(jobId, ordinal)` 确定，`provider_key` 只根据服务端冻结的模型推导。任一 item 写入失败会连同 job 一起回滚，不留下无法消费的半成品任务。

owner/idempotency 重放读取原任务，不增加 item；同 key 不同请求仍由公开合同返回冲突。普通重放不会为缺失 item 的历史任务补写数据，而是在请求 hash 确认后校验 item 数量、ordinal、owner、模型和 provider key 并 fail closed，避免把来源不明的旧任务突然加入计费执行。旧 `createJobIdempotently` 只为内存演示与历史兼容保留；公开入口不再调用 `scheduleBackground(processGenerationJob)`。当前安全门在原子写入之前固定返回 `GENERATION_QUEUE_NOT_READY`，所以本地接线不等于已开放生产队列。

## 旧演示供应商输出映射

以下 OpenAI / Google 映射仅保留用于内部 `sites-demo` 兼容和历史测试，新任务 API 不接受这些 provider 值，前端也不展示。

OpenAI `gpt-image-2` 使用 Images Edits，并显式传递 `size` 和 `quality`。以下尺寸均为 16 的倍数，最长边不超过 3840，像素总数不超过 8,294,400：

| 分辨率 | 1:1 | 4:3 | 3:2 | 16:9 | 9:16 |
| --- | --- | --- | --- | --- | --- |
| 1K | 1024x1024 | 1024x768 | 1152x768 | 1280x720 | 720x1280 |
| 2K | 2048x2048 | 2048x1536 | 2304x1536 | 2048x1152 | 1152x2048 |
| 4K | 2880x2880 | 3200x2400 | 3456x2304 | 3840x2160 | 2160x3840 |

质量映射为 `draft -> low`、`standard -> medium`、`high -> high`，仅 OpenAI 路径是原生 quality 参数；Google 路径的质量是提示词意图。两者真实传递分辨率与画幅，不宣称额外的未接入工作流能力。扩散 Steps/CFG/Sampler/Seed/ControlNet strength 仅作为禁用的未来说明，不会发送。

Google 请求保持产品枚举，发送 `response_format.image_size` 的大写 `1K | 2K | 4K` 和 `response_format.aspect_ratio`。Google 当前逐张生成，多张任务在后续变体失败时保留已完成结果并诚实返回部分成功。

## 国产图片供应商输出映射

- Seedream：三项固定 model ID 共用火山方舟北京同步图片接口，当前统一保守开放 2K；Seedream 5.0 Pro/Lite 按官方示例发送 `output_format: "png"`，4.5 保持供应商默认格式。真实任务继续受队列闸门保护。
- Qwen：三个模型名称共用阿里云百炼北京区接口，并原样写入请求体 `model`；业务空间 ID 只用于构造 `*.cn-beijing.maas.aliyuncs.com` 官方域名，图生图最多三张输入图。
- Hunyuan 与 Kling 适配器代码仅作为历史/后续候选保留，不在四个工作台、六模型新建任务或当前生产路由中。Kling 涉及跨境传输，未来重新启用前必须完成可恢复队列、单独告知、隐私和供应商合同核查。

所有 URL 输出仅允许 HTTPS 和供应商官方结果域名，禁用跳转，限制响应体大小，并继续经过生成图片真实格式校验。当前透明 Alpha mask 没有映射成这四个供应商的硬选区参数，局部编辑会明确拒绝，不能宣传为硬约束。完整能力与官方链接见 [DOMESTIC_MODEL_CAPABILITIES.md](DOMESTIC_MODEL_CAPABILITIES.md)。

真实密钥默认不向普通用户开放。可信身份可以来自已验证且显式开启的 Sites 身份代理，或 CVM 数据库中的微信网站应用会话；CVM 始终保持 `TRUST_PLATFORM_IDENTITY_HEADERS=0`。微信 state、浏览器 nonce、身份主体和会话 token 只保存 HMAC，不保存 OAuth code、access token 或原始 openid；同浏览器只保留一个未完成 state，数据库另设全站未完成上限，公网仍需由可信反向代理执行 IP 限流。新任务的每日输出量、待处理数量和单用户活动并发由服务端冻结；配额占用、job/items 与按输出计价的积分预留在同一 D1/SQLite batch 中提交。积分金额和价格版本只允许服务端注入，成功输出原子结算，确定的供应商调用前失败经 DLQ 原子释放，结果不确定时保持冻结并进入人工对账；既有供应商并发闸门继续生效。公开生成硬门、Canary 限制和内容合规仍未解除；`price-v1` 只完成本地验证，尚未部署。

## D1 迁移策略

- 正式新环境必须按顺序执行仓库中的全部迁移：`0000` 至 `0024`。不要只执行最新的一个 SQL 文件，也不要跳过中间版本；应使用项目既有的 Drizzle migration 机制记录执行历史。
- 第二个迁移给任务表增加 `depth_asset_id`、`normal_asset_id` 以及 6 个生成控制字段。
- 旧任务行使用安全默认值：`concept / 1K / 4:3 / standard / mixed / 4000K`；控制图 ID 为 `NULL`。
- 第三个迁移 `0002_advanced_settings.sql` 增加 `advanced_settings_json TEXT NOT NULL`，规范默认 JSON 与运行时初始化一致。
- `0004_old_mindworm.sql` 以 additive 方式增加可空的 `custom_prompt`，并增加 `(owner_id,workflow_type,created_at,id)` 任务列表索引；`0007_additional_references.sql` 以 additive 方式增加多参考素材字段。
- `0008_nullable_generation_source.sql` 以 D1 安全方式受控重建 `generation_jobs` 与 `generation_job_outputs`，保留旧任务、输出关系、外键和索引，同时允许自助工作台的 `source_asset_id` 为空。发布前必须完成该迁移并核对迁移历史；写入首个空 source 任务后，旧版本不能直接回滚读取该行。
- `0009_cheerful_infant_terrible.sql` 只新增 `generation_job_items`、`generation_attempts` 及其索引，不回填或自动执行历史任务。该迁移已应用到当前 CVM SQLite，但尚未发布到旧 Sites D1；任一环境一旦应用便与 `0000`—`0008` 一样不可重写。
- `0010_round_aaron_stack.sql` 只新增内部机器请求 nonce hash 表和过期索引，不保存密钥、请求正文或用户信息。`0011_nebulous_angel.sql` 以 nullable 列为 attempt 增加 claim 请求幂等字段，因此即使 `0009` 与 `0011` 之间已有历史 attempt 也能安全升级；新领取仍强制写入非空请求 ID 和 worker ID。
- `0012_loving_weapon_omega.sql` 新增逐 item 唯一的 fenced 输出提交记录，保存不可覆盖对象的摘要与提交状态。当前 CVM SQLite 已按顺序应用 `0009`—`0012`；旧 Sites D1 仍未应用这些迁移，若恢复该路线，必须先按顺序应用并核对迁移历史，再发布依赖这些表的代码和启用内部控制面。任一环境应用后只能追加后续迁移，不能改写。
- `0013_volatile_blade.sql` 追加验收执行类型、可运行索引和固定验收 run 表；默认值保持所有既有 item 为 `provider`。该迁移已应用到 CVM 正式私测与独立 active-item 验收 SQLite，旧 Sites 尚未应用。它一旦在环境中应用便不得改写。
- `0014_generation_reconciliation.sql` 新增 provider 人工对账 case 与追加式事件。case 由 item 进入 `RECONCILIATION_REQUIRED` 原子创建；只有匹配的 fenced output commit 真正 `COMMITTED` 才能自动关闭。管理员 API 的唯一写动作 `ADD_NOTE` 复用 `(case_id, action_id)` 唯一索引实现精确幂等，只追加事件而不修改 case。该迁移已在本地临时数据库和 CVM 正式私测 SQLite 验证，旧 Sites 尚未部署；已应用环境不得改写。
- `0015_safe_generation_requeue.sql` 新增独立、追加式的管理员队列动作表。数据库触发器只允许 provider `FAILED` item 在失败预算未耗尽、无活动 lease、current attempt 与 item 的 lease generation 一致、所有 attempt 均无供应商调用证据、没有输出提交/任务输出/人工对账 case 时执行 `REQUEUE_BEFORE_PROVIDER`。动作保留 `attempt_count`、`max_attempts`、`current_attempt_id` 和失败历史，清理 item 错误状态并递增 lease generation；后续普通 claim 才创建新 attempt。动作 ID 支持精确幂等，记录禁止更新和删除，外键使用 `RESTRICT` 保护审计；未来任务删除必须先设计审计归档策略。该迁移已在本地临时数据库和 CVM 正式私测 SQLite 验证，旧 Sites 尚未部署；已应用环境不得改写。
- `0016_generation_dead_letters.sql` 新增只追加的实体 DLQ，只记录确定发生在供应商调用前的 provider `FAILED` attempt。当前失败记录要求整个 item 没有 provider、输出或对账证据；历史安全重排记录以 `0015` 的不可变审计动作证明它在重排当时满足条件，因此后续 attempt 的供应商活动不会抹去旧事实，而 ambiguous attempt 本身永远不会被收纳。它不改队列状态也不可被 consumer 领取；acceptance 同样被排除。通用队列转换禁止直接进入 `FAILED`，只能使用会写入失败分类的安全失败路径；provider 状态若无法在同一事务生成匹配 DLQ 会整体中止，迁移也会拒绝遗留未分类的 provider `FAILED`。条目拒绝 UPDATE/DELETE/REPLACE，当前/已处理状态由既有 `REQUEUE_BEFORE_PROVIDER` 审计证据派生。管理 API 仅 GET，不返回用户、提示词、错误正文、图片、存储路径或 provider request ID。外键 `RESTRICT` 和只追加记录会阻止现有任务硬删除；用户删除上线前必须另行设计审计保留与匿名化，不能改成 `CASCADE`。该迁移已在本地与 CVM 验证，旧 Sites 尚未部署；已应用环境不得改写，后续修复必须追加新编号迁移，整库恢复只允许在迁移后无新写入的离线窗口使用。
- `0017_wechat_auth.sql` 追加用户、微信身份、一次性 OAuth state 与服务端会话表；微信主体和 token 只保存 HMAC，用户停用或会话撤销后立即拒绝访问。`0018_generation_quotas.sql` 追加用户生成限制与幂等配额准入记录；每日输出和待处理上限与 job/items 原子写入，精确幂等重放不重复占额。两项目前只完成本地实现与验证，尚未部署到 CVM；已应用环境不得改写。
- `0019_credit_ledger.sql` 追加不可更新/删除的积分事件账本，以 `CREDIT / RESERVE / SETTLE / RELEASE` 记录充值、逐输出预留、成功结算和安全释放。余额由账本事件求和，数据库触发器禁止超额预留、无积分领取、重复结算和对不确定结果释放积分；安全重排必须先建立新预留。`price-v1` 由服务端根据冻结模型、有效分辨率、实际供应商输入图数和输出数报价，四个工作台及参考图晋升入口只显示服务端报价；新任务提交时必须携带用户确认的版本/总额，服务端再次核价并在同一事务逐输出预留，价格变化返回 409；幂等重放沿用原预留的价格版本，不随新版价格表改价。该迁移与价格切片只完成本地实现与验证，尚未部署到 CVM；正式启用前还需完成受控充值/补偿入口，已应用环境不得改写。
- `0020_admin_console_analytics.sql` 追加不可更新/删除的管理员审计事件、低隐私页面访问事件及管理查询索引。统一管理员权限来自可信 `ADMIN` 账户或服务端 `ADMIN_EMAILS`；统一管理员同时通过图库与生成对账检查，原有两个专用 allowlist 只保留最小分权兼容。额度/停用和正向积分操作均通过同一事务绑定幂等审计；不提供角色提升、负向扣分、删除账本、伪造结算或在线密钥编辑。访问事件只保存访客随机 Cookie 的 SHA-256、白名单路径和有界停留时间，不保存 IP、UA、来源、查询参数或用户 ID；日/周/月按北京时间聚合并设置每日 10000 条全局硬上限。CVM 唯一 Web 进程的每小时生命周期循环严格删除早于 90 天的数据，启动后最多 60 秒追赶；失败不会更新维护健康时间。管理员审计视图汇总七类不可变事件并只返回白名单详情，公开 `/api/health` 只暴露固定告警码。支付订单和供应商余额尚无可信数据源，接口明确返回未接入而不是推测。该功能只完成本地实现与验证，尚未部署到 CVM；已应用环境不得改写迁移。
- `0021_recharge_orders.sql` 新增冻结商品金额的充值订单和不可修改的已验签支付事件。首期固定 `100 积分 = ¥1`，目录为 ¥10/30/50/100；订单创建不写积分，支付事件由未来渠道适配器验签后写入，数据库在同一事务内完成 `PENDING → PAID → CREDITED`、唯一 `RECHARGE_PAID` 账本事件和订单反向绑定。事件 ID、渠道交易号、订单幂等键及账本键均唯一；渠道、金额、支付时间、过期状态或重放正文不一致时拒绝。当前只有服务端核心和本地测试，没有公开充值 API、真实渠道验签、退款或部署。
- `0022_image_sanitization_proof.sql` 为资产与 fenced 输出提交增加不可变的 `sanitization_version` 证明，不回填历史记录。当前版本为 `canonical-image-v1`：新上传、Vision 派生图及供应商输出只有在服务端完整解码、应用方向并按原 MIME 重新编码后才能写入该版本。新任务只接受版本匹配的 READY 输入；历史 READY 资产仍可由 owner 查看和下载，但必须重新上传后才能进入新任务。旧 provider spool 或未提交输出缺少证明时进入人工对账，不会自动再次调用供应商；固定 acceptance 夹具保持 `NULL` 并继续与 provider 隔离。该迁移只完成本地实现与验证，尚未部署。
- `0023_asset_lifecycle.sql` 增加图片状态、保留期、不可逆删除标记、可重试对象清理任务，以及审核/删除/图库/维护动作的只追加审计。状态列保留给未来腾讯机器审核；当前应用创建的新输入/输出直接写 `APPROVED`，其含义仅为允许进入供应商处理，不代表人工审核。人工逐图审核、用户图库投稿及相关管理员路由均返回 404；违规输入依赖 Seedream/Qwen 的供应商机器安全策略拒绝，腾讯图片安全默认关闭。用户删除先在数据库中幂等 tombstone，再清理私有对象；活动 generation item 会阻止删除。上传素材与生成结果默认保留 30/90 天。对象读取核对数据库字节数、SHA-256 和存储元数据。CVM 唯一 Web 进程每小时有界扫描；对象清理进程内互斥，失败 8 次进入 `BLOCKED`，管理员显式重试写只追加审计。该迁移尚未部署；部署后只允许前向修复，回退需在无新写入的离线窗口同时恢复数据库和对象备份。
- 部署 `297df65f8a7316ee161f608d50ed006d1cbaf64b` 已将 `0016` 应用到 CVM 正式私测 SQLite。迁移前用旧镜像生成并复核完整离线备份 manifest；迁移后 17 条摘要全部匹配，integrity 为 `ok`、FK 违规为 0，DLQ 表、唯一索引和五个永久触发器存在，临时 guard 已清理，生成相关数据与 DLQ 均为 0。Web 保持 loopback、非 root、只读根、无 capabilities；consumer、内部 API、可信身份头和公开生成保持关闭。管理伪造身份为 401、DLQ POST 为 405、内部 claim 返回 404、国产公开生成仍为 503；未调用供应商，费用为 0。旧 Sites 尚未应用 `0016`；已应用环境不得改写该迁移，后续修复必须追加新编号迁移。
- `0024_space_type.sql` 为任务追加 `space_type`，历史行默认 `unspecified`；概念/高级新任务的具体房间类型随队列 work 传给模型。该迁移尚未部署。上线时先停旧 consumer、确认无活动 item/待对账/待提交输出，备份并应用 `0024`，然后启动同一完整 SHA 的 Web 与 consumer。旧 consumer 的精确字段解析会拒绝新 work；存在 `space_type <> 'unspecified'` 的非终态任务时，不得回滚至旧 consumer 或只降级 Web，应保留新 consumer 或前向修复，避免静默丢失房间提示。
- 运行时初始化读取 `PRAGMA table_info(generation_jobs)` 的自愈补列逻辑，仅用于本地或早期演示环境兼容已经存在但没有完整迁移记录的数据库；它不会覆盖已有值，也不能替代正式 migration。生产部署不得依赖自愈逻辑在缺少迁移的数据库上补结构，必须先完成 `0000` 到 `0024` 的正式迁移并核对迁移历史。

## 安全与部署风险

- 对象默认私有；所有元数据、内容读取、控制图和视觉预处理均按 owner 校验。
- 日志不得包含密钥、图片二进制、R2 key、长期访问 URL、GPS 或完整用户输入。
- CVM 图片入口、Vision 派生图和供应商输出在写入对象存储前，必须通过固定版本的 Node 图像编解码器完整解码、应用 EXIF 方向、拒绝动画及尺寸/像素/体积上限，并按原 MIME 重新编码；摘要、大小和清洗版本都基于重新编码后的无元数据字节。上传入口还会逐块限制 multipart 正文，旧 OpenAI 兼容路径只发送服务端生成的文件名。处理失败时不得保存原始字节或把输出标记为 READY；暂停中的 Sites 若未提供等价图片处理绑定则 fail-closed。历史 `READY` 资产因没有版本证明只能查看和下载，重新上传后才可进入新任务；用户删除、可重试对象清理、保留期规则和 CVM 定时清理已完成本地实现。当前不做人工逐图审核；腾讯机器审核是默认关闭的未来闸门，供应商安全拒绝码统一映射、投诉/复审仍需后续实现。
- 旧 Sites 的 `waitUntil` 只适合演示，不能承担真实生图任务或证明重启恢复。CVM 已完成队列运输、consumer、DLQ、定时恢复、fenced 输出和单张付费闭环验证；可信微信会话、用户/供应商配额并发、积分账本和 `price-v1` 已完成本地实现但尚未部署。正式收费前仍必须补齐真实扫码/代理限流验收、支付、监控告警和受控补偿。

## Preview/final 与模板合同

`purpose` 默认 `final`。Preview 服务端固定 `quality=draft`、输出数量 1；有效分辨率按模型能力冻结（Seedream 为 2K，其余当前国产图片模型为 1K）。finalize 只接受 owner 所有、成功 preview 的 READY 输出，记录 `sourceJobId`、`promotedFromAssetId` 和 output parent lineage。旧 `auto | openai | google` 任务仍可读取，但不得 finalize 或静默转换为 Seedream。Promoted prompt 明确是参考图高清重生成，不承诺像素级锁定或无损放大；advanced 历史 output 仅是受 owner/kind 校验的精修兼容例外。

先执行 additive migration 再发布应用；runtime self-heal 只补列、索引及旧 effective resolution 回填。模板配置严格 allowlist，分享只读参数快照且数据库仅保存 token hash；模板中的参考图信息只允许角色与建议数量，不能包含资产 ID、URL、字节或文件。自助模板私有存储可保留用户提示词，但分享响应会删除 `customPrompt`。旧 Sites 当前只做构建验证，旧 D1 补齐 `0009`—`0024` 前不得发布当前包。

### 输出持久化 saga 与恢复边界

生成输出使用确定性的 `(jobId, ordinal)`：D1 先以 `PENDING` 插入资产（`INSERT OR IGNORE`），R2 使用 `onlyIf.etagDoesNotMatch: "*"`，随后读取并校验 `assetId/kind/sha256` 元数据，必要时回读字节计算摘要。确认对象后，D1 `batch()` 原子执行输出关系 `INSERT OR IGNORE` 与仅在精确关系存在时的 `PENDING -> READY` 更新；查询只暴露 `READY`。

任务轮询会按任务 owner 和 `outputCount` 扫描确定性输出，恢复有效 R2 对象，或清理超过 10 分钟且仍未关联的 `PENDING` 行；阈值内的行保持隐藏以避免活动写入竞争。清理先条件删除 D1 行，只有删除成功才删除 R2，绝不删除已成为有效关系的 winner。该机制没有租约或 reaper，生产部署仍须先执行 additive migration，再发布应用；不依赖 schema migration 来表达文本状态。
