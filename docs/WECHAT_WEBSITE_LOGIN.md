# 微信网站登录（仅本地候选）

保留 `AUTH_MODE=email`，以 `WECHAT_LOGIN_ENABLED=1` 附加网站登录；默认关闭，不改变 Native 支付、PUBLIC 生图、队列或腾讯审核开关。网站应用 AppID：`wx0000000000000000`；支付应用 `wx1111111111111111` 属独立配置，不互换。

配置：`WECHAT_OPEN_APP_ID`、`WECHAT_OPEN_REDIRECT_URI=https://example.com/api/auth/wechat/callback`；开放平台授权回调域为 `example.com`，上线前须核实已审核的域名与网站应用权限。Node 网站 AppSecret 只使用 `/run/secrets` 下的 `WECHAT_OPEN_SECRET_FILE`，拒绝直接值及 `WECHAT_OPEN_APP_SECRET` / `_FILE` 别名。沿用当前 session secret 与 identity pepper，不轮换。不要将真实 AppSecret 放入前端、仓库、预览或日志。

使用现有顶层 `qrconnect` 跳转、`snsapi_login` 与浏览器绑定一次性 state，Secure/HttpOnly `__Host` cookie 不为 HTTP 预览放宽。无配置时显示不可用，可转邮箱；失败只回传固定原因，不暴露 code/token/provider 原文。

已有邮箱账户须先邮箱登录，再从完整个人资料主动 POST 绑定。state 保存 intent、目标 owner 与发起 session hash；回调检查原会话仍有效。绑定保留 owner/namespace/邮箱名称/角色/积分/图片，已属其他 owner 的微信冲突拒绝；普通微信登录不隐式绑定，不按昵称或 unionid 猜测合并。此轮不含微信账户反向绑定已有邮箱、解绑或账户合并。

首次微信新建用户保存一次注册资格，完成当前协议后，在同一事务发放 350 积分。旧账户绑定不补赠；重放/重复确认不重复发放。0034 将 DB34 升至 DB35，只追加 OAuth intent/owner/session 与新用户资格字段，旧值保持。

前端仅本地，未进行真实 OAuth、微信收款或部署。真实 HTTPS 回调与开放平台权限仍需用户实际验证。回退优先关闭附加 flag 并前向修复，保留 DB35、identity、session、账本、充值事实及兼容 consumer；不得覆盖旧库或盲目反迁。

支付标识采用微信官方品牌素材： https://wx.gtimg.com/outwxgtimg/imgs/logo/wxpaylogo_xxxhdpi.png （来自微信支付 SDK 品牌素材页，2026-10-22 下载一次，1152×468 PNG）。页面保持比例且放在二维码 quiet zone 外，不遮盖扫码内容。
