import type { Metadata } from "next";
import Link from "next/link";
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
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            TFP <span>· Customer Service Agent</span>
          </Link>
          <nav className="topnav">
            <Link href="/">Ουρά ελέγχου</Link>
            <a href="/api/health">Health</a>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
