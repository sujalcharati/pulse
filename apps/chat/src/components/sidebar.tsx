// Server component — fetches conversation list, renders link list.
// Re-renders on every page navigation thanks to Next's RSC streaming.
import Link from "next/link";
import { ScrollArea } from "@/components/ui/scroll-area";
import { listConversations } from "@/lib/db/queries";
import { cn } from "@/lib/utils";

export async function Sidebar({ activeId }: { activeId?: string }) {
  const items = await listConversations();
  return (
    <aside className="flex h-full w-64 flex-col border-r bg-muted/30">
      <div className="border-b p-4">
        <Link
          href="/"
          className="block rounded-md bg-primary px-3 py-2 text-center text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          + New chat
        </Link>
      </div>
      <ScrollArea className="flex-1">
        <nav className="flex flex-col gap-0.5 p-2">
          {items.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No conversations yet.
            </p>
          )}
          {items.map((c) => (
            <Link
              key={c.id}
              href={`/c/${c.id}`}
              className={cn(
                "truncate rounded-md px-3 py-2 text-sm hover:bg-accent",
                activeId === c.id && "bg-accent",
              )}
              title={c.title ?? "Untitled"}
            >
              {c.title ?? "Untitled"}
            </Link>
          ))}
        </nav>
      </ScrollArea>
    </aside>
  );
}
