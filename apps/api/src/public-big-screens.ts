import type { MetadataStore, ConfigResourceRecord } from "@datafoundry/metadata";
import type { LocalDataGateway } from "@datafoundry/data-gateway";
import { BIG_SCREEN_BUILTIN_TEMPLATE_IDS } from "@datafoundry/bigscreen";
import { buildBigScreenData, normalizeBigScreenDefinition } from "./big-screen.js";

const validPart = (s: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/u.test(s);

/** Owner comes only from the published URL, never from the visitor's session. */
export const findPublishedScreen = (store: MetadataStore, ownerId: string, screenId: string): {
  screen: ConfigResourceRecord; template?: ConfigResourceRecord;
} | undefined => {
  if (!validPart(ownerId) || !validPart(screenId)) return undefined;
  const rows = store.db.prepare("SELECT workspace_id FROM config_resources WHERE user_id=? AND id=? AND kind='big-screen'")
    .all(ownerId, screenId);
  // Ambiguous workspaces must not silently choose a different publication.
  if (rows.length !== 1) return undefined;
  const workspaceId = String(rows[0]?.workspace_id);
  const screen = store.configResources.find({workspace_id:workspaceId,user_id:ownerId,kind:"big-screen",id:screenId});
  if (!screen || !screen.default_enabled || screen.status === "disabled") return undefined;
  const definition = normalizeBigScreenDefinition(screen.payload);
  const template = store.configResources.find({workspace_id:workspaceId,user_id:ownerId,kind:"big-screen-template",id:definition.templateId});
  if (template ? template.payload.published !== true : !(BIG_SCREEN_BUILTIN_TEMPLATE_IDS as readonly string[]).includes(definition.templateId)) {
    return undefined;
  }
  return { screen, ...(template ? {template} : {}) };
};

export const publicScreenDto = (screen: ConfigResourceRecord, template?: ConfigResourceRecord): Record<string, unknown> => {
  const definition=normalizeBigScreenDefinition(screen.payload);
  const ownerId=screen.user_id;
  const path=`/api/v1/public/big-screens/${encodeURIComponent(ownerId)}/${encodeURIComponent(screen.id)}`;
  const entry=typeof template?.payload.entry === "string" ? template.payload.entry : "index.html";
  return {
    id:screen.id,ownerId,name:screen.name,title:definition.title || screen.name,templateId:definition.templateId,
    refreshMs:definition.refreshMs,revision:screen.revision,createdAt:screen.created_at,updatedAt:screen.updated_at,
    // A public visitor receives presentation metadata and query results only.
    datasets:[], publicDataUrl:`${path}/data`,
    publicPageUrl:`/api/public/big-screens/${encodeURIComponent(ownerId)}/${encodeURIComponent(screen.id)}/page/${entry.split("/").map(encodeURIComponent).join("/")}`,
    template:{entry,uploaded:Boolean(template),dataFile:template?.payload.dataFile ?? "",binding:template?.payload.binding},
    publicUrl:`/wall/${encodeURIComponent(ownerId)}/${encodeURIComponent(screen.id)}`
  };
};

export const handlePublicBigScreenRequest = async (
  pathname: string, method: string | undefined, store: MetadataStore, gateway: LocalDataGateway
): Promise<{status:number;body:unknown} | undefined> => {
  if (!pathname.startsWith("/api/v1/public/big-screens/")) return undefined;
  const missing={status:404,body:{success:false,error:{code:"NOT_FOUND",message:"Published screen not found."}}};
  if (method !== "GET") return {...missing,status:405};
  let parts: string[];
  try { parts=pathname.slice("/api/v1/public/big-screens/".length).split("/").map(decodeURIComponent); }
  catch { return missing; }
  if(parts[0]==="resolve" && parts.length===2) {
    const id=parts[1] ?? "";
    if(!validPart(id))return missing;
    const rows=store.db.prepare("SELECT user_id FROM config_resources WHERE kind='big-screen' AND id=?").all(id);
    const owners=rows.map(r=>String(r.user_id)).filter(owner=>findPublishedScreen(store,owner,id));
    return owners.length===1 ? {status:200,body:{success:true,data:{publicUrl:`/wall/${owners[0]}/${encodeURIComponent(id)}`}}}:missing;
  }
  if(parts.length!==2 && !(parts.length===3 && parts[2]==="data"))return missing;
  const target=findPublishedScreen(store,parts[0]??"",parts[1]??"");
  if(!target)return missing;
  const {screen,template}=target;
  if(parts[2]==="data") {
    const data=await buildBigScreenData(gateway,screen.id,screen.payload,{userId:screen.user_id,workspaceId:screen.workspace_id});
    // Dataset errors may contain connection details; those belong in the owner's console.
    const datasets=data.datasets.map(d=>d.error?{...d,error:"Dataset query failed."}:d);
    return {status:200,body:{success:true,data:{...data,datasets}}};
  }
  return {status:200,body:{success:true,data:publicScreenDto(screen,template)}};
};
