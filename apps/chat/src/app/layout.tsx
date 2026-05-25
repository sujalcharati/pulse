import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pulse Chat",
  description: "LLM chat with built-in observability via Pulse",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
