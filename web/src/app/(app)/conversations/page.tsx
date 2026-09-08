import { getAuthSession } from "@/lib/session";
import { redirect } from "next/navigation";

export default async function ConversationsPage() {
  const session = await getAuthSession();
  if (!session?.user?.id) redirect("/signin?callbackUrl=/conversations");
  return (
    <div className="flex min-h-dvh items-center justify-center text-zinc-400">
      Inbox coming in Phase 4…
    </div>
  );
}
