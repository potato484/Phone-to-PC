# 《MVP 到 PMF 的落地路线图》（Computer-to-Phone / C2P）

**文档版本：** v1.0  
**制定日期：** 2026-02-16  
**目标：** 回答“如何让用户从试用一次变为长期依赖”，并给出 V1.5 → V3.0 的可执行落地路径。  

> 事实基线（来自仓库现状）：当前 C2P 已完成 POC→MVP 的安全/持久化/可观测性闭环，能力形态为 **PWA（手机浏览器）远程控制本机终端、桌面（noVNC/VNC）、文件**，并支持 Tailscale / Cloudflare Tunnel 穿透（见 `README.md`、`src/server.ts`、`src/ws/*`、`src/tunnel.ts`、`src/vnc-manager.ts`）。

---

## 0. 一句话战略（把“好用”做成“依赖”）

把 C2P 从“我偶尔能连上”升级为“我每周都用它完成关键任务”，核心抓手是：

1) **可靠性与确定性**：无论网络怎么抖、Wi‑Fi↔蜂窝怎么切，都能在可预期时间内恢复会话，并给出明确状态。  
2) **低摩擦高频场景**：围绕“移动端即时处理（on‑call / 支持 / 多机管理）”打造一组能反复复用的工作流与插件。  
3) **安全与合规底座**：在进入团队/商业场景前，把 E2EE、无感授权、隐私屏、审计/回放做到可审计、可解释、可配置。  

---

## 1. PMF 核心量化指标（The PMF North Star）

### 1.1 Magic Moment（魔法瞬间）

用户在外出/通勤/临时会议中，**掏出手机 → 3 秒内连上自己的电脑 → 恢复上次会话（终端/桌面）→ 60 秒内完成一个“关键动作”**（例如重启服务、修配置、取文件、处理告警），并且全程不需要“想起密码/找链接/调 VPN/重新开会话”。

> 让用户长期依赖的不是“能连”，而是“**我确信它会在我需要时工作**”。

### 1.2 北极星指标（North Star）

**WDS（Weekly Dependable Sessions，每周可依赖会话数）**  
定义：每周每用户完成 ≥1 次 **“连接→鉴权→执行关键动作→正常退出”** 的会话，且该会话满足质量门槛（见 1.3）。  

为什么选它：把增长（使用频次）和技术体验（质量门槛）绑定，避免“活跃但很糟”的虚假繁荣。

配套指标（用于拆解 WDS）：
- **TTFV（Time To First Value）**：首次扫码/配对到“看到终端提示符/可点击桌面” ≤ 60s（p95）。  
- **SR（Session Reliability）**：会话成功率 ≥ 99.5%（不含用户主动取消）。  
- **RRS（Reconnect Recovery Speed）**：断线重连恢复可操作 ≤ 2s（p95，MVP 已有目标），且支持“网络切换恢复”。  

### 1.3 进入 PMF 阶段的技术与增长指标

#### 指标口径（避免各说各话）

- **RTT（Round Trip Time）**：网络往返时延（客户端↔服务端/Region）。  
- **Key‑to‑Echo**：用户按键到远端回显的端到端耗时（含网络、服务端处理、渲染）。  
- **Motion‑to‑Photon**：用户输入（触控/鼠标/键盘）到屏幕像素变化的端到端耗时（最接近“体感延迟”）。  
- **PnP**：这里作为“端到端画质”的总称，建议用 **分辨率/码率/丢帧/冻结** 做线上代理指标，用 **SSIM/VMAF** 做离线回放评估与校准。  

#### A) 性能（Performance）

> 参考行业基准口径：  
> - AWS WorkSpaces：PCoIP 推荐 RTT < 100ms；DCV 推荐 RTT < 250ms（官方文档）。  
> - Azure Virtual Desktop：推荐 RTT < 150ms（官方文档）。  
> - AnyDesk：宣称 LAN 60fps、<16ms 编解码级延迟、100kb/s 可用（官方性能页，用作“体验上限”对标）。  

**延迟（Latency）**
- **终端按键→回显（Key‑to‑Echo）**：LAN p95 < 80ms；WAN p95 < 150ms。  
- **桌面输入→屏幕变化（Motion‑to‑Photon）**：  
  - V1.5（VNC 路径）WAN p95 < 220ms（“能用且不痛苦”）。  
  - V2.0+（WebRTC 路径）WAN p95 < 120ms（“接近本地”）。  
