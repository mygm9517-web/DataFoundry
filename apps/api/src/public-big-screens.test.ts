import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMetadataStore, createVerifiedTestIdentity, type MetadataStore } from "@datafoundry/metadata";
import type { LocalDataGateway } from "@datafoundry/data-gateway";
import { findPublishedScreen, handlePublicBigScreenRequest, publicScreenDto } from "./public-big-screens.js";

describe("public screen ownership and publication", () => {
  let store: MetadataStore;
  let root: string;
  let owner: ReturnType<typeof createVerifiedTestIdentity>;
  let other: ReturnType<typeof createVerifiedTestIdentity>;
  const seed = (identity: typeof owner, published = true) => {
    const scope={workspace_id:identity.workspaceId,user_id:identity.userId};
    store.configResources.upsert({...scope,kind:"big-screen-template",id:"index",name:"index",payload:{published,entry:"index.html"}});
    return store.configResources.upsert({...scope,kind:"big-screen",id:"index",name:"index",payload:{definition:{templateId:"index",datasourceId:"private-source",datasets:[{id:"kpi",sql:"select secret from business",rules:[{column:"value",target:"kpi"}]}]}}});
  };
  beforeEach(() => {
    root=mkdtempSync(join(tmpdir(), "public-big-screen-"));
    store=createMetadataStore({database_path:join(root,"metadata.sqlite")});
    owner=createVerifiedTestIdentity(store,{email:"owner@example.com"});
    other=createVerifiedTestIdentity(store,{email:"other@example.com"});
  });
  afterEach(() => { store.close(); rmSync(root,{recursive:true,force:true}); });
  it("keeps two owners' index screens separate and refuses ambiguous old links",async()=>{
    seed(owner);seed(other);
    expect(findPublishedScreen(store,owner.userId,"index")?.screen.user_id).toBe(owner.userId);
    expect(findPublishedScreen(store,other.userId,"index")?.screen.user_id).toBe(other.userId);
    const result=await handlePublicBigScreenRequest("/api/v1/public/big-screens/resolve/index","GET",store,{} as LocalDataGateway);
    expect(result?.status).toBe(404);
  });
  it("hides unpublished, disabled, invalid and nonexistent publications",()=>{
    seed(owner,false);
    expect(findPublishedScreen(store,owner.userId,"index")).toBeUndefined();
    seed(owner);
    store.configResources.upsert({workspace_id:owner.workspaceId,user_id:owner.userId,kind:"big-screen",id:"index",name:"index",default_enabled:false,payload:{templateId:"index"}});
    expect(findPublishedScreen(store,owner.userId,"index")).toBeUndefined();
    expect(findPublishedScreen(store,other.userId,"index")).toBeUndefined();
    expect(findPublishedScreen(store,"../users","index")).toBeUndefined();
  });
  it("exposes only presentation metadata",()=>{
    const screen=seed(owner);
    const dto=publicScreenDto(screen);
    expect(dto.publicUrl).toBe(`/wall/${owner.userId}/index`);
    expect(dto.datasets).toEqual([]);
    expect(JSON.stringify(dto)).not.toMatch(/select secret|private-source/);
  });
  it("runs without a visitor session using only the publisher's query identity",async()=>{
    seed(owner);seed(other);
    const query=vi.fn(async(input:{user_id:string})=>({columns:["value"],rows:[[input.user_id]],row_count:1}));
    const gateway={runSqlReadonly:query} as unknown as LocalDataGateway;
    for(const identity of [owner,other]) {
      const result=await handlePublicBigScreenRequest(`/api/v1/public/big-screens/${identity.userId}/index/data`,"GET",store,gateway);
      expect(result?.status).toBe(200);
      expect(query).toHaveBeenLastCalledWith(expect.objectContaining({user_id:identity.userId,workspace_id:identity.workspaceId}));
    }
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("sanitizes query failures and rejects mutations",async()=>{
    seed(owner);
    const gateway={runSqlReadonly:async()=>{throw new Error("password=private");}} as unknown as LocalDataGateway;
    const url=`/api/v1/public/big-screens/${owner.userId}/index/data`;
    expect(JSON.stringify((await handlePublicBigScreenRequest(url,"GET",store,gateway))?.body)).not.toContain("password=");
    expect((await handlePublicBigScreenRequest(url,"POST",store,gateway))?.status).toBe(405);
  });
});
