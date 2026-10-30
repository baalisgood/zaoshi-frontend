# 微信 Native 支付配置与本地验收

本轮仅本地开发，未创建真实微信订单或部署。已有 Native 下单、查单、通知验签/AES-GCM、积分账本原子入账继续复用。只接微信扫码，未增加退款功能。

## 商户材料与缺项

商户 API 证书压缩包通常包含 `apiclient_key.pem`（商户请求签名私钥）与 `apiclient_cert.pem`（商户证书，可取证书序列号）；微信支付公钥文件用于验证微信返回和通知，两者用途不同。用户已提供这两类文件；开发未读取或复制真实文件内容，不能据此声称内容/归属已经验证。

上线配置仍需商户平台绑定且获准 Native 支付的 `WECHAT_PAY_APP_ID`、下载公钥对应的 `WECHAT_PAY_PUBLIC_KEY_ID`（通常以 `PUB_KEY_ID_` 开头）及 32 字节 APIv3 密钥。微信网站登录 AppID 不默认等于可用的支付 AppID，必须在商户平台核对绑定关系/Native 产品权限。APIv3密钥不是商户私钥，也不能从公钥文件推导。

服务端设置 `WECHAT_PAY_ENABLED=1`、`WECHAT_PAY_MCH_ID`、`WECHAT_PAY_MERCHANT_SERIAL`、`WECHAT_PAY_PUBLIC_KEY_ID`、`WECHAT_PAY_APP_ID`、`WECHAT_PAY_NOTIFY_URL=https://本站/api/recharge/wechat/notify`、`SERVICE_OPERATOR_NAME`、`SERVICE_CONTACT`。保留既有邮箱账户/认证/积分配置。以下三项只用挂载文件，不把原文放环境变量、前端或Git：

- `WECHAT_PAY_PRIVATE_KEY_FILE=/run/secrets/wechat-pay-private.pem`
- `WECHAT_PAY_API_V3_KEY_FILE=/run/secrets/wechat-pay-api-v3`
- `WECHAT_PAY_PUBLIC_KEY_FILE=/run/secrets/wechat-pay-public.pem`

按现有 Node secret loader 要求：路径必须在 `/run/secrets` 内，文件是当前服务UID所有、0400/0600普通文件，目录不可组/其他用户写，禁止符号链接。只在既有本地/服务端安全secret位置准备文件；不上传证书压缩包到站点或仓库。可选 `WECHAT_PAY_PREVIOUS_PUBLIC_KEY_ID`/`WECHAT_PAY_PREVIOUS_PUBLIC_KEY_FILE` 支持轮换期间验签。

`node scripts/wechat-pay-preflight.mjs` 只检查变量是否存在及文件元数据，不打开/解压/输出密钥。输出 `metadata_ok_contents_not_checked` 仅表示路径权限满足元数据检查，不证明密钥匹配、APIv3长度、商户绑定、回调公网可达或真实支付成功。实际Node启动时仍通过既有loader校验密钥格式。

## 状态与恢复

二维码30分钟后隐藏，过期本身不证明未支付。用户可查询同一订单或取消后更换套餐。取消先查微信；SUCCESS沿用同一事实入账，NOTPAY才请求官方关单。仅验签成功的关单响应或查单CLOSED/REVOKED可条件关闭本地PENDING，超时/未知响应保留原单。关闭后迟到的成功通知留待核对，不伪造退款或到账。

同一用户/请求key恢复原单，不同用户隔离；重复通知/查询由数据库事件唯一约束和账本触发器保证一次入账。只有服务端CREDITED才刷新钱包。后台金额基于两版CREDITED订单及匹配RECHARGE_PAID账本，按支付时间统计，不把待支付或待核对金额算入到账。

官方协议：[公钥模式](https://pay.wechatpay.cn/doc/v3/merchant/4013038816)、[Native下单](https://pay.wechatpay.cn/doc/v3/merchant/4012791877)、[关单](https://pay.wechatpay.cn/doc/v3/merchant/4012791881)、[支付通知](https://pay.wechatpay.cn/doc/v3/merchant/4012791882)。

## 恢复边界补充

APIv3文件必须是32字节纯文本，不能使用RTF或带格式的文稿；不能以文件扩展名或元数据检查替代内容格式检查。

已过期原单只有在对应查单请求收到验签HTTP404且精确错误码为ORDER_NOT_EXIST时，才条件转为EXPIRED，允许重新选套餐。普通404、未验签消息、未过期或超时不能据此终止。先前在飞的创建响应不能保存过期/终止二维码，迟到实收仍按原事实入账或保留待核对，异常待核对需人工受审处理。

浏览器不能保存恢复标识时，本次下单请求停止外呼并明确提示；内存保留原标识，恢复存储后重试同一请求。已有订单的查询、已到账后的钱包刷新不依赖存储写入/删除成功。钱包刷新失败保留原订单并允许恢复重试，不把刷新失败误当成支付失败。
