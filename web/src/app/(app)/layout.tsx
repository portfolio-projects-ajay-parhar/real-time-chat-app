import { redirect } from "next/navigation";
import { getAuthSession } from "@/lib/session";
import { SocketProvider } from "@/hooks/useSocket";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getAuthSession();
  if (!session?.user?.id) {
    redirect("/signin?callbackUrl=/conversations");
  }
  return (
    <SocketProvider viewerId={session.user.id}>
      <div className="min-h-dvh">{children}</div>
    </SocketProvider>
  );
}
