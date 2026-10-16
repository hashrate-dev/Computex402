import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ComputePass 402",
  description: "Capacidad de inferencia redimible, liquidada con x402.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body className="antialiased">{children}</body>
    </html>
  );
}
