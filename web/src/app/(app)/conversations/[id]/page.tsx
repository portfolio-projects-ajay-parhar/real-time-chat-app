import { getAuthSession } from "@/lib/session";
import { redirect } from "next/navigation";
import { ChatView } from "@/components/chat/ChatView";

type Params = { params: Promise<{ id: string }> };

export default async function ConversationPage({ params }: Params) {
  const session = await getAuthSession();
  if (!session?.user?.id) redirect("/signin?callbackUrl=/conversations");
  const { id } = await params;

  return <ChatView conversationId={id} viewerId={session.user.id} />;
}