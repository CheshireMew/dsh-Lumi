# @dsh-lumi/bundle-desktop

[English](README.md) | 中文

这是叠加在官方 `@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-web-app` 组合包之后的产品层。它的 patch 只插入 `@dsh-lumi/client-character` 与 `@dsh-lumi/client-shell`，因此同步上游时可以完整审查产品配置项的差异。

## 模型体验

无，因为该组合包只增加界面表现、浏览器语音、本地角色设置和本地好感度，不会增加系统提示词段、工具、会话事件或其它模型可见内容。

#### KV Cache 影响

无；该组合包不会改变模型请求。

## 已知限制与待办事项

- 该组合包要求先应用两个官方组合包，不能单独作为 Harness profile 使用。
- 角色行为只存在于浏览器端，因此 headless 和 ACP 界面无法使用。
