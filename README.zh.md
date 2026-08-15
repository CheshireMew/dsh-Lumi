# Lumi

[English](README.md) | 中文

Lumi 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建的 Windows 桌面体验。它在保留 Harness 会话、插件、设置与工具体系的基础上，增加了常驻角色、场景／工作布局、本地角色包、语音和默契度成长。

这层扩展保持增量组合：Lumi 通过插件叠加在官方 Web 应用之上，Electron 负责桌面窗口、本地进程生命周期、诊断、Windows 签名交付和更新检查。底层仍遵循**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动。

## 开发者预览

Lumi 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

## 运行

### 从源码运行

安装 Node 22.23.2，通过 Corepack 启用仓库固定的 pnpm，然后从源码运行：

```sh
git clone https://github.com/CheshireMew/dsh-Lumi.git
cd dsh-Lumi
corepack enable
pnpm install
pnpm run dev:lumi
```

Lumi 会先构建完整的 Harness 与 Lumi 应用，再打开 Electron 窗口。已有会话、设置、凭据、插件、角色包和日志继续存放在普通 `$DSH_HOME` 下。详见 [Lumi 桌面版指南](docs/user/guide/lumi-desktop.md)。

Windows 签名安装程序通过受保护且标签完全匹配的发布工作流进入草稿 Release，要求 Windows 代码签名凭据并由操作者审核；普通分支构建不会静默公开发布。

## 运行 Harness Web UI

同一份源码仍可直接启动未修改的 Harness Web 入口：

```sh
pnpm run build
pnpm dsh web
```

## 社区与支持

- 欢迎通过[本仓库的 Issues](https://github.com/CheshireMew/dsh-Lumi/issues)提交 Lumi 反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="assets/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="assets/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="assets/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发

请先阅读[开发指南](docs/development.md)与[架构文档](docs/architecture.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
