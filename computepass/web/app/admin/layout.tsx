import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Panel del agente · ComputePass 402",
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}
