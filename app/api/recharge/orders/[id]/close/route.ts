import { errorResponse,jsonResponse } from "@/lib/server/api";
import { rechargeActor,queryNativePayment,publicNativeOrder } from "@/lib/server/recharge-runtime";
import { readNativeOrder,NATIVE_CATALOG_VERSION } from "@/lib/server/recharge-native-orders";
export async function POST(request:Request,context:{params:Promise<{id:string}>}):Promise<Response>{try{
 const {actor,d1}=await rechargeActor(request,true);const {id}=await context.params;let order=await readNativeOrder(d1,id,actor.ownerId);
 if(order.catalogVersion===NATIVE_CATALOG_VERSION&&order.status==="PENDING"&&!order.reconciliation){
  try {order=await queryNativePayment(d1,order,true);}catch {return jsonResponse({order:publicNativeOrder(await readNativeOrder(d1,id,actor.ownerId)),queryPending:true});}
 }
 return jsonResponse({order:publicNativeOrder(order)});
}catch(error){return errorResponse(error,crypto.randomUUID());}}