- **冷启动到可交互（Cold Start to Interactive）**：p95 < 6s；热启动 p95 < 3s。  

**画质（PnP/FPS）**
- **目标帧率**：好网 60fps（桌面操作），弱网保 30fps（优先稳定，不追峰值）。  
- **帧率稳定性**：桌面会话中 **p95 FPS ≥ 50（好网）/ ≥ 28（弱网）**；关键交互（拖拽/滚动）不出现 >500ms 的冻结（p95）。  
- **自适应质量阶梯（示例）**：360p30（0.3–0.7Mbps）→ 720p30（1–2Mbps）→ 1080p60（6–12Mbps），按 RTT/丢包/缓冲自动升降。  

**电量（Energy）**
- **单位时间耗电**：以“720p30 远控 30 分钟”为基准，目标在主流中端安卓机上 **耗电 ≤ 6%**（Wi‑Fi），蜂窝网络 **≤ 8%**（作为初始目标，需用真实机型基线校准）；并把“省电模式”作为一键策略（降帧/降分辨率/关闭高耗能特性）。  
- **可量化方法**：Android Battery Historian / Perfetto + iOS Instruments Energy Log；把“能耗/温升/CPU/GPU”写入版本验收表。  

#### B) 留存（Retention）

**40% 失望度测试（Sean Ellis Test）**
- 问题：*“如果这个产品明天消失，你会有多失望？”*  
- PMF 门槛：**≥ 40%** 的受访者选择“非常失望（Very disappointed）”。  
- 口径建议：只对 **过去 14 天内完成 ≥2 次 WDS 的核心用户** 发起调查，避免把“路过用户”混进样本稀释结论。  

**WAU Retention（周活跃留存）**
- 定义：某周激活用户在后续第 N 周仍为 WAU 的比例。  
- 目标（整体）：W4 ≥ 35%，W8 ≥ 25%。  
- 目标（核心场景人群：on‑call / 支持 / 多机管理）：W8 ≥ 40%。  

---

## 2. 核心体验升级（从“可用”到“好用”）

### 2.1 技术自适应（复杂网络 / NAT / 切网）

**现状与瓶颈**
- 终端/控制/桌面主要基于 WebSocket（TCP），桌面为 VNC 代理（RFB）链路，弱网下容易受到 TCP Head‑of‑Line Blocking 影响。  
- 穿透主要依赖 Tailscale / Cloudflare Tunnel：对开发者友好，但对大众用户仍偏“工具链”。  

**V1.5：把现有链路做到极致（低成本增益）**
- **连接质量评分（CQS）**：在客户端显示 RTT/抖动/丢包/缓冲，并驱动自动降级策略（例如降色深、降帧、降分辨率、暂停后台渲染）。  
- **弱网保护**：对桌面通道引入“可丢帧”的策略（缓冲过高时丢弃旧帧/旧矩形更新），避免越积越卡。  
- **切网恢复**：统一把“Wi‑Fi↔蜂窝切换”视为一类故障，提供“恢复中/已恢复/需要重新鉴权”的显式状态机（而非静默失败）。  

**V2.0：引入现代实时传输（WebRTC / UDP）**
- **桌面从 VNC → WebRTC 视频流**：媒体用 SRTP/UDP，输入走 DataChannel，显著降低弱网卡顿（行业从“指令流/位图更新”向“视频流”演进的主路径）。  
- **NAT 穿透与回退**：ICE（STUN/TURN）P2P 优先，失败回退中继；参考 RustDesk 的 hbbs/hbbr“直连优先 + 中继兜底”模型。  
- **网络切换**：ICE restart + 快速重协商；并保留 VNC 作为兼容回退通道（尤其是早期 WebRTC Beta）。  

**V2.5+：面向移动网络的“持续会话”**
- 对标 AVD 的 RDP Shortpath 思路：**优先 UDP 直连，失败再回 TCP**；在公网链路里用 STUN/TURN 建立“最短路径”，降低 RTT 与抖动（微软官方文档给了清晰的机制与收益描述）。  
- 评估 **WebTransport（QUIC/HTTP3）** 用于控制面（高频状态同步、可迁移连接），作为 WebSocket 的长期替代方向（W3C WebTransport explainer 将 remote desktop/cloud gaming 列为典型用例）。  

### 2.2 交互打磨（触控模拟 / 键盘映射）

