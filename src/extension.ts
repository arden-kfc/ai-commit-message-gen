import * as vscode from 'vscode';

const SECTION = 'deepseekCommit';
const API_KEY_SECRET = 'deepseekCommit.apiKey';

// ---------------------------------------------------------------------------
// Git 扩展类型声明（vscode.git 提供的公开 API 子集）
// ---------------------------------------------------------------------------
interface GitExtension {
  getAPI(version: number): GitAPI;
}

interface GitAPI {
  repositories: Repository[];
}

interface Repository {
  readonly rootUri: vscode.Uri;
  readonly state: RepositoryState;
  diff(cached?: boolean): Promise<string>;
  inputBox: { value: string };
}

interface RepositoryState {
  HEAD: { name?: string; commit?: string } | undefined;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
  error?: {
    message?: string;
    type?: string;
  };
}

// ---------------------------------------------------------------------------
// 配置辅助
// ---------------------------------------------------------------------------
interface ExtensionConfig {
  systemPrompt: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  maxDiffLength: number;
  autoFillInput: boolean;
  requestTimeout: number;
}

function getConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    systemPrompt: cfg.get<string>('systemPrompt', ''),
    baseUrl: cfg.get<string>('baseUrl', 'https://api.deepseek.com'),
    model: cfg.get<string>('model', 'deepseek-v4-flash'),
    temperature: cfg.get<number>('temperature', 0.3),
    maxTokens: cfg.get<number>('maxTokens', 1000),
    maxDiffLength: cfg.get<number>('maxDiffLength', 8000),
    autoFillInput: cfg.get<boolean>('autoFillInput', true),
    requestTimeout: cfg.get<number>('requestTimeout', 60000),
  };
}

async function getGitAPI(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) {
    return undefined;
  }
  if (!ext.isActive) {
    // 激活 git 扩展，保证能拿到仓库列表
    await ext.activate();
  }
  return ext.exports?.getAPI(1);
}

function getActiveRepository(api: GitAPI | undefined): Repository | undefined {
  return api?.repositories?.[0];
}

// ---------------------------------------------------------------------------
// 主命令：生成 Commit Message
// ---------------------------------------------------------------------------
async function generateCommitMessage(context: vscode.ExtensionContext): Promise<void> {
  const apiKey = await context.secrets.get(API_KEY_SECRET);
  if (!apiKey) {
    const action = await vscode.window.showWarningMessage(
      '尚未配置 DeepSeek API Key，是否现在设置？',
      '设置 API Key',
    );
    if (action === '设置 API Key') {
      await setApiKey(context);
      return;
    }
    return;
  }

  const repo = getActiveRepository(await getGitAPI());
  if (!repo) {
    vscode.window.showErrorMessage('未找到 Git 仓库，请先在 VS Code 中打开一个包含 Git 仓库的文件夹。');
    return;
  }

  const diff = await collectDiff(repo);
  if (!diff) {
    vscode.window.showWarningMessage('当前没有可用的变更内容（请先暂存或修改文件）。');
    return;
  }

  const config = getConfig();
  const branch = repo.state.HEAD?.name ?? '';
  const systemPrompt = renderTemplate(config.systemPrompt, branch);

  let message: string;
  try {
    message = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '正在通过 DeepSeek 生成 Commit Message…',
        cancellable: false,
      },
      async () => requestCommitMessage(apiKey, config, systemPrompt, diff),
    );
  } catch (err) {
    showApiError(err);
    return;
  }

  if (config.autoFillInput) {
    repo.inputBox.value = message;
  } else {
    await vscode.env.clipboard.writeText(message);
  }
}

// ---------------------------------------------------------------------------
// 收集 diff：优先已暂存（staged），否则回退到未暂存（working tree）
// ---------------------------------------------------------------------------
async function collectDiff(repo: Repository): Promise<string> {
  const config = getConfig();

  let diff = await safeDiff(repo, true);
  if (!diff.trim()) {
    diff = await safeDiff(repo, false);
  }

  diff = diff.trim();
  if (!diff) {
    return '';
  }

  if (diff.length > config.maxDiffLength) {
    const truncated = diff.slice(0, config.maxDiffLength);
    diff = `${truncated}\n\n...(diff 过长已截断，剩余 ${diff.length - config.maxDiffLength} 字符未展示)`;
  }
  return diff;
}

