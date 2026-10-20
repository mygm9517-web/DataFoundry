import { notFound } from "next/navigation";
import { apiOrigin } from "../../../../lib/api-server-client";
import type { BigScreenDto } from "../../../../lib/config-api";
import { PublicBigScreenWall } from "../../public-big-screen-wall";
export const dynamic = "force-dynamic";
export default async function PublicWallPage({params}:{params:Promise<{id:string;screenId:string}>}) {
  const {id,screenId}=await params;
  const response=await fetch(`${apiOrigin()}/api/v1/public/big-screens/${encodeURIComponent(id)}/${encodeURIComponent(screenId)}`,{cache:"no-store"});
  if(!response.ok)notFound();
  const envelope=await response.json();
  if(!envelope.success)notFound();
  return <PublicBigScreenWall screen={envelope.data as BigScreenDto} />;
}
