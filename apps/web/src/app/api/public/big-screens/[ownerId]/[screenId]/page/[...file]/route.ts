import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { apiOrigin } from "../../../../../../../../lib/api-server-client";
import { ownerTemplateRoot, bigScreenTemplateRoot, readUploadedTemplates } from "../../../../../../../../lib/bigscreen-templates-server";
import { buildBigScreenBridgeScript } from "../../../../../../../data-tasks/big-screen-runtime";
import { wrapDefaultData, buildBlankDefaultsScript } from "../../../../../../../data-tasks/big-screen-blank-defaults";
import { getBigScreenTemplate } from "../../../../../../../data-tasks/big-screen-templates";
export const dynamic = "force-dynamic";
const types:Record<string,string>={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".svg":"image/svg+xml",".woff":"font/woff",".woff2":"font/woff2",".ttf":"font/ttf",".webp":"image/webp"};
const missing=()=>new Response("Not found",{status:404,headers:{"Cache-Control":"no-store"}});
export async function GET(_request:Request,{params}:{params:Promise<{ownerId:string;screenId:string;file:string[]}>}):Promise<Response> {
  const {ownerId,screenId,file}=await params;
  if(!file?.length || file.some(part=>!part || part==="." || part===".." || part.includes("\\") || part.startsWith(".")))return missing();
  const response=await fetch(`${apiOrigin()}/api/v1/public/big-screens/${encodeURIComponent(ownerId)}/${encodeURIComponent(screenId)}`,{cache:"no-store"});
  if(!response.ok)return missing();
  const envelope=await response.json();
  if(!envelope.success)return missing();
  const meta=envelope.data;
  const contract=meta.template;
  let root:string;
  const relative=file.join("/");
  let binding=contract.binding;
  let dataFile=contract.dataFile;
  if(contract.uploaded) {
    const ownerRoot=ownerTemplateRoot(ownerId);
    const template=readUploadedTemplates(ownerRoot).find(t=>t.id===meta.templateId);
    if(!template?.published || !template.filePaths.has(relative))return missing();
    root=path.join(ownerRoot,template.id);
    binding=template.binding;
    dataFile=template.dataFile;
  } else {
    const builtin=getBigScreenTemplate(meta.templateId);
    if(!builtin)return missing();
    dataFile=builtin.dataFile;
    binding=builtin.binding;
    contract.dataFile=dataFile;
    if(relative!==contract.entry && relative!==contract.dataFile && !relative.startsWith("assets/"))return missing();
    root=relative.startsWith("assets/")?bigScreenTemplateRoot():path.join(bigScreenTemplateRoot(),meta.templateId);
  }
  const ext=path.extname(relative).toLowerCase();
  if(!types[ext])return missing();
  let content:Buffer;
  try {
    const actualRoot=await realpath(root);
    const target=await realpath(path.resolve(root,relative));
    if(!target.startsWith(actualRoot+path.sep))return missing();
    content=await readFile(target);
  }catch{return missing();}
  if(relative===contract.entry) {
    let html=content.toString("utf8");
    const blanked=contract.uploaded?wrapDefaultData(html):null;
    if(blanked)html=blanked;
    const bridge=buildBigScreenBridgeScript(dataFile,undefined,binding,{quiet:blanked!==null});
    const injected=`<script>${blanked?buildBlankDefaultsScript():""}${bridge}</script>`;
    html=/<script\b/iu.test(html)?html.replace(/<script\b/iu,`${injected}\n<script`):html.replace(/<\/head>/iu,`${injected}</head>`);
    html=html.replace(/<base\b[^>]*>/giu,"");
    const entryDir=contract.entry.split("/").slice(0,-1).map(encodeURIComponent).join("/");
    const base=`<base href="/api/public/big-screens/${encodeURIComponent(ownerId)}/${encodeURIComponent(screenId)}/page/${entryDir?entryDir+"/":""}">`;
    html=html.replace(/<head[^>]*>/iu,tag=>tag+base);
    content=Buffer.from(html);
  }
  return new Response(new Uint8Array(content),{headers:{"Content-Type":types[ext]!,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
}
