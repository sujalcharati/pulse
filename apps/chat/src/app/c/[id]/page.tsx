// Conversation page — server-renders the existing message list, then
// hydrates ChatShell which takes over for streaming subsequent turns.
import { notFound } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { ChatShell } from "@/components/chat-shell";
import { getConversation, loadMessages } from "@/lib/db/queries";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function Page({ params }: Props) {
  const { id } = await params;
  const conv = await getConversation(id);
  if (!conv) notFound();
  const messages = await loadMessages(id);

  return (
    <div className="flex h-screen">
      <Sidebar activeId={id} />
      <main className="flex-1">
        <ChatShell conversationId={id} initialMessages={messages} />
      </main>
    </div>
  );
}
