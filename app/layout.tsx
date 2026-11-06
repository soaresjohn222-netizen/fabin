import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fabinho Motors · Ordens e histórico",
  description: "Clientes, motos e ordens de serviço em um só lugar.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
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
    <html lang="pt-BR">
      <body className="antialiased">{children}</body>
    </html>
  );
}