**触控模拟（移动端 → 桌面）**
- 保留默认触控滑动：点按=左键，长按=右键，双指缩放与横向滚动保持可用。  
- 单指上下滑动优先页面滚动，避免横向手势误判导致的滚动中断。  
- 增加“手势助手”与灵敏度校准；为文本编辑/选择提供专门手势（长按选词、拖拽光标、快捷复制粘贴）。  
- 参考 RustDesk Web Client V2 强化项：持续增强剪贴板（文本+图片）与文件传输能力，缩小“Web 版 vs 客户端版”的体验差距。  

> 注：本仓库的主链路是“手机→电脑”。如果未来扩展到“电脑→手机（远程控制移动设备）”，建议复用同一套**输入抽象层**（手势→操作语义→注入），以避免两套交互体系割裂。

**键盘映射（Shortcut Mapping）**
- 把“快捷键条”作为一等公民：Ctrl/Alt/Shift/Meta、Esc/Tab、方向键、F1‑F12、常用组合一键触发。  
- 文本输入与快捷键注入分离：文本直接走系统输入，组合键统一由快捷键条注入，避免互相干扰。  
- 允许用户保存 **工作流级键位方案**（例如：Vim/IDE/终端/支持场景不同布局）。  

### 2.3 安全底座（E2EE / 无感授权 / 隐私屏）

**E2EE（端到端加密）**
- 当产品从“自托管单机”走向“云信令/中转”时，E2EE 是把“平台可见内容”降到最低的关键（对标 TeamViewer 的端到端加密叙事：RSA‑4096 + AES‑256 的会话加密组合，官方安全声明可查）。  
- 落地建议（分层）：  
  - **V1.5**：把“加密边界”说明清楚（隧道层/HTTPS/TLS），并对日志/审计/密钥管理给出默认安全配置。  
  - **V2.0+**：在 WebRTC 路径上引入 **Insertable Streams（可用则启）** 或应用层密钥封装，确保中继节点无法解密媒体与输入。  

**无感授权（Seamless Auth）**
- 设备绑定 + Trusted Device：新设备登录需要二次确认（参考 TeamViewer“Trusted Devices”机制）。  
- “一次性会话码 + 手机推送确认”作为支持场景的默认路径，避免长期共享口令。  

**隐私屏（Privacy Screen）**
- 支持“遮罩/黑屏/锁输入”模式，满足远程支持与办公隐私需求（TeamViewer 安全声明里明确提到 privacy screen 和“无隐身模式”设计理念）。  
- 审计与可见性：本地必须有“正在被远控”的显式提示，避免合规风险。  

---

## 3. 场景化深度演进（找准切入点）

> 原则：先把一个高频场景做到“离不开”，再扩展到更多场景；避免早期做成“功能拼盘”。  

### 场景 A：开发者/运维 On‑call（移动端应急处理）

**用户动机**：随时恢复终端会话、查看状态、执行 runbook；“不想掏电脑”。  
**关键功能包（插件化交付）**
- **Runbook 宏指令**：录制/模板化（带参数、带确认、可回滚），一键执行并生成审计记录。  
- **告警→一键处置**：监控阈值触发 Web Push，点击直达对应会话/脚本。  
- **安全护栏**：危险命令二次确认、最小权限 scope、临时授权。  

### 场景 B：远程技术支持（家庭/小团队）

**用户动机**：快速帮人解决问题，低学习成本，明确的授权与隐私保护。  
**关键功能包**
- **Support 模式**：临时会话码、可视化授权、隐私屏、文件传输/取日志一键化。  
- **AI 会话总结**：对标 TeamViewer Intelligence/CoPilot 的方向：自动生成“做了什么、改了什么、下一步建议”（先从规则化事件总结开始，再引入 LLM）。  
- **协作能力**：邀请旁观者、会话注释、会话回放（企业场景增购点）。  

### 场景 C：多机管理/私域运营（多电脑/服务器批量运维）

**用户动机**：一部手机管理多台机器，状态可视化，批量操作减少人力。  
**关键功能包**
- **设备目录与分组**：标签/分组/策略（权限、可见性、功能开关）。  
- **批量动作**：批量推送脚本、批量拉日志/文件、计划任务。  
- **连接质量与成本**：对“中继流量”计量与优化；RustDesk 官方文档给出 1080p 中继流量大致区间（30KB/s–3MB/s），可作为成本模型参考。  

