import { backendRequest, convertExecution, errorResponse } from "@/lib/backend-bridge";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!id || id.length > 160) {
      return Response.json({ error: "Invalid execution ID." }, { status: 400 });
    }
    const raw = await backendRequest(`/api/executions/${encodeURIComponent(id)}`);
    return Response.json(convertExecution(raw));
  } catch (error) {
    return errorResponse(error);
  }
}
