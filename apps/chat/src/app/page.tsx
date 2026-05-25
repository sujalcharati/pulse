// Root "/" is the new-chat page. No conversation yet, so initialMessages
// is empty and ChatShell will POST without conversationId, which makes
// the API create one and redirect us to /c/[id].
import { Sidebar } from "@/components/sidebar";
import { ChatShell } from "@/components/chat-shell";

export default function Page() {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1">
        <ChatShell initialMessages={[]} />
      </main>
    </div>
  );
}
