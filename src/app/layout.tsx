import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "TFP CS Agent",
  description: "Customer Service AI agent — review dashboard",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const email = session?.user?.email ?? null;

  return (
    <html lang="el">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            TFP <span>· Customer Service Agent</span>
          </Link>
          <nav className="topnav">
            <Link href="/">Ουρά ελέγχου</Link>
            {email ? (
              <>
                <span className="muted">{email}</span>
                <a href="/api/auth/signout">Αποσύνδεση</a>
              </>
            ) : (
              <a href="/api/auth/signin">Σύνδεση</a>
            )}
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
