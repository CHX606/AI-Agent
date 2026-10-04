/** 模型设置里“可切换的模型”：解析用户填写的列表，过滤服务商返回的非对话模型。 */

const MODEL_NAME = /^[\w.:/@+-]{1,200}$/u;
const MAX_MODELS = 50;
// 服务商的 /models 会把向量、语音、图片等模型一起列出来，它们不能用来跑 Agent。
const NOT_CHAT = /(embed|tts|whisper|dall-e|davinci|babbage|moderation|transcribe|realtime|audio|image|similarity|search-preview)/iu;

/** 逗号、空格或换行分隔的模型名；去掉重复和不合法的名字，最多 50 个。 */
export function parseModelList(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,，]+/u) : [];
  const seen = new Set<string>();
  for (const part of parts) {
    const name = typeof part === "string" ? part.trim() : "";
    if (MODEL_NAME.test(name)) seen.add(name);
    if (seen.size >= MAX_MODELS) break;
  }
  return [...seen];
}

/** 服务商返回的模型里，只留可以对话的，按名字排序。 */
export function chatModels(ids: string[]): string[] {
  return parseModelList(ids.filter((id) => !NOT_CHAT.test(id)).sort((a, b) => a.localeCompare(b)));
}
