export class APIError extends Error {
  constructor(public status: number, public detail: unknown) {
    super(typeof detail === "string" ? detail : `HTTP ${status}`);
  }
}

export function visionRequestError(error: unknown): string {
  if (!(error instanceof APIError)) return "The phone could not reach the backend. Check the server, network, and API address.";
  const messages: Record<string, string> = {
    use_two_step_image_flow: "Refresh the app and use the recognize, confirm, then analyse flow.",
    request_id_conflict: "This request identifier was already used for other content. Try again.",
    invalid_text: "Enter and confirm text between 1 and 12,000 characters.",
    vision_busy: "Another image analysis is running. Wait for it to finish.",
    vision_cooldown: "Requests are too frequent. Wait at least 15 seconds and try again.",
    stale_vision_draft: "This Memory changed after the draft was created. Reopen it and analyse it again.",
    "Not Found": "The backend image-analysis route is unavailable. Restart FastAPI and check the API address.",
    "Memory not found": "This Memory is unavailable. Return to the list and refresh.",
    "No image uploaded": "Add an image before starting analysis.",
    "Managed image unavailable": "The attached image is unavailable. Add it again.",
  };
  if (typeof error.detail === "string" && messages[error.detail]) return messages[error.detail];
  if (error.status === 422) return "The request or draft format is invalid. Check dates, currency, and amounts, and confirm both app components are current.";
  if (error.status >= 500) return `Backend error (HTTP ${error.status}). Check the FastAPI terminal for details.`;
  return `The backend rejected the request (HTTP ${error.status}). Check its version and configuration.`;
}
