import { redirect } from "next/navigation";
import { getAuthSession } from "@/lib/session";
import { SocketProvider } from "@/hooks/useSocket";
import { SidebarList } from "@/components/chat/SidebarList";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getAuthSession();
  if (!session?.user?.id) {
    redirect("/signin?callbackUrl=/conversations");
  }
  const viewerId = session.user.id;

  return (
    <SocketProvider viewerId={viewerId}>
      {/* Desktop split view: 320px conversation list | chat (phase 8.4).
          Mobile: the list is hidden and /conversations renders full-screen. */}
      <div className="flex h-dvh bg-zinc-950">
        <aside className="hidden w-80 shrink-0 flex-col border-r border-zinc-800 md:flex">
          <SidebarList viewerId={viewerId} />
        </aside>
        <main className="h-dvh min-w-0 flex-1">{children}</main>
      </div>
    </SocketProvider>
  );
}
