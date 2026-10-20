import { notFound, redirect } from "next/navigation";
import { apiOrigin } from "../../../lib/api-server-client";
export const dynamic = "force-dynamic";
/** Old links redirect only when exactly one published owner exists. */
export default async function LegacyWallPage({params}:{params:Promise<{id:string}>}) {
  const {id}=await params;
  const response=await fetch(`${apiOrigin()}/api/v1/public/big-screens/resolve/${encodeURIComponent(id)}`,{cache:"no-store"});
  if(!response.ok)notFound();
  const envelope=await response.json();
  if(!envelope.success || !envelope.data?.publicUrl)notFound();
  redirect(envelope.data.publicUrl);
}
