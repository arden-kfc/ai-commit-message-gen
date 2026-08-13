# DeepSeek Commit Message

一个 VS Code 扩展：根据当前 Git 仓库的变更内容（diff），调用 DeepSeek 模型自动生成
Commit Message，并自动填入「源代码管理」面板的输入框。

## 功能

- 一键生成 Commit Message（默认遵循 @commitlint/config-conventional 校验规则）。
- 优先读取已暂存（staged）的变更，没有暂存内容时回退到未暂存（working tree）变更。
- 自动填入 SCM 输入框，并支持一键复制。
- 可自定义 API Key、系统提示词、模型、Base URL、温度等参数。
- 提供「测试连接」命令，方便排查网络 / Key 配置问题。

## 使用前准备

1. 准备一个 [DeepSeek API Key](https://platform.deepseek.com/)。
2. 在 VS Code 中打开一个 Git 仓库。

## 快速开始

1. 按 `Cmd+Shift+P`（Windows/Linux 为 `Ctrl+Shift+P`）打开命令面板。
2. 运行「DeepSeek: 设置 API Key」，粘贴你的 API Key（以密码形式输入，存入 VS Code
   的 SecretStorage，不会明文写入配置文件）。
3. （可选）运行「DeepSeek: 设置系统提示词」自定义生成风格。
4. 暂存你的改动（或直接保留未暂存改动），点击源代码管理面板顶部的 ✨ 按钮，或运行
   「DeepSeek: 生成 Commit Message」。
5. 生成结果会自动填入 Commit Message 输入框，也可以从弹出的通知里复制。

## 配置项

所有配置位于「设置」→ 搜索 `deepseekCommit`：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `deepseekCommit.systemPrompt` | 内置中文提示词 | 系统提示词，支持 `{branch}` 占位符 |
| `deepseekCommit.baseUrl` | `https://api.deepseek.com` | API 地址（OpenAI 兼容，可加 `/v1`） |
| `deepseekCommit.model` | `deepseek-v4-flash` | 模型名，默认 `deepseek-v4-flash` |
| `deepseekCommit.temperature` | `0.3` | 采样温度 |
| `deepseekCommit.maxTokens` | `1000` | 最大生成 token 数 |
| `deepseekCommit.maxDiffLength` | `8000` | 发送给模型的 diff 最大字符数 |
| `deepseekCommit.autoFillInput` | `true` | 是否自动填入 SCM 输入框 |
| `deepseekCommit.requestTimeout` | `60000` | 请求超时（毫秒） |

## 本地运行与调试

```bash
npm install
```

在 VS Code 中打开本目录，按 `F5` 启动「扩展开发宿主」，然后在打开的窗口中测试。

## 打包为 .vsix

```bash
npm install -g @vscode/vsce
vsce package
```

之后在 VS Code 中通过「扩展 → 从 VSIX 安装」即可安装。

## 安全说明

- API Key 通过 `vscode.SecretStorage` 安全存储，不会出现在 `settings.json` 中。
- 生成的 Commit Message 仅发送变更 diff 到 DeepSeek，请勿在敏感仓库中使用。
