# Agent Note: 统一 Node 22 与 Lumi 仓库治理

Status: implemented

[English](2026-08-15-node-22-lumi-repository-governance.md) | 中文

## 问题

继承而来的仓库继续宣传 Node 24 与后续偶数版本，但 Node 24 的重复工作进程崩溃已经让主要测试路径无法稳定复现。产品代码还位于标准根构建之外，npm 发布族把私有应用当成可发布成员，Pull Request 不要求原生 Lumi Windows 结果，fork 工作流则面向上游分支或依赖本仓库没有的上游 labels、Project、secrets 与 actor。因此，即使 Harness 上游门禁成功，也无法说明本仓库是否一致地构建、测试、发布甚至命名 Lumi。

## 决定

本说明取代 [Node engine 下限决定](2026-07-06-node-engine-floor.md)中的多运行时范围与 CI 矩阵。依赖下限的理由仍然有效，但仓库现在只支持 Node 22 LTS 版本线：`engines.node` 为 `^22.19.0`，开发环境和所有自有 CI 工作流统一使用精确的 Node `22.23.2`，`@types/node` 继续留在 22.x。Python 单文件可执行程序工作流也改用 `node22-*` 目标，内置运行时不能再与开发和 CI 静默分叉。Node 24 与 Node 26 不是兼容性通道；未来增加运行时必须基于新的实测决定，不能依靠开放式 engine 范围。

当前包、profile id、设置命名空间、路由、命令、文档、测试、工件和仓库元数据全部使用 Lumi。`main` 是产品分支，所有自有 push trigger 都面向它。官方 `upstream/master` 只保留为只读同步输入，因为它确实是上游仓库的分支；它绝不是 Lumi 的发布或 required check 目标。

根 `build` 包含 Host 库、客户端库、Web 应用和 Electron 桌面宿主。DSH npm 发布族从明确的包／应用根目录发现成员，但跳过每个 `private: true` manifest，使可安装桌面应用和它的 profile bundle 可以参与源码组合而不会被发送到 npm。原生 Windows CI job 运行完整 Lumi 兼容性与 Electron 路径，并进入聚合 required 结果。独立桌面发布工作流默认只验证配置，不打包；只有受保护且标签完全匹配的发布 job 拥有写权限。

`lumi-desktop` bundle 位于 Host 图中编译，因为它的 TypeScript 源码只有 profile 标记和不变量伴随插件。Lumi 包继续作为 `package.json` 中的运行时组合依赖存在，而不是该标记 project 的 Project Reference。`lumi-character` 改用显式 Host 与 Client 编译 leaf：Host leaf 拥有本地设置、角色包、路由和不变量，Client leaf 拥有 DOM 语音、浏览器状态与组件，bond、manifest、内置角色包和设置模块则作为完全相同的输入列入两边。编译面约束检查每个引用 project 自身声明的 face，拒绝 Host 进入 Client-only project，并要求拆分 project 使用匹配的 leaf。干净检出因此能够证明 Host-first 的生成声明顺序，而不是依靠陈旧 `lib/` 产物成功。

Windows 验收使用 PowerShell，不假设系统存在 Bash。随附的完整 preset、headless 示例、Code Mode 工作进程测试和 Loader 往返会把宿主原生 shell 作为完整的执行器／工具组合进行选择；明确采用 Bash 的 minimal preset 保持不变。源码启动的子进程会把 `file:` URL 传给 Node 的 `--import`，LSP 验收通过当前 Node 可执行程序调用语言服务器的 JavaScript 入口而不依赖平台专用 `.bin` 包装器，拥有子进程的测试也会先等待进程退出，再移除 Windows 工作目录。

Issue 自动化归本仓库所有。配置指向 `CheshireMew/dsh-Lumi`；标题、正文和 label 策略使用 repository token，组织 Project 字段是可选项，本仓库没有配置 Project 时保持禁用。没有工作流再请求不存在的上游 GitHub App actor 或 secret。若显式调用 Project 生命周期操作，它仍会大声失败，不会伪装成已经同步元数据。

根 README、双语 Lumi 指南、网站导航、包元数据、Issue 链接和发布配置全部指向当前仓库。GitHub 仓库仍是外部交付面：labels、分支规则、描述、topics、environments、签名 secrets、Release 资源和可见性都必须通过 GitHub 显式验证或变更，绝不根据本地文件推断。

## 验证

工作流契约测试断言 main 分支、精确 Node 22 运行时、原生 Lumi Windows job、发布权限、GitLab Python 载体目标和独立 Issue 策略。发布族测试证明私有桌面 manifest 不会进入 npm 成员。无密钥 Windows E2E 覆盖 preset 组合、Code Mode 前台／后台取消、持久化 Loader shell 往返、ACP 源码启动与拆除，以及真实 TypeScript 语言服务器。快照回放在 POSIX 宿主保留可移植的 Bash 记录，在 Windows 选择已提交的 PowerShell 覆盖与期望记录，让每个平台都验证生产组合实际暴露的工具，而不是把一种 shell 归一化成另一种。静态 Lumi 发布验证器在不生成安装程序的前提下检查版本身份、app id、产品名、图标、签名要求、更新签名校验、草稿提供方和精确标签。最终仓库审计会把这些源码结果与远端默认分支、元数据、labels、规则、工作流和 Release 证据配对。

Project Reference 编译面测试包含这条干净构建失败路径：Host aggregate 可以消费共享 project 与匹配的 Host leaf，但会在发布检出依赖尚不存在的客户端生成声明之前拒绝 Client-only 单配置目标。事件图生成器分别绑定彼此隔离的 Host 与 Client 语义 program，再合并两边的关系集合，因此修正编译图不会悄悄从公开文档中抹去 Client 派发方与监听方。

## 考虑过的替代方案

**继续以 Node 24 为主并降低 Vitest 并发。** 否决：已观察到的故障是 Node 24 CJS lexer 原生中止，不是仓库断言失败或普通资源超时。减少 worker 只能降低出现频率，不能把该运行时变成确定性的验收证据。

**宣传 Node 24，但开发使用 Node 22。** 否决：受支持的 engine 必须有仓库自有兼容性通道。宣传未经验证的运行时会重新制造本决定要消除的缺口。

**让 Lumi 继续作为 `build` 与 CI 之外的可选脚本。** 否决：标准仓库成功路径仍会漏掉用户实际收到的产品。

**发布 `apps/` 与 `packages/` 下发现的所有 workspace。** 否决：Electron 应用和只负责组合的私有 bundle 是交付工件，不是 npm 包；仅为满足通用发布循环而把它们设为公开，修改了错误层次。

**保留上游 Issue 自动化并禁用失败步骤。** 否决：静默跳过会在没有执行任何本地 Issue 状态约束时报告策略成功。独立仓库策略本身完整；不可用的 Project 元数据是明确缺失的可选能力。

## 后果

每条本机与自有自动化路径现在都对同一个运行时、分支、仓库和产品负责。标准构建与 CI 失败会包含 Lumi，npm 发布排除非 npm 工件，Issue 自动化可以使用普通仓库权限运行。取舍也很明确：Node 22 仍是受支持版本线时，源码不能使用 Node 24+ 特性；在仓库或另一发布提供方尚未向目标用户开放 Release 资源、受保护签名凭据尚不存在时，公共安装程序更新仍然无法完成。
