export class APIError extends Error {
  constructor(public status: number, public detail: unknown) {
    super(typeof detail === "string" ? detail : `HTTP ${status}`);
  }
}

export function visionRequestError(error: unknown): string {
  if (!(error instanceof APIError)) return "手机无法连接后端或响应异常，请检查后端是否运行、手机网络和 API 地址。";
  const messages: Record<string, string> = {
    use_two_step_image_flow: "请刷新应用，使用识别文字 → 确认文字 → 分析内容流程。",
    request_id_conflict: "请求标识已用于其他内容，请重新操作。",
    invalid_text: "请输入并确认非空文字（最多 12000 字符）。",
    vision_busy: "另一项图片解析正在处理，请等待完成后再操作。",
    vision_cooldown: "请求过于频繁，请等待至少 15 秒后手动重试。",
    stale_vision_draft: "这份草稿对应的 Memory 已被修改，请重新打开详情并重新解析，避免覆盖新内容。",
    "Not Found": "后端未加载视觉解析接口，请重启 FastAPI；若已重启，请检查 API 地址。",
    "Memory not found": "这条 Memory 不存在或无法访问，请返回列表刷新。",
    "No image uploaded": "请先上传图片，再进行解析。",
    "Managed image unavailable": "已上传图片文件不可用，请重新上传图片。",
  };
  if (typeof error.detail === "string" && messages[error.detail]) return messages[error.detail];
  if (error.status === 422) return "请求参数或草稿字段格式不正确，请检查日期、币种和金额；确认后端与手机代码已更新。";
  if (error.status >= 500) return `后端内部错误（HTTP ${error.status}），请查看 FastAPI 终端的异常信息。`;
  return `后端拒绝请求（HTTP ${error.status}），请检查服务版本与配置。`;
}