---

## 4. 基础设施与规模化（万级并发的全球信令/中转）

### 4.1 从单机到平台：控制面与数据面拆分

**当前（MVP）**：控制面=被控机上的 Node 服务；数据面=WS/VNC/PTY 同机处理。  
**面向万级并发的目标形态（V2.0+）**
- **Host Agent（被控端常驻）**：与云端建立出站连接（避免用户配置端口/隧道），负责采集、编解码、权限执行。  
- **Control Plane（云控制面）**：设备注册、会话编排、鉴权、审计、推送、策略。  
- **Data Plane（数据面）**：P2P 优先；失败时进入 **区域化 Relay/TURN**（就近中转降低 RTT）。  

### 4.2 全球节点部署（信令/中转）

- **信令**：无状态 WebSocket/WebTransport 网关 + Redis/NATS 做状态与广播；多地域部署 + 全局流量调度（GeoDNS/Anycast）。  
- **中转**：  
  - WebRTC：STUN/TURN（coturn）多区域部署，按 Region 就近分配。  
  - 传统转发：保留 TCP relay（兼容极端网络），但作为兜底。  
- **成本策略**：强制“P2P 优先、Relay 计量、质量自适应”，把中继带宽从“默认路径”变成“异常兜底”。  

### 4.3 自动化运维与故障自愈

- **SLO/告警**：按“连接成功率、会话恢复耗时、端到端延迟、Relay 使用率、成本/GB”建立 SLO。  
- **自愈**：节点健康探测 → 自动摘除；会话编排侧支持快速重路由；客户端支持无感重连与降级策略。  
- **可观测性**：指标（Prometheus）、日志（结构化 + 审计分流）、链路追踪（OpenTelemetry），并把“连接质量数据”纳入产品反馈闭环。  

---

## 5. 落地时间轴（V1.5 → V3.0）

> 版本不是时间，而是“可验证的能力包”。每个版本都必须绑定可量化验收指标（见第 1 章）。

### V1.5（深度打磨期）：把“可用”磨成“稳定好用”

**目标**：让用户在真实 WAN/切网场景下仍然愿意反复使用。  
**交付清单**
- 连接质量评分（CQS）+ 自动降级（桌面/终端分开策略）。  
- 触控/键盘体验升级：默认触控滑动 + 快捷键条。  
- 桌面链路调优（VNC 路径）：可丢帧、质量阶梯、弱网策略；把“卡”变成“降清晰但可操作”。  
- PMF 数据准备：隐私友好的埋点（可选开关）+ 失望度测试问卷投放机制。  

**验收**
- WAN 环境 WDS 达标用户占比显著提升；断线重连 p95 ≤ 2s（含切网场景）。  
- 桌面会话“冻结 >500ms”事件显著下降（p95）。  

### V2.0（功能破圈期）：差异化能力 + 现代化传输

**目标**：用“Web 形态做出客户端级体验”，并形成场景化的可复用工作流。  
**交付清单**
- WebRTC 桌面 Beta：H.264/VP9 起步，逐步引入 AV1（可选），输入走 DataChannel。  
- NAT 穿透：ICE（STUN/TURN）+ 直连优先 + 中继兜底（区域化部署）。  
- 插件体系（最小可行）：Runbook 宏指令、文件双向同步（断点续传/增量）、Support 模式。  
- AI 辅助（先规则后模型）：会话摘要、操作回放索引、基于日志/事件的建议（对标 TeamViewer Intelligence/CoPilot 的“工作流内 AI”方向）。  

**AV1 引入策略（V2.0+ 建议）**
- **先解码后编码**：优先利用移动端硬件解码能力（可用则用 AV1），编码侧先从 H.264/VP9 稳定起步，再逐步引入 AV1（避免“编码慢导致延迟上升”）。  
- **Screen content 优先**：远程桌面以“屏幕内容”为主，优先评估 AV1 的 screen content coding 相关收益；并结合 SVC（参见 W3C `webrtc-svc`）做“多档质量层”以降低弱网抖动。  
- **能力探测与回退**：按浏览器/芯片能力探测，明确回退链（AV1 → VP9 → H.264），并把回退原因写入连接质量数据，形成闭环。  

**验收**
- WebRTC 路径下 Motion‑to‑Photon WAN p95 < 120ms（核心机型/浏览器矩阵）。  
- “宏指令/同步/支持模式”至少有 1 个场景形成 >40% 的 WAU 使用占比。  

