# DataFoundry 本机启动说明

验证日期：2026-09-16。项目版本：0.2.0。环境：原生 Windows、Node.js 24.16.0、npm 11.13.0。

## 访问与账户

- Web：http://127.0.0.1:3000/login
- 工作台：http://127.0.0.1:3000/data-tasks
- API 存活：http://127.0.0.1:8787/healthz
- API 就绪：http://127.0.0.1:8787/ready

已创建并验证本机演示账户 `local-demo@example.test`。随机密码保存在 `storage/local-runtime/demo-account.json`，请在本机打开该文件查看。也可在登录页自行注册。当前为本机测试认证模式，不发送真实邮件。

演示账户内保留了成功的“DTC订单总数查询”会话，结果为 32。服务默认模型继续使用原 `.env` 中已有的模型和凭据。

## 启动 停止 状态

在 PowerShell 中进入项目目录后执行：

```powershell
Set-Location 'D:\workspace\datafoundry-main'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/local-service.ps1 start
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/local-service.ps1 status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/local-service.ps1 stop
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/local-service.ps1 logs
```

`start` 创建隐藏后台进程，关闭终端不影响服务；系统重启后需再次启动，未配置开机自启。脚本只管理自身启动且路径匹配的进程树。当前脚本按 3000/8787 端口配置；修改端口时同步修改脚本、根 `.env` 的端口及认证地址和 Web 代理地址。

## 安装与构建

项目 `.npmrc` 已设置 `registry=https://registry.npmmirror.com`，并保留原有 `legacy-peer-deps=true` 和 `engine-strict=true`。不会修改机器的全局 npm 源。

```powershell
npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
npm run build
npm run build:web
```

`npm install` 的 postinstall 已执行 TypeScript 构建并生成内置样例。Python 数据分析依赖安装在项目 `.venv` 中，安装源为 `https://pypi.tuna.tsinghua.edu.cn/simple`。

## 本次调整

1. 生成随机 `AUTH_SESSION_SECRET` 与 `SECRET_MASTER_KEY`，替换示例值。原 `.env` 在修改前已备份，现有模型 Key 保持不变。
2. 新建 `apps/web/.env.local`，使用同源 API 代理与 Cookie/CSRF 认证。
3. 修正原 `LLM_BASE_URL` 末尾的 `/chat/completions`，使其指向 API 基础路径，避免重复拼接接口。
4. 修正 `scripts/stack-runner.mjs`：把配置的 host/port 显式传入 Next.js，当前 Web 和 API 均只监听 `127.0.0.1`。
5. 新增 `scripts/local-service.ps1` 管理后台服务；`scripts/setup-local-windows.mjs` 补齐本地配置；`scripts/verify-local.mjs` 验证本地认证与模型问数。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| npm 安装与 TypeScript 构建 | 通过，安装 1462 个依赖包 |
| Next.js 正式构建 | 通过，生成工作台、登录、注册与代理路由 |
| API `/healthz`、`/ready`，Web `/login` | HTTP 200 |
| 注册、邮箱验证、登录、同源 BFF | 通过，本地测试模式，无真实邮件 |
| `npm run smoke:sql` | 通过，阻止 8 类写入/不安全查询，生成 12 条审计记录 |
| `npm run smoke:data-gateway` | 通过，SQLite、DuckDB、CSV、Excel 和 ClickHouse fixture 路径 |
| `node --test scripts/stack-runtime-config.test.mjs` | 4 项通过 |
| 真实模型分析 | schema 检查后执行 `SELECT COUNT(*) AS order_count FROM orders`，结果 32，RUN_FINISHED，无 RUN_ERROR |
| Playwright 浏览器检查 | 登录页与工作台正常；可查看成功会话的 SQL 和结果 |

浏览器首次未登录探测会返回 401，未持久化的新会话探测可能返回 404；上游另有 favicon 404，这些没有阻断已验证的登录和问数流程。本次没有修改这些上游界面行为。

## 文件与边界

- 日志：`storage/local-runtime/stdout.log`、`stderr.log`。
- 模型问数事件：`storage/local-runtime/verification-events.txt`。
- 本地演示账户：`storage/local-runtime/demo-account.json`。浏览器测试状态在同目录，均只供本机使用，不应提交或分享。
- 实际 Web/API 启动采用 npm prefix 子目录工作方式，主要工作台数据位于 `apps/api/storage`；根 `storage` 还保存 fixture、测试与运行记录。备份时保留实际数据目录及原加密主密钥，不要重置密钥。
- Windows 原生命令沙箱不可用，项目会禁用 Agent `execute_command`；即使 `.venv` 安装成功，Agent 也不能据此运行 Python。需要脚本/机器学习分析时，在 Linux 隔离运行环境重新安装和验证，不能共用 Windows 的 node_modules。
- DataLink 是独立可选组件，本次没有部署。ERP/OA、Kafka/Flink/Doris 和企业本体语义层只形成设计方案，未接入或部署。
- 当前仅完成本机演示部署，尚未进行企业真实数据、完整报表产出、多用户权限及生产容量验收。

模型问数复验会使用现有模型配额，只需验证配置时可运行 `node scripts/verify-local.mjs`；明确需要再次调用模型时运行 `node scripts/verify-local.mjs --run`。
