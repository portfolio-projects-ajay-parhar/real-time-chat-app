import { redirect } from "next/navigation";
import { getAuthSession } from "@/lib/session";

export default async function Home() {
  const session = await getAuthSession();
  redirect(session ? "/conversations" : "/signin");
}