### V3.0（PMF 验证期）：反馈闭环 + 小规模商业化验证

**目标**：用数据证明 PMF，并验证可持续的商业闭环。  
**交付清单**
- 安全增强：E2EE（云中继不可解密）、Passkeys/设备信任、隐私屏与权限策略体系。  
- 平台化：控制面多租户/多地域；万级并发压测（信令、TURN、回源）。  
- 商业化试点：Hosted Relay（按流量/席位）、团队策略/审计/回放、AI 增值包。  
- PMF 实验：失望度测试（≥40%）、WAU 留存达标、细分人群验证与渠道策略沉淀。  

**验收**
- Sean Ellis Test ≥ 40%（核心人群）；W8 Retention ≥ 25%（整体）/ ≥ 40%（核心人群）。  
- Relay 成本可控：P2P 占比与质量策略达到预设阈值（按业务模型设定）。  

---

## 6. 附录：与当前代码的映射（便于直接开工）

- **连接质量评分（CQS）**：客户端采集与展示可落在 `public/lib/control.js`、`public/lib/ui.js`；RTT/心跳基线在 `src/ws/heartbeat.ts`；服务端缓冲与连接数指标在 `src/metrics.ts`、`src/ws/*.ts`。  
- **桌面弱网策略（VNC 路径）**：桌面通道在 `src/ws/desktop.ts`（已有 backpressure 水位）；VNC 后端探活/自启在 `src/vnc-manager.ts`（可扩展编码/色深/参数策略）；noVNC 配置在 `public` 侧接入。  
- **触控/手势与键盘映射**：触控与手势在 `public/lib/gestures.js`；快捷键序列与键位常量在 `public/lib/state.js`；终端体验在 `public/lib/term.js`。  
- **会话工作流（Runbook/宏）**：会话生命周期与能力协商在 `src/ws/control.ts`；终端 attach/恢复在 `src/pty-manager.ts` 与 `src/ws/terminal.ts`。  
- **Push 与“告警→处置”闭环**：服务端 push 在 `src/push.ts`；PWA Service Worker 在 `public/sw.js`。  
- **鉴权/设备信任/审计**：token 与吊销在 `src/auth.ts`；WS 首帧鉴权在 `src/ws/auth-gate.ts`；审计日志在 `src/audit-log.ts`；安全策略与限流在 `src/security.ts`。  
- **穿透与可达性**：隧道策略与启动在 `src/tunnel.ts`（Tailscale/Cloudflare/Quick Tunnel）。  

## 参考资料（外部证据与趋势）

- AWS WorkSpaces 网络要求（RTT 阈值）：https://docs.aws.amazon.com/workspaces/latest/adminguide/workspaces-network-requirements.html  
- Azure Virtual Desktop 前置条件（RTT <150ms）：https://learn.microsoft.com/en-us/azure/virtual-desktop/prerequisites  
- AnyDesk 性能页（60fps、<16ms、100kb/s）：https://anydesk.com/en/performance  
- TeamViewer 安全声明（RSA‑4096 + AES‑256、Privacy Screen、Trusted Devices）：https://www.teamviewer.com/en-us/global/support/knowledge-base/teamviewer-remote/security/security-statement  
- TeamViewer Intelligence / CoPilot（AI 工作流内化）：https://www.teamviewer.com/en-us/global/company/press/2025/teamviewer-expands-ai-portfolio-with-teamviewer-intelligence-for-it-support-workflows  
- RustDesk Web Client V2（键盘/剪贴板/文件传输）：https://rustdesk.com/blog/2024/10/rustdesk-web-client-v2-preview  
- RustDesk Server OSS 安装与中继流量量级（成本参考）：https://rustdesk.com/docs/en/self-host/rustdesk-server-oss/install/  
- RDP Shortpath（UDP + STUN/TURN + URCP，作为“移动弱网优化”的思路参照）：https://learn.microsoft.com/en-us/azure/virtual-desktop/rdp-shortpath  
- WebTransport explainer（QUIC/低延迟/remote desktop 用例）：https://github.com/w3c/webtransport/blob/main/explainer.md  
- WebCodecs（低延迟编解码/能效）：https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API  
- WebRTC SVC 扩展（AV1/VP9 等可扩展编码参数）：https://www.w3.org/TR/webrtc-svc/  
