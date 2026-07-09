import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Praxis Inbox",
  description: "Pending input requests from the Praxis crew",
};

export default function InboxLayout({ children }: { children: React.ReactNode }) {
  return children;
}