async function safeDiff(repo: Repository, cached: boolean): Promise<string> {
  try {
    return await repo.diff(cached);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 调用 DeepSeek Chat Completions
// ---------------------------------------------------------------------------
async function requestCommitMessage(
  apiKey: string,
  config: ExtensionConfig,
  systemPrompt: string,
  diff: string,
): Promise<string> {
  const url = buildChatUrl(config.baseUrl);
  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `请根据以下 git diff 生成一条 Commit Message：\n\n<diff>\n${diff}\n</diff>`,
      },
    ],
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeout);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(
      `无法连接到 DeepSeek API：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  clearTimeout(timer);

  const rawText = await response.text();
  let data: ChatCompletionResponse;
  try {
    data = JSON.parse(rawText) as ChatCompletionResponse;
  } catch {
    throw new Error(`DeepSeek 返回了非 JSON 响应（HTTP ${response.status}）：${rawText.slice(0, 300)}`);
  }

  if (!response.ok) {
    const message = data.error?.message || rawText || `HTTP ${response.status}`;
    throw new Error(`DeepSeek API 请求失败（HTTP ${response.status}）：${message}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('DeepSeek 响应中没有生成内容，请检查模型名称与 API Key 是否有效。');
  }

  return cleanCommitMessage(content);
}

function buildChatUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) {
    return base;
  }
  return `${base}/chat/completions`;
}

// 去掉模型可能返回的 Markdown 代码块与多余空白
function cleanCommitMessage(content: string): string {
  let text = content.trim();
  const fence = text.match(/^```(?:[a-zA-Z0-9_-]*)\s*([\s\S]*?)\s*```$/);
  if (fence) {
    text = fence[1].trim();
  }
  return text.replace(/\r\n/g, '\n');
}

// 支持在系统提示词中使用 {branch} 占位符
function renderTemplate(template: string, branch: string): string {
  return template.replaceAll('{branch}', branch);
}

// ---------------------------------------------------------------------------
// 命令：设置 API Key / 系统提示词 / 测试连接
// ---------------------------------------------------------------------------
async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const current = await context.secrets.get(API_KEY_SECRET);
  const value = await vscode.window.showInputBox({
    title: '设置 DeepSeek API Key',
    prompt: '请输入 DeepSeek API Key（将安全存储在 VS Code SecretStorage 中）',
    password: true,
    ignoreFocusOut: true,
    value: current ?? '',
    placeHolder: 'sk-...',
  });
  if (value === undefined) {
    return; // 用户取消
  }
  const trimmed = value.trim();
  if (!trimmed) {
    await context.secrets.delete(API_KEY_SECRET);
    return;
  }
  await context.secrets.store(API_KEY_SECRET, trimmed);
}

async function setSystemPrompt(): Promise<void> {
  const config = vscode.workspace.getConfiguration(SECTION);
  const current = config.get<string>('systemPrompt', '');
  const value = await vscode.window.showInputBox({
    title: '设置系统提示词',
    prompt: '请输入系统提示词（支持 {branch} 占位符）',
    ignoreFocusOut: true,
    value: current,
    valueSelection: current ? [current.length, current.length] as [number, number] : undefined,
    placeHolder: '你是资深软件工程师……',
  });
  if (value === undefined) {
    return;
  }
  await config.update('systemPrompt', value, vscode.ConfigurationTarget.Global);
}

async function testConnection(context: vscode.ExtensionContext): Promise<void> {
  const apiKey = await context.secrets.get(API_KEY_SECRET);
  if (!apiKey) {
    const action = await vscode.window.showWarningMessage(
      '尚未配置 DeepSeek API Key，是否现在设置？',
      '设置 API Key',
    );
    if (action === '设置 API Key') {
      await setApiKey(context);
    }
    return;
  }

  const config = getConfig();
  const url = buildChatUrl(config.baseUrl);
  const body = {
    model: config.model,
    messages: [
      { role: 'user', content: 'ping' },
    ],
    max_tokens: 5,
    stream: false,
  };

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在测试 DeepSeek 连接…' },
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.requestTimeout);
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          clearTimeout(timer);

          const rawText = await response.text();
          if (!response.ok) {
            let message = rawText;
            try {
              const parsed = JSON.parse(rawText) as ChatCompletionResponse;
              message = parsed.error?.message || rawText;
            } catch {
              // 忽略解析失败，直接使用原始文本
            }
            throw new Error(`HTTP ${response.status}：${message}`);
          }
        } catch (err) {
          clearTimeout(timer);
          throw err;
        }
      },
    );
  } catch (err) {
    showApiError(err);
  }
}

function showApiError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  vscode.window.showErrorMessage(message);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(`${SECTION}.generate`, () =>
      generateCommitMessage(context),
    ),
    vscode.commands.registerCommand(`${SECTION}.setApiKey`, () => setApiKey(context)),
    vscode.commands.registerCommand(`${SECTION}.setSystemPrompt`, setSystemPrompt),
    vscode.commands.registerCommand(`${SECTION}.testConnection`, () =>
      testConnection(context),
    ),
  );
}

export function deactivate(): void {}
