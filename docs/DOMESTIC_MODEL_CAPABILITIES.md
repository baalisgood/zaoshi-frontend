# 国产图片与视频模型能力目录

核对日期：2026-09-25。本文只记录能够从供应商官方文档核验的生产契约；真实账号、额度与网络连通性测试必须通过受控的单张低成本冒烟流程。

## 2026-09-25 六模型上传界面核对

官方输入图总数上限分别为 Seedream 5.0 Pro 10 张、Seedream 5.0 Lite 14 张、Seedream 4.5 14 张，以及 Qwen Image 3.0 Pro、3.0、2.0 Pro 各 3 张。参考来源为[火山方舟 Seedream 图片生成 API](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh&redirect=1)、[阿里云 Qwen 3.0 API](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)和[阿里云 Qwen 2.0 Pro 编辑 API](https://help.aliyun.com/zh/model-studio/qwen-image-edit-api)。总数包含必填底图、参与生成的角色参考图，以及结构模式启用时的 Depth / Normal；后两者只是软参考。普通参考图不依赖模型的原生交互编辑能力。

造室网站仍采用更保守的单图 10MB、Seedream 总计 32MB、Qwen 总计 30MB 和通用 8192px 单边/4000 万像素限制；Seedream 还按已接入输入尺寸约束检查最短边至少 15px、最多 3600 万像素、比例 1/16—16。Qwen 文档中的建议输入尺寸不作为硬拒绝。浏览器接受 JPEG、PNG、WebP，WebP 可经现有清洗路径转为供应商可接收格式；不能因 Seedream 原生请求的 PNG/JPEG 列表提前拒绝原始 WebP。最终服务端上传、模型和队列校验仍是权威。

四工作台只开放 `supportedResolutions` 中已接入且计价的输出规格，每个队列 item 仍只生成单图，不开放 Seedream 关联组图或 Qwen 未接入的原生参数。新概念工作台界面仅提交一张底图和设计方案；服务端保留旧多参考任务、历史与同键重放合同。高级工作台的人工 Depth / Normal 上传依结构模式占用名额，未接硬 ControlNet。本轮没有改模型 ID、费用合同或私测可用模型范围。

[阿里云 Qwen Image 2.0 系列图片编辑文档](https://help.aliyun.com/zh/model-studio/qwen-image-edit-api)列明文本输入超过 1300 tokens 会被截断。高级工作台的 2000 字符补充框不等同于 1300 tokens；本轮没有新增精确 token 计数或提示词编译预算，最终文本长度仍需单独校准。

## 六个国内站模型：官方能力与造室接入范围

| 模型 | 官方输入与生成能力 | 官方编辑 / 特殊能力 | 官方输出边界 | 造室国内站当前开放 |
| --- | --- | --- | --- | --- |
| Seedream 5.0 Pro `doubao-seedream-5-0-pro-260628` | 文生单图、单图生单图、2—10 张参考图生单图 | 坐标、框选、箭头或标记图的交互编辑；单图拆为底图与最多 16 个图层 | 1K / 1.5K / 2K；PNG 或 JPEG；不支持关联组图、联网搜索和流式输出 | 文生图、多参考图生单图、2K；多张输出仍按多次独立任务；交互编辑与图层拆分未接入 |
| Seedream 5.0 Lite `doubao-seedream-5-0-260128` | 文生图、单图生图、2—14 张参考图生图 | 支持 `sequential_image_generation=auto` 的内容关联组图；输入图与输出图合计不超过 15 张 | 2K / 3K / 4K；PNG 或 JPEG；支持联网搜索与流式输出 | 文生图、多参考图生单图、2K；关联组图、联网和流式未接入 |
| Seedream 4.5 `doubao-seedream-4-5-251128` | 文生图、单图生图、2—14 张参考图生图 | 支持内容关联组图；输入图与输出图合计不超过 15 张 | 2K / 4K；固定 JPEG；支持流式输出 | 文生图、多参考图生单图、2K / 4K；关联组图与流式未接入；后端严格校验 JPEG 输出 |
| Qwen Image 3.0 Pro `qwen-image-3.0-pro` | 文生图、1—3 图自然语言编辑与多图融合 | 无独立硬蒙版字段；支持负向提示词、种子、提示词增强与思考配置 | 总像素在 512×512 至 2048×2048 之间，可自定义宽高，比例 1:8—8:1；PNG；`n=1—6` 是独立候选，不是关联组图 | 文生图、最多 3 图软参考编辑、1K / 2K；每个队列 item 单图；高级参数未开放 |
| Qwen Image 3.0 `qwen-image-3.0` | 文生图、1—3 图自然语言编辑与多图融合 | 与 3.0 Pro 使用同类编辑合同；无独立硬蒙版字段 | 总像素在 512×512 至 2048×2048 之间，可自定义宽高，比例 1:8—8:1；PNG；`n=1—6` 是独立候选 | 文生图、最多 3 图软参考编辑、1K / 2K；高级参数未开放 |
| Qwen Image 2.0 Pro `qwen-image-2.0-pro` | 文生图、1—3 图自然语言编辑与多图融合 | 无独立硬蒙版字段；支持负向提示词、种子与布尔提示词增强 | 总像素在 512×512 至 2048×2048 之间，可自定义宽高；PNG；`n=1—6` 是独立候选 | 文生图、最多 3 图软参考编辑、1K / 2K；高级参数未开放 |

六个模型的普通“参考图角色”都不是独立 API 字段。造室按固定顺序发送底图、风格、家具 / 软装、结构、材质、灯光、构图、Depth 和 Normal，并在服务端提示词中说明各图用途。Depth / Normal 只是软视觉引导，不是 ControlNet 硬约束；本地 Alpha 蒙版也没有映射为这六个模型的统一硬蒙版字段。

当前产品为保护 CVM、队列和 Base64 内存，仍采用比供应商更保守的站内限制：单张输入最多 10MB，Seedream 单任务输入总计最多 32MB，Qwen 最多 30MB，单张输出最多 8MB。它们是造室限制，不是对供应商官方上限的转述。

官方资料：

- [火山方舟 Seedream 图片生成 API](https://api.volcengine.com/api-docs/view?action=ImageGenerations&serviceCode=ark&version=2024-01-01)
- [火山方舟 Seedream 5.0 使用教程与模型能力](https://www.volcengine.com/docs/82379/1824121)
- [火山方舟 Seedream 4.0—5.0 提示词指南](https://www.volcengine.com/docs/82379/1829186)
- [火山方舟 Seedream 5.0 Pro 交互编辑](https://www.volcengine.com/docs/82379/2582775)
- [火山方舟 Seedream 5.0 Pro 图层拆分](https://www.volcengine.com/docs/82379/2582774)
- [阿里云百炼图片生成模型总览](https://help.aliyun.com/zh/model-studio/image-model)
- [阿里云百炼 Qwen-Image 3.0 API](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)
- [阿里云百炼 Qwen-Image 2.0 文生图 API](https://help.aliyun.com/zh/model-studio/qwen-image-api)
- [阿里云百炼 Qwen-Image 2.0 图像编辑 API](https://help.aliyun.com/zh/model-studio/qwen-image-edit-api)
- [阿里云百炼错误码](https://help.aliyun.com/zh/model-studio/error-code)
- [腾讯云 TokenHub Hy-Image 3.0](https://cloud.tencent.com/document/product/1823/135745)
- [可灵 Image Omni API](https://kling.ai/document-api/api/image/o1)

## Seedance 边界

Seedance 是视频模型，不是 Seedream 的别名，也不能放进四个图片工作台。火山方舟公开视频任务 API 当前能核验 `Seedance 2.0` 与 `Seedance 2.0 fast`，支持文本及图片、视频、音频组合输入，采用异步任务。当前没有从正式 API 文档核验到可用于生产配置的 Seedance 2.5 模型 ID，因此代码和网站均不得声称已经接入 2.5。

- [火山方舟视频生成任务 API](https://api.volcengine.com/api-docs/view?action=CreateContentsGenerationsTasks&serviceCode=ark&version=2024-01-01)

## 当前未冒充完成的能力

- 四个工作台共享六项下拉，默认 `doubao-seedream-5-0-pro-260628`。数据库继续使用既有 TEXT `provider_preference`，新任务只接受六个 model ID；旧任务保留原始选择并停止处理，不会静默升级。只有旧模板中的已知别名会在读取时映射为新的固定选项。

- 路线第二步已完成 `additionalReferences` 多参考的 API、持久化与任务处理器链路。旧概念任务仍支持风格参考与最多 4 张 `furnishing`（软装/家具），但新概念界面仅提供一张底图；高级工作台支持风格参考、最多 4 张 `furnishing`，以及各 1 张 `structure`、`material`、`lighting-color`、`composition`；平面图工作台只允许平面图主输入、风格参考和最多 4 张 `structure`。自助工作台使用独立的通用有序 `reference` 参考图列表（零至多张，按所选模型限制为 3、10 或 14），不使用上述结构化角色；四类输入都会经过 owner、READY、kind 和供应商输入上限校验。
- 真实产品调用仍因可信登录、用户配额/并发、成本账本和预算闸门尚未完成而 fail-closed；常规适配器测试仍使用模拟响应。只有单张 Seedream 4.5 队列闭环获得了真实付费连通性证据，不代表其他模型或生产长时运行已验证。
- Depth / Normal 在这些通用图生图端点中只是按顺序发送的参考图，不是 ControlNet 硬约束。
- 当前透明 Alpha mask 没有映射为四个国产接口的统一硬蒙版参数；供应商只提供参考式编辑时，网站会明确拒绝硬选区任务。
- 适配器和常规回归测试使用本地模拟 HTTP 响应，不产生真实供应商费用。2026-09-13 已另行完成一次受控 Seedream 4.5 单张付费队列 Canary：480×480 无隐私合成输入、单张 2K、无重试，返回 2048×2048 JPEG 并完成私有存储与 fenced output commit。此证据不代表其他模型或公开生产已就绪；任何新真实调用仍需逐次授权。
- 国内生产环境即使配置密钥也只允许服务端邮箱白名单中的小额测试账号。普通用户限流、并发、积分预扣完成前不会开放；可灵在可恢复队列和跨境合规完成前完全关闭。

## 错误处理边界

- Seedream 与 Qwen 的 HTTP 错误统一归为输入、内容安全、鉴权、余额、限流、超时、暂时不可用或未知服务错误；未知供应商错误码和原始错误正文不会写入队列。
- `retryable` 只描述服务错误类别，不代表任务可以自动重新调用模型。进入供应商调用阶段后的任何失败仍转人工对账，当前自动重发白名单为空，避免重复生成和重复计费。
- 只有供应商官方能够证明某个错误表示“请求未接受、未计费且可安全重放”后，才会连同队列状态机、DLQ 和积分账本一起追加支持；不得只在适配器层开启重试。
