import { attachActorCookie } from "@/lib/server/actor";
import { getRuntimeRequestActor as getRequestActor } from "@/lib/server/runtime-actor";
import { ApiError, errorResponse, jsonResponse, readJsonBody } from "@/lib/server/api";
import { assertSameOriginMutation } from "@/lib/server/runtime-policy";
import { deleteTemplate, getTemplate, parseTemplateInput, saveTemplate } from "@/lib/server/templates";
type Ctx = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Ctx) { const actor=await getRequestActor(request); try { assertSameOriginMutation(request); const {id}=await context.params; if (!(await getTemplate(id,actor.ownerId))) throw new ApiError(404,"TEMPLATE_NOT_FOUND","模板不存在。"); const input=parseTemplateInput(await readJsonBody(request)); const row=await saveTemplate(actor.ownerId,{...input,id}); return attachActorCookie(jsonResponse({template:{id:row.id,workflowType:row.workflowType,name:row.name,config:row.config,createdAt:row.createdAt,updatedAt:row.updatedAt}}),actor); } catch(error) { return attachActorCookie(errorResponse(error,crypto.randomUUID()),actor); } }
export async function DELETE(request: Request, context: Ctx) { const actor=await getRequestActor(request); try { assertSameOriginMutation(request); const {id}=await context.params; if (!(await deleteTemplate(id,actor.ownerId))) throw new ApiError(404,"TEMPLATE_NOT_FOUND","模板不存在。"); return attachActorCookie(jsonResponse({deleted:true}),actor); } catch(error) { return attachActorCookie(errorResponse(error,crypto.randomUUID()),actor); } }
