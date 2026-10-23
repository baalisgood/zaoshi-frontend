# 造室前端设计工作区

用于交给 Notion AI 或其他设计工具改版的独立 React + Vite 前端。包含当前页面组件与 CSS；没有原仓库历史、后台实现、真实账户、照片、密钥或部署配置。

## 本地运行

需要 Node.js 24+ 和 npm：

```sh
npm ci
npm run dev -- --port 3141
```

打开 http://127.0.0.1:3141 。`npm test` 验证 mock 网络边界与模拟付款。`npm run build` 运行 TypeScript 检查与生产构建；`npm run preview -- --port 3141` 预览构建结果。

顶部绿色工具栏切换虚构的访客/会员/管理员，以及示例数据、空态、失败态。身份切换只修改当前浏览器；默认管理员便于浏览后台，绝不是实际授权机制。页面刷新保留选择。

## 页面地图

| 路径 | 页面 |
| --- | --- |
| `/` | 首页与灵感图库、详情弹窗 |
| `/studio` | 智能工作台 |
| `/pro` | 高级工作台、局部重绘 |
| `/self-service` | 自助工作台 |
| `/products` | 产品与价格、充值展示 |
| `/login?mode=login` | 邮箱登录，支持注册/找回密码切换 |
| `/login` | 微信登录展示（功能未接入） |
| `/profile` | 个人资料；导航头像也可打开浮层 |
| `/consent` | 协议确认 |
| `/terms` `/privacy` `/usage` `/recharge-policy` | 四个说明页 |
| `/admin` | 总览 |
| `/admin/users` `/admin/credits` `/admin/tasks` | 用户、积分、任务 |
| `/admin/providers` `/admin/analytics` `/admin/audit` | 供应商、运营分析、审计 |
| `/admin/recharge` `/admin/content` `/admin/gallery` | 充值待对账、图片维护、图库 |
| `/admin/generation/reconciliation` `/admin/generation/dead-letters` | 人工对账、死信 |

`/library`、`/floorplan` 为旧入口演示别名。

## 给 Notion AI 的改版说明

请在这个项目内改版全部 UI，保留页面职责、导航关系、响应式布局及浅深主题。优先编辑 `components/**` 与 `app/globals.css`，不要编写真实后端。组件来自现有产品，图片为了公开授权已统一替换为自制占位图，素材说明见 ASSETS.md。可以调整占位图，但请只使用你有权公开分发的素材。

`src/main.tsx` 是演示路由和工具栏；`src/mock.ts` 在挂载 React 前拦截 fetch，仅返回合成数据，未知请求直接报错，不回退到真实服务器。演示不发送邮件、不登录、不调用模型、不收费、不提供真实支付二维码。充值选择套餐后展示不可付款的模拟码，顶部「模拟付款成功」后点击「查询同一订单」可查看成功态；重置草稿可开始下一轮。上传、生成、付费优化和账户变更等业务操作可能显示明确未接入提示；修改交互前可扩展本地 mock。没有生产密钥配置入口，请勿把密钥放入任何前端文件。

## 改版回迁

独立审核后，将 `components/**` 对应回产品的 `components/**`，将 `app/globals.css` 对应回产品同路径。不要把 `src/mock.ts`、演示入口、Vite 配置、CSP 或本项目依赖锁覆盖真实应用。`src/Image.tsx` 只是导出的 next/image 浏览器兼容层；产品继续使用原图片组件。`src/contracts.ts` 是原支付展示所需的纯类型，产品仍用既有服务端类型。`app/admin/**/page.tsx` 是保留的纯客户端后台页面正文。

回迁前核对真实 API/账户/价格/协议和支付状态，重新运行产品测试并先本地预览。此项目运行成功不代表任何生产业务可用。

## 授权

导出源代码和自制几何 SVG 使用 MIT（见 LICENSE）。没有附带原产品照片；品牌名称/商标及第三方依赖保留各自权利，不因 MIT 而获得商标使用权。
