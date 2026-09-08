import { redirect } from "next/navigation";
import { getAuthSession } from "@/lib/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getAuthSession();
  if (!session?.user?.id) {
    redirect("/signin?callbackUrl=/conversations");
  }
  return <div className="min-h-dvh">{children}</div>;
}
