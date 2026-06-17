import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TFP CS Agent",
  description: "Customer Service AI agent — review dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="el">
      <body>{children}</body>
    </html>
  );
}
